import { stableHash } from "./evaluation";

export const chaosScenarioTypes = [
  "redis_slowdown",
  "postgres_slowdown",
  "queue_corruption",
  "worker_crash",
  "malformed_embedding",
  "benchmark_corruption",
  "ai_provider_outage"
] as const;

export type ChaosScenarioType = (typeof chaosScenarioTypes)[number];

export function validateBenchmarkIntegrity(input: {
  expectedChecksum: string;
  examples: unknown;
}): {
  valid: boolean;
  actualChecksum: string;
  quarantine: boolean;
  reason?: string;
} {
  const actualChecksum = stableHash(input.examples);
  const valid = actualChecksum === input.expectedChecksum;
  return {
    valid,
    actualChecksum,
    quarantine: !valid,
    ...(valid ? {} : { reason: "benchmark_checksum_mismatch" })
  };
}

export function classifyChaosRecovery(input: {
  scenarioType: ChaosScenarioType;
  operationalQueueImpacted: boolean;
  fallbackActivated: boolean;
  recovered: boolean;
}): {
  status: "passed" | "failed" | "degraded";
  severity: "info" | "warn" | "critical";
} {
  if (input.operationalQueueImpacted || !input.recovered) {
    return { status: "failed", severity: "critical" };
  }
  if (!input.fallbackActivated && input.scenarioType !== "malformed_embedding") {
    return { status: "degraded", severity: "warn" };
  }
  return { status: "passed", severity: "info" };
}
