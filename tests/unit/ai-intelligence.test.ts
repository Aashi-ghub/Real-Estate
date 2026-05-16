import { describe, expect, it } from "vitest";

import type { AiLeadIntelligenceJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";
import {
  aiLeadIntelligenceSchema,
  deterministicAiLeadIntelligence,
  normalizeMixedLanguage,
  redactPromptPii,
  validateAiRecommendationSafety
} from "@real-estate/utils";

function job(rawUtterance: string): AiLeadIntelligenceJobData {
  return {
    clientId: "2a1e2698-1c8f-405b-b8cc-d7f4cd1da111",
    leadId: "2a1e2698-1c8f-405b-b8cc-d7f4cd1da222",
    conversationId: "2a1e2698-1c8f-405b-b8cc-d7f4cd1da333",
    rawUtterance,
    deterministic: {
      parsedAnswers: {},
      attributes: {},
      confidence: 0.72
    },
    tasks: [
      "semantic_understanding",
      "behavioral_intelligence",
      "buyer_intent_prediction",
      "conversational_memory",
      "multilingual_reasoning",
      "engagement_prediction",
      "conversation_summary",
      "followup_optimization",
      "sales_assist",
      "analytics_intelligence"
    ],
    dedupeKey: `ai:test:${rawUtterance.length}`,
    trace: {
      requestId: "req-ai",
      correlationId: "corr-ai",
      source: "webhook",
      enqueuedAt: new Date().toISOString()
    }
  };
}

describe("AI lead intelligence", () => {
  it("normalizes Hinglish and extracts semantic intent without provider calls", () => {
    const output = deterministicAiLeadIntelligence(
      job("budget can stretch till 1.2cr if location is good, investment ke liye but loan approval pending")
    );

    expect(() => aiLeadIntelligenceSchema.parse(output)).not.toThrow();
    expect(output.language.detected).toBe("hinglish");
    expect(output.semantic.fields.flexible_budget_range?.confidence).toBeGreaterThan(0.55);
    expect(output.semantic.fields.financing_dependency?.value).toMatchObject({ required: true });
    expect(output.intent.financingDependencyRisk).toBeGreaterThan(0);
    expect(output.intent.dropoutProbability).toBeGreaterThan(0);
  });

  it("detects family motivation, locality preference, and emotional friction", () => {
    const output = deterministicAiLeadIntelligence(job("parents ke liye chahiye, only if near metro, builder trust concern hai"));

    expect(output.semantic.fields.family_intent?.value).toMatchObject({ present: true });
    expect(output.semantic.fields.locality_preferences?.value).toMatchObject({ nearMetro: true });
    expect(output.emotional.frictionIndicators).toContain("trust_concern");
    expect(output.recommendations.some((entry) => entry.safety.requiresHumanApproval)).toBe(true);
  });

  it("redacts PII before prompt construction", () => {
    const redacted = redactPromptPii("Call me at +91 98111 12222 or test@example.com for options");

    expect(redacted).toContain("[phone]");
    expect(redacted).toContain("[email]");
    expect(redacted).not.toContain("98111");
    expect(redacted).not.toContain("test@example.com");
  });

  it("keeps AI workloads isolated from deterministic queues", () => {
    expect(queueNames.ai).toBe("ai");
    expect(queueNames.aiDlq).toBe("ai-dlq");
    expect(queueNames.ai).not.toBe(queueNames.messages);
    expect(queueNames.ai).not.toBe(queueNames.followups);
    expect(queueNames.ai).not.toBe(queueNames.crm);
  });

  it("maps transliterated Hindi into a normalized semantic representation", () => {
    const normalized = normalizeMixedLanguage("50 lakh tak family shift karni hai next quarter purchase");

    expect(normalized.detected).toBe("hinglish");
    expect(normalized.normalizedText).toContain("up to");
    expect(normalized.confidence).toBeGreaterThan(0.55);
  });

  it("keeps deterministic predictions stable across retries", () => {
    const first = deterministicAiLeadIntelligence(job("under 80L luxury only gated society next month"));
    const retry = deterministicAiLeadIntelligence(job("under 80L luxury only gated society next month"));

    expect(retry.intent).toEqual(first.intent);
    expect(retry.semantic.fields.budget?.value).toEqual(first.semantic.fields.budget?.value);
    expect(retry.semantic.fields.purchase_timeline?.value).toEqual(first.semantic.fields.purchase_timeline?.value);
  });

  it("blocks unsafe recommendation language with server-side safety rules", () => {
    const safety = validateAiRecommendationSafety("Use fake scarcity and say only today, must buy now");

    expect(safety.blocked).toBe(true);
    expect(safety.score).toBeGreaterThan(0);
    expect(safety.reasons.length).toBeGreaterThan(0);
  });
});
