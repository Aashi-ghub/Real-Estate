import type { JsonObject, JsonValue, LeadPriority, ParsedTimeline } from "@real-estate/types";

export const LEAD_SCORE_VERSION = "phase2.v1";

export interface LeadScoringConfig {
  timelineUrgencyWeight?: number;
  budgetCompletenessWeight?: number;
  responseSpeedWeight?: number;
  financingReadinessWeight?: number;
  qualificationCompletenessWeight?: number;
  engagementCountWeight?: number;
  hotThreshold?: number;
  warmThreshold?: number;
}

export interface LeadScoringInput {
  attributes: Record<string, JsonValue>;
  responseLatencyMs?: number | null;
  engagementCount: number;
  qualificationCompleteness: number;
  config?: LeadScoringConfig | null;
}

export interface LeadScoreResult {
  total: number;
  priority: LeadPriority;
  version: string;
  breakdown: JsonObject;
}

const DEFAULT_CONFIG: Required<LeadScoringConfig> = {
  timelineUrgencyWeight: 25,
  budgetCompletenessWeight: 15,
  responseSpeedWeight: 15,
  financingReadinessWeight: 10,
  qualificationCompletenessWeight: 25,
  engagementCountWeight: 10,
  hotThreshold: 75,
  warmThreshold: 45
};

function scoreTimeline(value: JsonValue): number {
  const timeline = value as ParsedTimeline | undefined;
  if (!timeline || typeof timeline !== "object" || typeof timeline.days !== "number") {
    return 0;
  }

  if (timeline.days <= 30) {
    return 1;
  }
  if (timeline.days <= 90) {
    return 0.75;
  }
  if (timeline.days <= 180) {
    return 0.45;
  }

  return 0.25;
}

function scoreBudget(value: JsonValue): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }

  const budget = value as Record<string, unknown>;
  if (typeof budget.min === "number" && typeof budget.max === "number") {
    return 1;
  }
  if (typeof budget.min === "number" || typeof budget.max === "number") {
    return 0.7;
  }

  return 0;
}

function scoreResponseSpeed(responseLatencyMs?: number | null): number {
  if (typeof responseLatencyMs !== "number") {
    return 0.35;
  }
  if (responseLatencyMs <= 30 * 60 * 1000) {
    return 1;
  }
  if (responseLatencyMs <= 6 * 60 * 60 * 1000) {
    return 0.7;
  }
  if (responseLatencyMs <= 24 * 60 * 60 * 1000) {
    return 0.4;
  }

  return 0.15;
}

function scoreEngagement(count: number): number {
  return Math.min(Math.max(count, 0), 5) / 5;
}

function priorityForScore(total: number, config: Required<LeadScoringConfig>): LeadPriority {
  if (total >= config.hotThreshold) {
    return "HOT";
  }
  if (total >= config.warmThreshold) {
    return "WARM";
  }

  return "COLD";
}

export function computeLeadScore(input: LeadScoringInput): LeadScoreResult {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const factors = {
    timelineUrgency: scoreTimeline(input.attributes.timeline) * config.timelineUrgencyWeight,
    budgetCompleteness: scoreBudget(input.attributes.budget) * config.budgetCompletenessWeight,
    responseSpeed: scoreResponseSpeed(input.responseLatencyMs) * config.responseSpeedWeight,
    financingReadiness:
      input.attributes.financing_needed === false
        ? config.financingReadinessWeight
        : input.attributes.financing_needed === true
          ? config.financingReadinessWeight * 0.7
          : 0,
    qualificationCompleteness: Math.min(Math.max(input.qualificationCompleteness, 0), 100) / 100 * config.qualificationCompletenessWeight,
    engagementCount: scoreEngagement(input.engagementCount) * config.engagementCountWeight
  };

  const total = Math.min(
    100,
    Math.round(Object.values(factors).reduce((sum, value) => sum + value, 0))
  );

  return {
    total,
    priority: priorityForScore(total, config),
    version: LEAD_SCORE_VERSION,
    breakdown: {
      factors,
      weights: config,
      formula: "weighted_deterministic_v1"
    }
  };
}
