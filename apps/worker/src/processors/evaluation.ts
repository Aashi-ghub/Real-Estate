import type { Job } from "bullmq";
import type { Logger } from "pino";

import { db as defaultDb, toPrismaJson, type PrismaClient } from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { EvaluationRunJobData, JobTrace } from "@real-estate/types";
import {
  createSyntheticSemanticCorpus,
  incrementDriftAnomaly,
  observeEvaluationScore,
  runEvaluationExamples,
  scoreHallucination,
  stableHash,
  validateBenchmarkIntegrity,
  validateAiRecommendationSafety
} from "@real-estate/utils";

import { markJobComplete, markJobFailure, markJobProcessing } from "../services/runtime-helpers";

export async function processEvaluationRun(
  job: Job<EvaluationRunJobData>,
  deps: {
    db?: PrismaClient;
    logger: Logger;
    config: WorkerConfig;
    trace: JobTrace;
  }
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const attempts = job.attemptsMade + 1;

  await markJobProcessing(db, {
    clientId: job.data.clientId,
    queue: "evaluation",
    name: "evaluation_run",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts,
    metadata: { workerName: "evaluation-worker", isolatedQueue: true },
    trace: deps.trace
  });

  try {
    const run = await db.evaluationRun.update({
      where: { id: job.data.runId },
      data: {
        status: "running",
        startedAt: new Date(),
        concurrencyLimit: Math.min(job.data.concurrencyLimit, deps.config.evaluationMaxConcurrency)
      },
      include: {
        dataset: true
      }
    });
    const examples = Array.isArray(run.dataset?.examples)
      ? run.dataset.examples
      : createSyntheticSemanticCorpus();
    const datasetChecksum = run.dataset?.checksum ?? stableHash(examples);
    const integrity = validateBenchmarkIntegrity({ expectedChecksum: datasetChecksum, examples });
    if (!integrity.valid) {
      await db.chaosExecutionLog.create({
        data: {
          clientId: job.data.clientId,
          scenarioType: "benchmark_corruption",
          status: "quarantined",
          inputChecksum: integrity.actualChecksum,
          recoveryAction: "evaluation_blocked",
          operationalImpact: toPrismaJson({ operationalQueuesImpacted: false }),
          fallbackActivated: false,
          quarantineReason: integrity.reason,
          startedAt: new Date(),
          completedAt: new Date()
        }
      });
      throw new Error("Evaluation dataset checksum mismatch");
    }
    const output = runEvaluationExamples({
      clientId: job.data.clientId,
      runType: job.data.runType,
      modelVersion: job.data.modelVersion,
      promptVersion: job.data.promptVersion,
      datasetChecksum,
      examples: examples as ReturnType<typeof createSyntheticSemanticCorpus>
    });
    const baseline = job.data.baselineRunId
      ? await db.evaluationRun.findFirst({
          where: {
            id: job.data.baselineRunId,
            clientId: job.data.clientId
          }
        })
      : null;
    const currentF1 = output.aggregateMetrics.f1;
    const baselineMetrics = baseline?.aggregateMetrics as { f1?: number } | null;
    const baselineF1 = typeof baselineMetrics?.f1 === "number" ? baselineMetrics.f1 : currentF1;
    const delta = currentF1 - baselineF1;
    const regression = delta < -0.03;

    await db.$transaction(async (tx) => {
      await tx.evaluationRun.update({
        where: { id: job.data.runId },
        data: {
          status: "completed",
          inputChecksum: output.inputChecksum,
          resultChecksum: output.resultChecksum,
          aggregateMetrics: toPrismaJson(output.aggregateMetrics),
          regressionSummary: toPrismaJson({
            baselineRunId: job.data.baselineRunId,
            baselineF1,
            currentF1,
            delta,
            regression
          }),
          completedAt: new Date()
        }
      });

      await tx.evaluationResult.createMany({
        data: output.results.map((result) => ({
          clientId: job.data.clientId,
          runId: job.data.runId,
          datasetExampleId: result.exampleId,
          taskType: result.taskType,
          expected: toPrismaJson(result.expected),
          actual: toPrismaJson(result.actual),
          scores: toPrismaJson(result.scores),
          confidence: result.confidence,
          passed: result.passed,
          latencyMs: result.latencyMs,
          explanation: toPrismaJson(result.explanation)
        })),
        skipDuplicates: true
      });

      await tx.evaluationReproducibilityManifest.create({
        data: {
          clientId: job.data.clientId,
          runId: job.data.runId,
          manifestVersion: output.manifest.manifestVersion,
          inputChecksum: output.manifest.inputChecksum,
          semanticChecksum: output.manifest.semanticResultChecksum,
          datasetChecksum: output.manifest.datasetChecksum,
          deterministic: true,
          excludedFields: output.manifest.excludedFromChecksum,
          replayOfRunId: job.data.baselineRunId ?? null,
          replayMatches: baseline ? output.resultChecksum === baseline.resultChecksum : null,
          metadata: toPrismaJson(output.manifest)
        }
      });

      if (job.data.runType === "behavioral_accuracy" || job.data.runType === "emotional_inference") {
        await tx.behavioralEvaluationMetric.create({
          data: {
            clientId: job.data.clientId,
            runId: job.data.runId,
            windowStart: new Date(0),
            windowEnd: new Date(0),
            stabilityScore: output.aggregateMetrics.behavioralStability,
            hesitationConsistency: output.aggregateMetrics.confidenceCalibration,
            urgencyEscalation: output.aggregateMetrics.recall,
            trustRecoveryScore: output.aggregateMetrics.precision,
            ghostingRiskStability: output.aggregateMetrics.behavioralStability,
            confidenceDrift: 1 - output.aggregateMetrics.confidenceCalibration,
            details: toPrismaJson(output.aggregateMetrics)
          }
        });
      }

      for (const result of output.results) {
        if (job.data.runType === "hallucination_safety" || result.taskType === "hallucination_safety") {
          const text = JSON.stringify(result.actual);
          const hallucination = scoreHallucination(text, (examples as Array<{ id: string; evidence?: string[] }>).find((entry) => entry.id === result.exampleId)?.evidence ?? []);
          await tx.hallucinationScore.create({
            data: {
              clientId: job.data.clientId,
              runId: job.data.runId,
              outputHash: hallucination.outputHash,
              factualityScore: hallucination.factualityScore,
              hallucinationRate: hallucination.hallucinationRate,
              unsupportedClaims: toPrismaJson(hallucination.unsupportedClaims),
              evidenceCoverage: hallucination.evidenceCoverage
            }
          });
          const safety = validateAiRecommendationSafety(text);
          await tx.safetyBenchmark.create({
            data: {
              clientId: job.data.clientId,
              suiteName: "phase5-adversarial-safety",
              promptHash: stableHash(result.expected),
              attackType: safety.reasons.join(",").slice(0, 80) || "adversarial_recommendation",
              blocked: safety.blocked,
              falseBlock: false,
              safetyScore: safety.score,
              severity: safety.score >= 0.7 ? "critical" : safety.score > 0 ? "warn" : "info",
              reasons: toPrismaJson(safety.reasons),
              moderationVersion: "rules-v2"
            }
          });
        }
      }

      if (regression) {
        await tx.intelligenceRegression.create({
          data: {
            clientId: job.data.clientId,
            runId: job.data.runId,
            metricName: "f1",
            baselineValue: baselineF1,
            currentValue: currentF1,
            delta,
            threshold: -0.03,
            severity: delta < -0.1 ? "critical" : "warn",
            details: toPrismaJson({ runType: job.data.runType, modelVersion: job.data.modelVersion })
          }
        });
        incrementDriftAnomaly(job.data.clientId, "evaluation_regression");
      }
    });

    observeEvaluationScore(job.data.clientId, job.data.runType, { ...output.aggregateMetrics });
    await markJobComplete(db, {
      clientId: job.data.clientId,
      queue: "evaluation",
      name: "evaluation_run",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts,
      metadata: { workerName: "evaluation-worker", resultChecksum: output.resultChecksum },
      trace: deps.trace
    });
  } catch (error) {
    await db.evaluationRun.update({
      where: { id: job.data.runId },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "unknown",
        completedAt: new Date()
      }
    }).catch((updateError) => deps.logger.error({ err: updateError, runId: job.data.runId }, "evaluation.run.failure_update_failed"));
    await markJobFailure(
      db,
      deps.logger,
      {
        clientId: job.data.clientId,
        queue: "evaluation",
        name: "evaluation_run",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts,
        metadata: { workerName: "evaluation-worker" },
        trace: deps.trace
      },
      error as Error
    );
    throw error;
  }
}
