import type { JsonObject } from "@real-estate/types";

function numericVector(value: unknown): number[] {
  if (typeof value === "number") {
    return [value];
  }
  if (typeof value === "boolean") {
    return [value ? 1 : 0];
  }
  if (Array.isArray(value)) {
    return value.flatMap(numericVector);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => numericVector((value as Record<string, unknown>)[key]));
  }
  return [];
}

function categoricalLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.toLowerCase()];
  }
  if (Array.isArray(value)) {
    return value.flatMap(categoricalLeaves);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => categoricalLeaves((value as Record<string, unknown>)[key]).map((entry) => `${key}:${entry}`));
  }
  return [];
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]).size;
  if (union === 0) {
    return 0;
  }
  return 1 - Array.from(a).filter((entry) => b.has(entry)).length / union;
}

export function computeNumericDriftScore(baseline: unknown, current: unknown): number {
  const left = numericVector(baseline);
  const right = numericVector(current);
  const length = Math.max(left.length, right.length, 1);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs((right[index] ?? 0) - (left[index] ?? 0));
  }
  return Math.min(1, total / length);
}

export function computeCategoricalDriftScore(baseline: unknown, current: unknown): number {
  return Math.min(1, jaccard(categoricalLeaves(baseline), categoricalLeaves(current)));
}

export function computeSemanticDriftScore(baseline: unknown, current: unknown): number {
  return Math.max(computeNumericDriftScore(baseline, current), computeCategoricalDriftScore(baseline, current));
}

export const computeDriftScore = computeSemanticDriftScore;

export function evaluateDrift(input: {
  metricType: string;
  baselineVersion: string;
  currentVersion: string;
  baselineValue: unknown;
  currentValue: unknown;
  threshold: number;
}): {
  driftScore: number;
  anomaly: boolean;
  trend: JsonObject;
} {
  const numeric = computeNumericDriftScore(input.baselineValue, input.currentValue);
  const categorical = computeCategoricalDriftScore(input.baselineValue, input.currentValue);
  const driftScore = Math.max(numeric, categorical);
  return {
    driftScore,
    anomaly: driftScore > input.threshold,
    trend: {
      metricType: input.metricType,
      baselineVersion: input.baselineVersion,
      currentVersion: input.currentVersion,
      numeric,
      categorical,
      direction: driftScore > input.threshold ? "regressed" : "stable"
    }
  };
}

export function detectCostAnomaly(values: number[]): { anomalyScore: number; forecast: number; confidence: number } {
  if (values.length === 0) {
    return { anomalyScore: 0, forecast: 0, confidence: 0 };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const latest = values.at(-1) ?? mean;
  const anomalyScore = stddev === 0 ? 0 : Math.min(1, Math.abs(latest - mean) / (3 * stddev));
  return {
    anomalyScore,
    forecast: Math.max(0, mean * 30),
    confidence: Math.max(0.35, Math.min(0.95, 1 - anomalyScore / 2))
  };
}

export function promptEfficiencyScore(input: {
  inputTokens: number;
  outputTokens: number;
  confidence: number;
  costUsd: number;
}): number {
  const usefulTokens = input.outputTokens * Math.max(0.1, input.confidence);
  const totalTokens = Math.max(1, input.inputTokens + input.outputTokens);
  const costPenalty = Math.min(0.5, input.costUsd);
  return Math.max(0, Math.min(1, usefulTokens / totalTokens - costPenalty + 0.5));
}

export function computeWorkerSaturation(input: {
  activeJobs: number;
  waitingJobs: number;
  delayedJobs: number;
  failedJobs: number;
  concurrency: number;
}): {
  saturationScore: number;
  starvationRisk: number;
  adaptiveConcurrency: JsonObject;
} {
  const capacity = Math.max(1, input.concurrency);
  const saturationScore = Math.min(1, input.activeJobs / capacity + input.waitingJobs / (capacity * 10));
  const starvationRisk = Math.min(1, input.waitingJobs / (capacity * 25) + input.delayedJobs / (capacity * 50));
  return {
    saturationScore,
    starvationRisk,
    adaptiveConcurrency: {
      recommendedConcurrency: starvationRisk > 0.7 ? capacity + 1 : saturationScore < 0.25 ? Math.max(1, capacity - 1) : capacity,
      isolateTenant: starvationRisk > 0.8 || input.failedJobs > capacity,
      throttleAiHeavyTenant: input.waitingJobs > capacity * 20,
      protectOperationalQueues: true
    }
  };
}
