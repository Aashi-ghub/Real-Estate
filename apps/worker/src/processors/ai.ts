import { createHash } from "node:crypto";

import { Job, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";

import { db as defaultDb, toPrismaJson, upsertJobMirror, type PrismaClient } from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { AiLeadIntelligenceJobData, JobTrace } from "@real-estate/types";
import { computeRetryMetadata, normalizeMixedLanguage, parseIndianBudget, parsePurchaseTimeline, sanitizeJsonValue, validateAiRecommendationSafety } from "@real-estate/utils";

import { AiRuntime, aiReasoningMetadata } from "../services/ai-runtime";
import { markJobComplete, markJobFailure, markJobProcessing } from "../services/runtime-helpers";

function checksum(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function processAiLeadIntelligence(
  job: Job<AiLeadIntelligenceJobData>,
  deps: {
    db?: PrismaClient;
    logger: Logger;
    config: WorkerConfig;
    trace: JobTrace;
  }
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const attempts = job.attemptsMade + 1;
  const retryMetadata = computeRetryMetadata({
    attemptsMade: attempts,
    maxAttempts: job.opts.attempts ?? 1,
    baseDelayMs: deps.config.queueRetryBackoffMs,
    maxDelayMs: deps.config.queueRetryBackoffMaxMs
  });

  await markJobProcessing(db, {
    clientId: job.data.clientId,
    leadId: job.data.leadId,
    queue: "ai",
    name: "lead_intelligence",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts,
    metadata: { retry: retryMetadata, workerName: "ai-worker" },
    trace: deps.trace
  });
  let executionId: string | null = null;

  try {
    const lead = await db.lead.findFirst({
      where: {
        id: job.data.leadId,
        clientId: job.data.clientId
      } as never
    });
    if (!lead) {
      throw new UnrecoverableError("Lead not found for AI intelligence job");
    }

    const runtime = new AiRuntime(deps.config, deps.logger);
    const promptVersion = await db.promptVersion.upsert({
      where: {
        taskType_version: {
          taskType: "semantic_understanding",
          version: "phase4-v1"
        }
      },
      create: {
        taskType: "semantic_understanding",
        version: "phase4-v1",
        provider: deps.config.aiProvider,
        model: deps.config.aiProvider === "openai" ? deps.config.aiModel : "rules-v1",
        systemPrompt: "Real-estate lead intelligence enrichment. Deterministic-first, explainable, schema-bound.",
        outputSchema: toPrismaJson({ name: "aiLeadIntelligenceSchema", version: "1" }),
        checksum: checksum("phase4-v1:lead-intelligence"),
        metadata: toPrismaJson({ tasks: job.data.tasks })
      },
      update: {
        isActive: true
      }
    });

    const startedAt = new Date();
    const inputHash = runtime.buildInputHash(job.data);
    const execution = await db.aiExecution.create({
      data: {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        conversationId: job.data.conversationId,
        taskType: "semantic_understanding",
        provider: deps.config.aiProvider,
        model: deps.config.aiProvider === "openai" ? deps.config.aiModel : "rules-v1",
        promptVersionId: promptVersion.id,
        status: "running",
        inputHash,
        requestId: deps.trace.requestId,
        correlationId: deps.trace.correlationId,
        startedAt
      }
    });
    executionId = execution.id;

    const result = await runtime.executeLeadIntelligence(job.data);
    const confidence = result.output.confidence;
    const belowThreshold = confidence < deps.config.aiConfidenceThreshold;
    const safeOutput = sanitizeJsonValue(result.output);
    const reasoning = aiReasoningMetadata(result.output, result.fallbackUsed || belowThreshold);
    const completedAt = new Date();
    const languageNormalization = normalizeMixedLanguage(job.data.rawUtterance);
    const budgetNormalization = parseIndianBudget(job.data.rawUtterance);
    const timelineNormalization = parsePurchaseTimeline(job.data.rawUtterance);
    const taskAllocationRatio = job.data.tasks.length === 0 ? 1 : 1 / job.data.tasks.length;
    const recommendationSafety = result.output.recommendations.map((recommendation) => ({
      recommendation,
      safety: validateAiRecommendationSafety(recommendation.suggestion)
    }));

    await db.$transaction(async (tx) => {
      await tx.aiExecution.update({
        where: { id: execution.id },
        data: {
          provider: result.provider,
          model: result.model,
          status: belowThreshold ? "fallback" : "completed",
          confidence,
          output: toPrismaJson(safeOutput),
          reasoning: toPrismaJson(reasoning),
          provenance: toPrismaJson(result.output.provenance),
          safety: toPrismaJson({ belowThreshold, threshold: deps.config.aiConfidenceThreshold }),
          tokenUsage: toPrismaJson(result.tokenUsage),
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          completedAt
        }
      });

      await tx.aiCostMetric.createMany({
        data: [{
          clientId: job.data.clientId,
          taskType: "semantic_understanding",
          provider: result.provider,
          model: result.model,
          inputTokens: result.tokenUsage.inputTokens,
          outputTokens: result.tokenUsage.outputTokens,
          totalTokens: result.tokenUsage.totalTokens,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          success: !belowThreshold
        }]
      });

      await tx.aiCostAllocation.createMany({
        data: job.data.tasks.map((taskType) => ({
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          executionId: execution.id,
          taskType,
          provider: result.provider,
          model: result.model,
          allocatedInputTokens: Math.round(result.tokenUsage.inputTokens * taskAllocationRatio),
          allocatedOutputTokens: Math.round(result.tokenUsage.outputTokens * taskAllocationRatio),
          allocatedCostUsd: Number((result.costUsd * taskAllocationRatio).toFixed(6)),
          allocationRatio: taskAllocationRatio,
          retryAttempt: attempts
        }))
      });

      for (const [signalType, value] of Object.entries(result.output.emotional.state)) {
        await tx.behavioralSignal.create({
          data: {
            clientId: job.data.clientId,
            leadId: job.data.leadId,
            signalType,
            value: toPrismaJson({ score: value }),
            confidence: value,
            explanation: toPrismaJson({ source: "emotional_state", executionId: execution.id }),
            source: result.provider,
            observedAt: completedAt
          }
        });
      }

      await tx.emotionalProfile.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          state: toPrismaJson(result.output.emotional.state),
          confidence,
          trend: toPrismaJson(result.output.emotional.trend),
          frictionIndicators: toPrismaJson(result.output.emotional.frictionIndicators),
          salesResistanceMarkers: toPrismaJson(result.output.emotional.salesResistanceMarkers),
          explanation: toPrismaJson(reasoning),
          source: result.provider
        }
      });

      await tx.emotionalTimeline.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          executionId: execution.id,
          state: toPrismaJson(result.output.emotional.state),
          drift: toPrismaJson({
            direction: result.output.emotional.trend.direction,
            confidence: result.output.emotional.trend.confidence,
            volatility: Math.max(...Object.values(result.output.emotional.state), 0) - Math.min(...Object.values(result.output.emotional.state), 1)
          }),
          stabilityScore: Math.max(0, 1 - Math.max(...Object.values(result.output.emotional.state), 0)),
          confidence,
          observedAt: completedAt
        }
      });

      await tx.intentPrediction.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          modelVersion: `${result.provider}:${result.model}`,
          predictions: toPrismaJson(result.output.intent),
          confidence: result.output.intent.confidence,
          explanation: toPrismaJson(reasoning),
          featureContributions: toPrismaJson(result.output.intent.factors),
          fallbackUsed: result.fallbackUsed || belowThreshold
        }
      });

      await tx.predictionDrift.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          modelVersion: `${result.provider}:${result.model}`,
          currentVector: toPrismaJson(result.output.intent),
          driftScore: 0,
          threshold: 0.2,
          explanation: toPrismaJson({ deterministicStable: true, executionId: execution.id })
        }
      });

      await tx.semanticNormalization.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          rawText: job.data.rawUtterance,
          normalized: toPrismaJson({
            fields: result.output.semantic.fields,
            budget: budgetNormalization,
            timeline: timelineNormalization
          }),
          confidence,
          conflicts: toPrismaJson([]),
          provenance: toPrismaJson(result.output.provenance)
        }
      });

      await tx.multilingualNormalization.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          rawText: job.data.rawUtterance,
          detectedLanguage: languageNormalization.detected,
          normalizedText: languageNormalization.normalizedText,
          confidence: languageNormalization.confidence,
          mappings: toPrismaJson(languageNormalization.notes)
        }
      });

      for (const memory of result.output.memory) {
        await tx.conversationalMemory.create({
          data: {
            clientId: job.data.clientId,
            leadId: job.data.leadId,
            memoryType: memory.type.slice(0, 80),
            content: toPrismaJson(memory.content),
            rawUtterance: job.data.rawUtterance,
            relevanceScore: memory.relevanceScore,
            confidence: memory.confidence,
            tags: memory.tags,
            source: result.provider
          }
        });
      }

      await tx.engagementPrediction.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          bestFollowupAt: new Date(Date.now() + result.output.engagement.bestFollowupDelayMinutes * 60_000),
          bestChannel: result.output.engagement.bestChannel,
          escalationRiskScore: result.output.engagement.escalationRiskScore,
          inactivityRisk: result.output.engagement.inactivityRisk,
          churnRisk: result.output.engagement.churnRisk,
          timingConfidence: result.output.engagement.timingConfidence,
          strategy: toPrismaJson(result.output.engagement.strategy),
          explanation: toPrismaJson(reasoning),
          thresholds: toPrismaJson({ tenantConfigurable: true })
        }
      });

      for (const [summaryType, content] of Object.entries(result.output.summaries)) {
        if (summaryType === "confidence") {
          continue;
        }
        await tx.aiSummary.create({
          data: {
            clientId: job.data.clientId,
            leadId: job.data.leadId,
            conversationId: job.data.conversationId,
            summaryType,
            version: "phase4-v1",
            content: String(content),
            confidence: result.output.summaries.confidence,
            metadata: toPrismaJson({ executionId: execution.id }),
            promptVersionId: promptVersion.id,
            model: result.model
          }
        });
      }

      for (const blocked of recommendationSafety.filter((entry) => entry.recommendation.safety.blocked || entry.safety.blocked)) {
        await tx.aiSafetyViolation.create({
          data: {
            clientId: job.data.clientId,
            leadId: job.data.leadId,
            executionId: execution.id,
            violationType: "unsafe_recommendation",
            severity: blocked.safety.score >= 0.7 ? "high" : "medium",
            blockedText: blocked.recommendation.suggestion,
            score: Math.max(blocked.safety.score, blocked.recommendation.safety.blocked ? 0.7 : 0),
            reasons: toPrismaJson([
              ...(blocked.recommendation.safety.reason ? [blocked.recommendation.safety.reason] : []),
              ...blocked.safety.reasons
            ]),
            quarantined: true
          }
        });
      }

      for (const { recommendation } of recommendationSafety.filter((entry) => !entry.recommendation.safety.blocked && !entry.safety.blocked)) {
        await tx.aiRecommendation.create({
          data: {
            clientId: job.data.clientId,
            leadId: job.data.leadId,
            recommendationType: recommendation.type.slice(0, 80),
            suggestion: toPrismaJson({
              text: recommendation.suggestion,
              acceptanceTracking: true
            }),
            confidence: recommendation.confidence,
            explanation: toPrismaJson({ text: recommendation.explanation, executionId: execution.id }),
            safety: toPrismaJson(recommendation.safety),
            promptVersionId: promptVersion.id
          }
        });
      }

      await tx.semanticEmbedding.upsert({
        where: {
          clientId_entityType_entityId_model_contentHash: {
            clientId: job.data.clientId,
            entityType: "conversation_summary",
            entityId: job.data.conversationId,
            model: "hash-embedding-v1",
            contentHash: inputHash
          }
        },
        create: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          entityType: "conversation_summary",
          entityId: job.data.conversationId,
          model: "hash-embedding-v1",
          dimensions: 8,
          vector: toPrismaJson(Array.from(inputHash.slice(0, 16)).map((char) => char.charCodeAt(0) / 255)),
          contentHash: inputHash,
          metadata: toPrismaJson({ retrievalSafe: true, tenantScoped: true })
        },
        update: {
          metadata: toPrismaJson({ retrievalSafe: true, tenantScoped: true, refreshedAt: completedAt.toISOString() })
        }
      });

      await tx.aiExecutionRecovery.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          executionId: execution.id,
          recoveryType: result.fallbackUsed || belowThreshold ? "fallback_completed" : "completed",
          status: "closed",
          details: toPrismaJson({ attempts, belowThreshold })
        }
      });
    });

    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "ai",
      name: "lead_intelligence",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts,
      metadata: { retry: retryMetadata, workerName: "ai-worker", confidence },
      trace: deps.trace
    });
  } catch (error) {
    if (executionId) {
      await db.aiExecution.update({
        where: { id: executionId },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : "unknown",
          completedAt: new Date()
        }
      }).catch((updateError) => {
        deps.logger.error({ err: updateError, executionId }, "ai.execution.failure_update_failed");
      });
      await db.aiExecutionRecovery.create({
        data: {
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          executionId,
          recoveryType: "processor_failure",
          status: "open",
          details: toPrismaJson({ error: error instanceof Error ? error.message : "unknown", attempts })
        }
      }).catch((recoveryError) => {
        deps.logger.error({ err: recoveryError, executionId }, "ai.execution.recovery_create_failed");
      });
    }
    await markJobFailure(
      db,
      deps.logger,
      {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "ai",
        name: "lead_intelligence",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts,
        metadata: { retry: retryMetadata, workerName: "ai-worker" },
        trace: deps.trace
      },
      error as Error
    );
    throw error;
  }
}
