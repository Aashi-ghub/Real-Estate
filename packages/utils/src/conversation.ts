import type {
  AdvanceStateResult,
  ConversationSnapshot,
  LeadAttributeUpsert,
  ParsedAnswers,
  ParsedTimeline
} from "@real-estate/types";

import { sanitizeFreeText } from "./sanitization";
import {
  computeQualificationCompleteness,
  extractLeadQualification,
  parseBudget,
  parseLocation,
  parsePurpose,
  parseTimeline
} from "./qualification";

const BUDGET_PROMPT =
  "What budget range are you considering? You can reply like 80 lakh to 1 crore.";
const LOCATION_PROMPT = "Which location or area are you interested in?";
const TIMELINE_PROMPT =
  "What is your purchase timeline? For example: immediate, 30 days, or 3 months.";
const PURPOSE_PROMPT =
  "Is this for self-use, investment, rental income, or something else?";
const QUALIFIED_MESSAGE =
  "Thanks, that helps a lot. Our team will review this and contact you shortly with suitable options.";
const INTRO_MESSAGE =
  "Hi, thanks for your interest in our properties. I will ask a few quick questions to match the right options. What budget range are you considering?";

export function extractAnswers(input: string): ParsedAnswers {
  return extractLeadQualification(input).parsedAnswers;
}

export function promptForState(state: ConversationSnapshot["state"]): string {
  switch (state) {
    case "ASK_BUDGET":
      return BUDGET_PROMPT;
    case "ASK_LOCATION":
      return LOCATION_PROMPT;
    case "ASK_TIMELINE":
      return TIMELINE_PROMPT;
    case "ASK_PURPOSE":
      return PURPOSE_PROMPT;
    case "INIT":
      return INTRO_MESSAGE;
    case "QUALIFIED":
      return QUALIFIED_MESSAGE;
    default:
      return INTRO_MESSAGE;
  }
}

export function advanceState(
  conversation: ConversationSnapshot,
  inboundText: string | null = null
): AdvanceStateResult {
  if (conversation.state === "INIT") {
    return {
      nextState: "ASK_BUDGET",
      attributesToUpsert: [],
      outboundMessage: INTRO_MESSAGE,
      parsedAnswers: {},
      completenessPercentage: 0,
      intentConfidence: 0
    };
  }

  if (conversation.state === "QUALIFIED") {
    return {
      nextState: "QUALIFIED",
      attributesToUpsert: [],
      outboundMessage: null,
      parsedAnswers: {},
      completenessPercentage: 100,
      intentConfidence: Number(conversation.context?.intentConfidence ?? 1)
    };
  }

  const text = sanitizeFreeText(inboundText ?? "", 500);
  const extraction = extractLeadQualification(text);
  const parsedAnswers = extraction.parsedAnswers;
  const attributesToUpsert: LeadAttributeUpsert[] = [];
  let state: ConversationSnapshot["state"] = conversation.state;

  const capture = (key: LeadAttributeUpsert["key"], value: LeadAttributeUpsert["value"] | undefined): boolean => {
    const extracted = extraction.fields.find((field) => field.key === key);
    if (value === undefined || !extracted) {
      return false;
    }

    attributesToUpsert.push({
      key,
      value,
      rawValue: extracted.rawValue,
      confidence: extracted.confidence,
      source: extracted.source,
      metadata: extracted.metadata
    });
    return true;
  };

  if (state === "ASK_BUDGET") {
    if (!capture("budget", parsedAnswers.budget as unknown as LeadAttributeUpsert["value"] | undefined)) {
      return {
        nextState: "ASK_BUDGET",
        attributesToUpsert,
        outboundMessage: promptForState(state),
        parsedAnswers,
        completenessPercentage: extraction.completenessPercentage,
        intentConfidence: extraction.intentConfidence
      };
    }

    state = "ASK_LOCATION";
  }

  if (state === "ASK_LOCATION") {
    if (!capture("location", parsedAnswers.location)) {
      return {
        nextState: "ASK_LOCATION",
        attributesToUpsert,
        outboundMessage: promptForState(state),
        parsedAnswers,
        completenessPercentage: extraction.completenessPercentage,
        intentConfidence: extraction.intentConfidence
      };
    }

    state = "ASK_TIMELINE";
  }

  if (state === "ASK_TIMELINE") {
    if (!capture("timeline", parsedAnswers.timeline as unknown as LeadAttributeUpsert["value"] | undefined)) {
      return {
        nextState: "ASK_TIMELINE",
        attributesToUpsert,
        outboundMessage: promptForState(state),
        parsedAnswers,
        completenessPercentage: extraction.completenessPercentage,
        intentConfidence: extraction.intentConfidence
      };
    }

    state = "ASK_PURPOSE";
  }

  if (state === "ASK_PURPOSE") {
    if (!capture("purpose", parsedAnswers.purpose)) {
      return {
        nextState: "ASK_PURPOSE",
        attributesToUpsert,
        outboundMessage: promptForState(state),
        parsedAnswers,
        completenessPercentage: extraction.completenessPercentage,
        intentConfidence: extraction.intentConfidence
      };
    }

    state = "QUALIFIED";
  }

  for (const extracted of extraction.fields) {
    if (!attributesToUpsert.some((attribute) => attribute.key === extracted.key)) {
      attributesToUpsert.push({
        key: extracted.key,
        value: extracted.value,
        rawValue: extracted.rawValue,
        confidence: extracted.confidence,
        source: extracted.source,
        metadata: extracted.metadata
      });
    }
  }

  const uniqueAttributesToUpsert = Array.from(
    new Map(attributesToUpsert.map((attribute) => [attribute.key, attribute])).values()
  );

  return {
    nextState: state,
    attributesToUpsert: uniqueAttributesToUpsert,
    outboundMessage: state === "QUALIFIED" ? QUALIFIED_MESSAGE : promptForState(state),
    parsedAnswers,
    completenessPercentage: extraction.completenessPercentage,
    intentConfidence: extraction.intentConfidence
  };
}

export function computeQualificationScore(options: {
  timeline?: ParsedTimeline;
  responseLatencyMs?: number | null;
  completenessCount?: number;
}): number {
  let score = 20;

  const days = options.timeline?.days;
  if (typeof days === "number") {
    if (days <= 30) {
      score += 35;
    } else if (days <= 90) {
      score += 25;
    } else {
      score += 15;
    }
  }

  const latencyMs = options.responseLatencyMs ?? null;
  if (typeof latencyMs === "number") {
    if (latencyMs <= 30 * 60 * 1000) {
      score += 25;
    } else if (latencyMs <= 6 * 60 * 60 * 1000) {
      score += 15;
    } else {
      score += 5;
    }
  }

  score += Math.min((options.completenessCount ?? 0) * 5, 20);
  return Math.min(score, 100);
}
