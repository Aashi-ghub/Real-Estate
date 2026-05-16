import { createHash } from "node:crypto";

import { z } from "zod";

import type { AiLeadIntelligenceJobData, AiTaskType, JsonObject } from "@real-estate/types";

import { sanitizeFreeText, sanitizeJsonValue } from "./sanitization";

const confidenceSchema = z.number().min(0).max(1);

export const aiLeadIntelligenceSchema = z.object({
  language: z.object({
    detected: z.enum(["english", "hindi", "hinglish", "unknown"]),
    normalizedText: z.string(),
    transliterationNotes: z.array(z.string()).default([]),
    confidence: confidenceSchema
  }),
  semantic: z.object({
    fields: z.record(z.string(), z.object({
      value: z.unknown(),
      confidence: confidenceSchema,
      reasoning: z.string(),
      provenance: z.object({
        rawUtterance: z.string(),
        source: z.enum(["rule", "ai", "hybrid"])
      })
    })).default({}),
    tags: z.array(z.string()).default([]),
    emotionalIndicators: z.array(z.string()).default([])
  }),
  emotional: z.object({
    state: z.record(z.string(), confidenceSchema).default({}),
    frictionIndicators: z.array(z.string()).default([]),
    salesResistanceMarkers: z.array(z.string()).default([]),
    trend: z.object({
      direction: z.enum(["improving", "stable", "declining", "unknown"]),
      confidence: confidenceSchema
    })
  }),
  intent: z.object({
    likelihoodToBuy: confidenceSchema,
    likelihoodToVisit: confidenceSchema,
    financingDependencyRisk: confidenceSchema,
    dropoutProbability: confidenceSchema,
    ghostingProbability: confidenceSchema,
    revisitProbability: confidenceSchema,
    negotiationProbability: confidenceSchema,
    urgencyEscalationProbability: confidenceSchema,
    confidence: confidenceSchema,
    factors: z.array(z.object({
      name: z.string(),
      contribution: z.number().min(-1).max(1),
      explanation: z.string()
    })).default([])
  }),
  memory: z.array(z.object({
    type: z.string(),
    content: z.unknown(),
    relevanceScore: confidenceSchema,
    confidence: confidenceSchema,
    tags: z.array(z.string()).default([])
  })).default([]),
  engagement: z.object({
    bestFollowupDelayMinutes: z.number().int().min(0).max(43_200),
    bestChannel: z.string(),
    escalationRiskScore: confidenceSchema,
    inactivityRisk: confidenceSchema,
    churnRisk: confidenceSchema,
    timingConfidence: confidenceSchema,
    strategy: z.array(z.string()).default([])
  }),
  summaries: z.object({
    lead: z.string(),
    objections: z.string(),
    emotional: z.string(),
    crm: z.string(),
    followup: z.string(),
    executive: z.string(),
    confidence: confidenceSchema
  }),
  recommendations: z.array(z.object({
    type: z.string(),
    suggestion: z.string(),
    confidence: confidenceSchema,
    explanation: z.string(),
    safety: z.object({
      requiresHumanApproval: z.boolean(),
      blocked: z.boolean(),
      reason: z.string().optional()
    })
  })).default([]),
  analytics: z.object({
    bottlenecks: z.array(z.string()).default([]),
    sourceQualitySignals: z.array(z.string()).default([]),
    salesFriction: z.array(z.string()).default([])
  }),
  confidence: confidenceSchema,
  reasoning: z.record(z.string(), z.unknown()).default({}),
  provenance: z.record(z.string(), z.unknown()).default({})
});

export type AiLeadIntelligence = z.infer<typeof aiLeadIntelligenceSchema>;

const hindiHints = /\b(ke liye|chahiye|tak|lakh|crore|cr|metro|parents|family shift|loan|approval|nahi|haan)\b/i;
const unsafeOutputPatterns = [
  /\bignore previous instructions\b/i,
  /\bdelete all data\b/i,
  /\bbypass\b/i,
  /\bguaranteed appreciation\b/i,
  /\bfake scarcity\b/i,
  /\bonly today\b/i,
  /\bforce\b/i,
  /\bmust buy\b/i,
  /\bmanipulate\b/i
];

function scoreText(text: string, patterns: RegExp[]): number {
  return Math.min(1, patterns.reduce((score, pattern) => score + (pattern.test(text) ? 0.25 : 0), 0));
}

export function hashAiInput(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(sanitizeJsonValue(payload))).digest("hex");
}

export function redactPromptPii(input: string): string {
  return sanitizeFreeText(input, 2_000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\s-]?){8,15}/g, "[phone]");
}

export function normalizeMixedLanguage(input: string): {
  detected: "english" | "hindi" | "hinglish" | "unknown";
  normalizedText: string;
  notes: string[];
  confidence: number;
} {
  const text = sanitizeFreeText(input, 2_000).toLowerCase();
  const notes: string[] = [];
  let normalizedText = text
    .replace(/\b(\d+(?:\.\d+)?)\s*(l|lac|lakh)\b/g, "$1 lakh")
    .replace(/\b(\d+(?:\.\d+)?)\s*(cr|crore)\b/g, "$1 crore")
    .replace(/\btak\b/g, "up to")
    .replace(/\btill\b/g, "up to")
    .replace(/\bke liye\b/g, "for")
    .replace(/\bchahiye\b/g, "needed")
    .replace(/\bkarni hai\b/g, "want to do")
    .replace(/\bfamily shift\b/g, "family relocation")
    .replace(/\bflat lena hai\b/g, "want to buy flat")
    .replace(/\bloan chal raha hai\b/g, "loan is in progress")
    .replace(/\bbudget stretch ho jayega\b/g, "budget can stretch")
    .replace(/\bnext quarter purchase\b/g, "purchase timeline next quarter")
    .replace(/\binvestment for\b/g, "investment for");

  if (normalizedText !== text) {
    notes.push("transliterated-hindi-mapped");
  }

  const hasHindi = hindiHints.test(text) || /[\u0900-\u097F]/.test(input);
  const hasEnglish = /[a-z]/i.test(input);
  return {
    detected: hasHindi && hasEnglish ? "hinglish" : hasHindi ? "hindi" : hasEnglish ? "english" : "unknown",
    normalizedText,
    notes,
    confidence: hasHindi || hasEnglish ? 0.82 : 0.3
  };
}

export interface NormalizedBudget {
  raw: string;
  min?: number;
  max?: number;
  currency: "INR";
  flexible: boolean;
  unit: "rupee";
}

function amountToRupees(amount: number, unit: string): number {
  if (/crore|cr/i.test(unit)) {
    return Math.round(amount * 10_000_000);
  }
  if (/lakh|lac|l\b/i.test(unit)) {
    return Math.round(amount * 100_000);
  }
  return Math.round(amount);
}

export function parseIndianBudget(input: string): NormalizedBudget | null {
  const text = normalizeMixedLanguage(input).normalizedText;
  const amountPattern = /(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|l)\b/gi;
  const matches = Array.from(text.matchAll(amountPattern));
  if (matches.length === 0) {
    return null;
  }

  const values = matches.map((match) => amountToRupees(Number(match[1]), match[2]));
  const flexible = /\b(stretch|flexible|up to|under|below|less than|tak)\b/i.test(text);
  const upperBound = /\b(under|below|less than|up to)\b/i.test(text);
  return {
    raw: sanitizeFreeText(input, 500),
    ...(upperBound || values.length === 1 ? { max: Math.max(...values) } : { min: Math.min(...values), max: Math.max(...values) }),
    currency: "INR",
    flexible,
    unit: "rupee"
  };
}

export function parsePurchaseTimeline(input: string): { raw: string; days?: number; label: string } | null {
  const text = normalizeMixedLanguage(input).normalizedText;
  if (/\burgent|immediate|asap|jaldi\b/i.test(text)) {
    return { raw: input, days: 7, label: "urgent" };
  }
  if (/\bnext month\b/i.test(text)) {
    return { raw: input, days: 30, label: "next_month" };
  }
  if (/\bnext quarter|quarter\b/i.test(text)) {
    return { raw: input, days: 90, label: "next_quarter" };
  }
  const withinMonths = text.match(/\bwithin\s+(\d+)\s+months?\b/i);
  if (withinMonths) {
    return { raw: input, days: Number(withinMonths[1]) * 30, label: "within_months" };
  }
  return null;
}

export function validateAiRecommendationSafety(text: string): {
  blocked: boolean;
  score: number;
  reasons: string[];
} {
  const sanitized = sanitizeFreeText(text, 2_000);
  const reasons = unsafeOutputPatterns
    .filter((pattern) => pattern.test(sanitized))
    .map((pattern) => pattern.source.replace(/\\b/g, ""));
  return {
    blocked: reasons.length > 0,
    score: reasons.length === 0 ? 0 : Math.min(1, reasons.length * 0.35),
    reasons
  };
}

export function neutralizeAdversarialText(input: string): string {
  return unsafeOutputPatterns.reduce(
    (text, pattern) => text.replace(pattern, "[blocked unsafe instruction]"),
    sanitizeFreeText(input, 2_000)
  );
}

export function deterministicAiLeadIntelligence(job: AiLeadIntelligenceJobData): AiLeadIntelligence {
  const raw = neutralizeAdversarialText(redactPromptPii(job.rawUtterance));
  const lower = raw.toLowerCase();
  const language = normalizeMixedLanguage(raw);
  const normalizedLower = language.normalizedText.toLowerCase();
  const budget = parseIndianBudget(raw);
  const timeline = parsePurchaseTimeline(raw);
  const urgency = scoreText(normalizedLower, [/immediate|urgent|asap|this month|next week|jaldi|visit/i, /next quarter|30 days|month|purchase timeline/i]);
  const hesitation = scoreText(lower, [/if|only if|maybe|pending|confused|doubt|concern|stretch/i]);
  const priceAnxiety = scoreText(normalizedLower, [/budget|price|cost|expensive|negotiate|discount|stretch|lakh|crore|cr|under|below/i]);
  const trustConcern = scoreText(lower, [/builder|trust|delay|legal|possession|rera/i]);
  const investmentIntent = scoreText(normalizedLower, [/investment|appreciate|appreciation|rental|rent|roi/i]);
  const rentalIntent = scoreText(normalizedLower, [/rental|rent|tenant/i]);
  const appreciationIntent = scoreText(normalizedLower, [/appreciate|appreciation|roi|returns/i]);
  const familyIntent = scoreText(normalizedLower, [/family|parents|kids|school|shift|relocation/i]);
  const financingRisk = scoreText(normalizedLower, [/loan|approval|finance|emi|bank|pending|in progress/i]);
  const negotiation = scoreText(normalizedLower, [/negotiate|discount|best price|deal|under|stretch/i]);
  const metro = /metro/i.test(normalizedLower);
  const gated = /gated society|clubhouse|security|amenit|pool|gym|parking/i.test(normalizedLower);
  const luxury = /luxury|premium|high end|luxury only|luxury hi needed/i.test(normalizedLower);

  const semanticFields: AiLeadIntelligence["semantic"]["fields"] = {};
  const addField = (name: string, value: unknown, confidence: number, reasoning: string) => {
    semanticFields[name] = {
      value,
      confidence,
      reasoning,
      provenance: { rawUtterance: raw, source: "hybrid" }
    };
  };

  if (budget) {
    addField("budget", budget, 0.86, "Indian budget units were normalized into rupees.");
    addField("flexible_budget_range", { mentioned: true, flexible: budget.flexible, min: budget.min, max: budget.max, currency: budget.currency }, 0.82, "Budget range and flexibility language were normalized.");
  }
  if (urgency > 0) {
    addField("urgency", { level: urgency >= 0.5 ? "high" : "medium" }, Math.max(0.55, urgency), "Timeline urgency terms were detected.");
  }
  if (timeline) {
    addField("purchase_timeline", timeline, 0.8, "Purchase timeline language was normalized.");
  }
  if (financingRisk > 0) {
    addField("financing_dependency", { required: true, risk: financingRisk }, 0.8, "Financing or loan dependency was mentioned.");
  }
  if (investmentIntent > 0) {
    addField("investment_intent", { present: true }, 0.76, "Investment, appreciation, rent, or ROI language was detected.");
  }
  if (rentalIntent > 0) {
    addField("rental_intent", { present: true }, 0.76, "Rental income intent was detected.");
  }
  if (appreciationIntent > 0) {
    addField("appreciation_intent", { present: true }, 0.76, "Appreciation or ROI language was detected.");
  }
  if (familyIntent > 0) {
    addField("family_intent", { present: true }, 0.74, "Family or relocation motivation was detected.");
  }
  if (metro) {
    addField("locality_preferences", { nearMetro: true }, 0.82, "Metro proximity was explicitly mentioned.");
  }
  if (gated) {
    addField("preferred_amenities", { gatedSociety: /gated society/i.test(normalizedLower), security: /security/i.test(normalizedLower), parking: /parking/i.test(normalizedLower), clubhouse: /clubhouse/i.test(normalizedLower), gym: /gym/i.test(normalizedLower), pool: /pool/i.test(normalizedLower) }, 0.78, "Amenity preference language was detected.");
  }
  if (luxury) {
    addField("luxury_sensitivity", { level: "high", luxuryOnly: /only|hi/i.test(normalizedLower) }, 0.8, "Luxury or premium-only language was detected.");
  }
  if (trustConcern > 0) {
    addField("builder_trust_concerns", { present: true }, 0.72, "Trust, builder, legal, possession, or RERA concern language was detected.");
  }
  if (priceAnxiety > 0) {
    addField("pricing_sensitivity", { present: true }, 0.7, "Price, budget, stretch, or negotiation language was detected.");
  }
  if (negotiation > 0) {
    addField("negotiation_tendency", { likely: true }, Math.max(0.65, negotiation), "Negotiation or deal-seeking language was detected.");
  }

  const responseDepth = Math.min(1, raw.split(/\s+/).filter(Boolean).length / 30);
  const engagementBase = Math.max(responseDepth, Number(job.deterministic.confidence ?? 0));
  const buyIntent = Math.min(1, 0.35 + investmentIntent * 0.2 + familyIntent * 0.2 + urgency * 0.2 + engagementBase * 0.2);
  const dropout = Math.max(0.05, Math.min(1, 0.35 + hesitation * 0.25 + financingRisk * 0.25 - engagementBase * 0.2));

  return aiLeadIntelligenceSchema.parse({
    language: {
      detected: language.detected,
      normalizedText: language.normalizedText,
      transliterationNotes: language.notes,
      confidence: language.confidence
    },
    semantic: {
      fields: semanticFields,
      tags: Object.keys(semanticFields),
      emotionalIndicators: [
        ...(hesitation > 0 ? ["hesitation"] : []),
        ...(priceAnxiety > 0 ? ["price_anxiety"] : []),
        ...(trustConcern > 0 ? ["distrust"] : []),
        ...(urgency > 0 ? ["urgency"] : [])
      ]
    },
    emotional: {
      state: {
        hesitation,
        urgency,
        excitement: scoreText(lower, [/great|interested|love|yes|haan|book/i]),
        distrust: trustConcern,
        frustration: scoreText(lower, [/frustrated|again|delay|problem|issue/i]),
        confusion: scoreText(lower, [/confused|not sure|maybe|samajh/i]),
        commitmentLevel: buyIntent,
        curiosity: scoreText(lower, [/details|options|available|show|visit/i]),
        fearOfMissingOut: scoreText(lower, [/limited|last|soon|miss/i]),
        priceAnxiety,
        emotionalReadiness: Math.max(0.1, buyIntent - hesitation * 0.2)
      },
      frictionIndicators: [
        ...(financingRisk > 0 ? ["financing_dependency"] : []),
        ...(priceAnxiety > 0 ? ["pricing_sensitivity"] : []),
        ...(trustConcern > 0 ? ["trust_concern"] : [])
      ],
      salesResistanceMarkers: [
        ...(hesitation > 0 ? ["conditional_interest"] : []),
        ...(priceAnxiety > 0 ? ["negotiation_likely"] : [])
      ],
      trend: { direction: "stable", confidence: 0.6 }
    },
    intent: {
      likelihoodToBuy: buyIntent,
      likelihoodToVisit: Math.min(1, buyIntent + (metro ? 0.1 : 0)),
      financingDependencyRisk: financingRisk,
      dropoutProbability: dropout,
      ghostingProbability: Math.min(1, dropout + (responseDepth < 0.2 ? 0.2 : 0)),
      revisitProbability: Math.min(1, buyIntent + urgency * 0.1 + responseDepth * 0.1),
      negotiationProbability: Math.max(priceAnxiety, negotiation),
      urgencyEscalationProbability: urgency,
      confidence: Math.max(0.55, engagementBase),
      factors: [
        { name: "engagement_depth", contribution: engagementBase, explanation: "Based on message detail and deterministic extraction confidence." },
        { name: "urgency", contribution: urgency, explanation: "Based on explicit timing language." },
        { name: "friction", contribution: -dropout, explanation: "Based on hesitation, financing, and pricing resistance." }
      ]
    },
    memory: Object.entries(semanticFields).map(([type, field]) => ({
      type,
      content: field.value,
      relevanceScore: field.confidence,
      confidence: field.confidence,
      tags: [type]
    })),
    engagement: {
      bestFollowupDelayMinutes: urgency >= 0.5 ? 30 : dropout >= 0.5 ? 240 : 1_440,
      bestChannel: "whatsapp",
      escalationRiskScore: Math.max(urgency, trustConcern),
      inactivityRisk: Math.min(1, dropout),
      churnRisk: Math.min(1, dropout + trustConcern * 0.15),
      timingConfidence: 0.68,
      strategy: [
        ...(priceAnxiety > 0 ? ["acknowledge budget flexibility"] : []),
        ...(trustConcern > 0 ? ["share trust proof before pushing visit"] : []),
        ...(urgency > 0 ? ["offer fast visit slot"] : ["use soft re-engagement"])
      ]
    },
    summaries: {
      lead: raw ? `Lead mentioned: ${raw}` : "No usable utterance available.",
      objections: hesitation > 0 || priceAnxiety > 0 || trustConcern > 0 ? "Objections include conditional interest, pricing, financing, or trust concerns." : "No strong objection detected.",
      emotional: "Emotional state inferred from urgency, hesitation, pricing sensitivity, and trust markers.",
      crm: `Language=${language.detected}; tags=${Object.keys(semanticFields).join(",") || "none"}.`,
      followup: urgency >= 0.5 ? "Follow up quickly with a concrete next step." : "Follow up with reassurance and preference confirmation.",
      executive: `Intent=${buyIntent.toFixed(2)}; dropout=${dropout.toFixed(2)}; financingRisk=${financingRisk.toFixed(2)}.`,
      confidence: 0.67
    },
    recommendations: [
      {
        type: "followup_phrasing",
        suggestion: priceAnxiety > 0 ? "Acknowledge the budget boundary and present options that preserve location fit." : "Confirm the most important preference and offer the next available visit slot.",
        confidence: 0.66,
        explanation: "Recommendation is derived from semantic and emotional signals only.",
        safety: { requiresHumanApproval: true, blocked: false }
      },
      {
        type: "objection_handling",
        suggestion: trustConcern > 0 ? "Share builder credibility, delivery history, and documentation status before asking for commitment." : "Use preference-led discovery before negotiation.",
        confidence: 0.62,
        explanation: "Trust and friction markers determine the assistive sales angle.",
        safety: { requiresHumanApproval: true, blocked: false }
      }
    ],
    analytics: {
      bottlenecks: financingRisk > 0 ? ["loan_dependency"] : [],
      sourceQualitySignals: [],
      salesFriction: [priceAnxiety > 0 ? "pricing" : "", trustConcern > 0 ? "trust" : ""].filter(Boolean)
    },
    confidence: 0.68,
    reasoning: {
      deterministicFirst: true,
      tasks: job.tasks as AiTaskType[],
      parserConfidence: job.deterministic.confidence ?? 0
    } satisfies JsonObject,
    provenance: {
      rawUtterance: raw,
      source: "deterministic_fallback"
    }
  });
}
