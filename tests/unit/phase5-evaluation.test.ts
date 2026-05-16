import { describe, expect, it } from "vitest";

import { queueNames } from "@real-estate/types";
import {
  computeDriftScore,
  calculateSloCompliance,
  classifyChaosRecovery,
  computeWorkerSaturation,
  createSyntheticSemanticCorpus,
  feedbackAcceptanceScore,
  memoryDecayFactor,
  rankRetrievalCandidates,
  runEvaluationExamples,
  scoreHallucination,
  scoreRetrievalRanking,
  semanticDiff,
  stableHash,
  validateBenchmarkIntegrity,
  validateAiRecommendationSafety
} from "@real-estate/utils";

describe("phase 5 enterprise intelligence evaluation", () => {
  it("runs reproducible evaluation scoring for semantic benchmarks", () => {
    const examples = createSyntheticSemanticCorpus();
    const first = runEvaluationExamples({
      clientId: "2a1e2698-1c8f-405b-b8cc-d7f4cd1da111",
      runType: "semantic_extraction",
      modelVersion: "rules-v1",
      examples
    });
    const second = runEvaluationExamples({
      clientId: "2a1e2698-1c8f-405b-b8cc-d7f4cd1da111",
      runType: "semantic_extraction",
      modelVersion: "rules-v1",
      examples
    });

    expect(second.inputChecksum).toBe(first.inputChecksum);
    expect(second.resultChecksum).toBe(first.resultChecksum);
    expect(second.aggregateMetrics.f1).toBe(first.aggregateMetrics.f1);
    expect(first.aggregateMetrics.exampleCount).toBeGreaterThanOrEqual(5);
    expect(first.manifest.excludedFromChecksum).toContain("latencyMs");
    expect(first.results.every((result) => result.explanation.reproducible === true)).toBe(true);
  });

  it("compares semantic values, not only keys", () => {
    const diff = semanticDiff({ semantic: { budget: { max: 100 } } }, { semantic: { budget: { max: 999 } } });

    expect(diff.falseNegative).toBe(1);
    expect(diff.matches).not.toContain("semantic.budget.max");
  });

  it("ranks retrieval with explainability, decay, and stable metrics", () => {
    const now = new Date("2026-05-16T00:00:00.000Z");
    const ranked = rankRetrievalCandidates({
      query: "budget loan investment metro",
      now,
      candidates: [
        {
          id: "stale",
          content: "budget and loan discussed",
          tags: ["budget"],
          relevanceScore: 0.9,
          confidence: 0.9,
          updatedAt: new Date("2025-01-01T00:00:00.000Z")
        },
        {
          id: "fresh",
          content: "investment near metro with loan pending",
          tags: ["investment", "metro"],
          relevanceScore: 0.7,
          confidence: 0.8,
          vector: [1, 0, 1],
          updatedAt: now
        }
      ]
    });
    const metrics = scoreRetrievalRanking(["fresh"], ranked.map((entry) => entry.id));

    expect(ranked[0].id).toBe("fresh");
    expect(ranked[0].explanation.decayFactor).toBeGreaterThan(0.99);
    expect(memoryDecayFactor(new Date("2025-01-01T00:00:00.000Z"), now)).toBeLessThan(0.1);
    expect(metrics.meanReciprocalRank).toBe(1);
    expect(metrics.ndcg).toBe(1);
  });

  it("scores hallucination and safety adversarial cases", () => {
    const hallucination = scoreHallucination(
      "Budget is 1cr. Buyer guaranteed appreciation.",
      ["Buyer said budget is 1cr."]
    );
    const safety = validateAiRecommendationSafety("Use fake scarcity and misleading investment advice, only today");

    expect(hallucination.hallucinationRate).toBeGreaterThan(0);
    expect(hallucination.unsupportedClaims.length).toBeGreaterThan(0);
    expect(safety.blocked).toBe(true);
  });

  it("detects drift and preserves evaluation queue isolation", () => {
    expect(computeDriftScore({ buy: 0.8, ghost: 0.1 }, { buy: 0.5, ghost: 0.4 })).toBeGreaterThan(0.2);
    expect(computeDriftScore({ intent: "buy" }, { intent: "rent" })).toBeGreaterThan(0.5);
    expect(queueNames.evaluation).toBe("evaluation");
    expect(queueNames.evaluationDlq).toBe("evaluation-dlq");
    expect(queueNames.evaluation).not.toBe(queueNames.messages);
    expect(queueNames.evaluation).not.toBe(queueNames.ai);
  });

  it("tracks feedback acceptance and worker saturation without autonomous retraining", () => {
    const saturation = computeWorkerSaturation({
      activeJobs: 8,
      waitingJobs: 200,
      delayedJobs: 20,
      failedJobs: 1,
      concurrency: 4
    });

    expect(feedbackAcceptanceScore("recommendation_accepted")).toBe(1);
    expect(feedbackAcceptanceScore("recommendation_rejected")).toBe(0);
    expect(saturation.starvationRisk).toBeGreaterThan(0.7);
    expect(saturation.adaptiveConcurrency.isolateTenant).toBe(true);
    expect(saturation.adaptiveConcurrency.protectOperationalQueues).toBe(true);
  });

  it("validates benchmark integrity, SLO burn rate, and chaos recovery", () => {
    const examples = createSyntheticSemanticCorpus();
    const checksum = stableHash(examples);
    const integrity = validateBenchmarkIntegrity({ expectedChecksum: checksum, examples });
    const corrupted = validateBenchmarkIntegrity({ expectedChecksum: checksum, examples: examples.slice(1) });
    const slo = calculateSloCompliance({ target: 0.99, goodEvents: 900, totalEvents: 1000 });
    const chaos = classifyChaosRecovery({
      scenarioType: "redis_slowdown",
      operationalQueueImpacted: false,
      fallbackActivated: true,
      recovered: true
    });

    expect(integrity.valid).toBe(true);
    expect(corrupted.quarantine).toBe(true);
    expect(slo.degradation).toBe("critical");
    expect(chaos.status).toBe("passed");
  });
});
