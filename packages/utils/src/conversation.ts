import type {
  AdvanceStateResult,
  ConversationSnapshot,
  LeadAttributeUpsert,
  ParsedAnswers,
  ParsedBudget,
  ParsedTimeline
} from "@real-estate/types";

import { sanitizeFreeText } from "./sanitization";

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

const PURPOSE_KEYWORDS = [
  "investment",
  "self use",
  "self-use",
  "end use",
  "end-use",
  "rental",
  "rental income",
  "commercial",
  "residential",
  "office",
  "retail"
];

const fillerWords = new Set([
  "my",
  "budget",
  "is",
  "around",
  "about",
  "looking",
  "for",
  "need",
  "want",
  "property",
  "home",
  "flat",
  "apartment",
  "villa",
  "plot",
  "purchase",
  "buy",
  "to",
  "the",
  "a",
  "an",
  "in",
  "at",
  "near"
]);

function amountMultiplier(unit?: string): number {
  const normalized = unit?.toLowerCase();
  switch (normalized) {
    case "k":
      return 1_000;
    case "l":
    case "lac":
    case "lakh":
    case "lakhs":
      return 100_000;
    case "cr":
    case "crore":
    case "crores":
      return 10_000_000;
    case "m":
    case "mn":
    case "million":
      return 1_000_000;
    case "b":
    case "bn":
    case "billion":
      return 1_000_000_000;
    default:
      return 1;
  }
}

function parseAmount(amountText: string, unit?: string): number {
  const normalized = Number.parseFloat(amountText.replace(/,/g, ""));
  return Math.round(normalized * amountMultiplier(unit));
}

export function parseBudget(input: string): ParsedBudget | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (!text) {
    return undefined;
  }

  const rangeMatch = text.match(
    /(?:rs\.?|inr|₹)?\s*(\d+(?:[.,]\d+)?)\s*(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?\s*(?:to|-|and)\s*(\d+(?:[.,]\d+)?)\s*(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?/i
  );
  if (rangeMatch) {
    const currency = /₹|rs|inr/i.test(rangeMatch[0]) ? "INR" : undefined;
    return {
      raw: rangeMatch[0],
      min: parseAmount(rangeMatch[1], rangeMatch[2]),
      max: parseAmount(rangeMatch[3], rangeMatch[4]),
      ...(currency ? { currency } : {})
    };
  }

  const underMatch = text.match(
    /(?:under|below|less than|up to|max(?:imum)?)\s*(?:rs\.?|inr|₹)?\s*(\d+(?:[.,]\d+)?)\s*(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?/i
  );
  if (underMatch) {
    const currency = /₹|rs|inr/i.test(underMatch[0]) ? "INR" : undefined;
    return {
      raw: underMatch[0],
      max: parseAmount(underMatch[1], underMatch[2]),
      ...(currency ? { currency } : {})
    };
  }

  const aboveMatch = text.match(
    /(?:above|over|more than|minimum|from)\s*(?:rs\.?|inr|₹)?\s*(\d+(?:[.,]\d+)?)\s*(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?/i
  );
  if (aboveMatch) {
    const currency = /₹|rs|inr/i.test(aboveMatch[0]) ? "INR" : undefined;
    return {
      raw: aboveMatch[0],
      min: parseAmount(aboveMatch[1], aboveMatch[2]),
      ...(currency ? { currency } : {})
    };
  }

  const singleAmount = text.match(
    /(?:budget|around|about|approx(?:imately)?)?\s*(?:rs\.?|inr|₹)?\s*(\d+(?:[.,]\d+)?)\s*(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)\b/i
  );
  if (singleAmount) {
    const value = parseAmount(singleAmount[1], singleAmount[2]);
    const currency = /₹|rs|inr/i.test(singleAmount[0]) ? "INR" : undefined;
    return {
      raw: singleAmount[0],
      min: value,
      max: value,
      ...(currency ? { currency } : {})
    };
  }

  return undefined;
}

export function parseTimeline(input: string): ParsedTimeline | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (!text) {
    return undefined;
  }

  if (/(immediate|asap|urgent|right away|today|this week)/i.test(text)) {
    return { raw: "immediate", days: 7, unit: "day" };
  }

  if (/this month/i.test(text)) {
    return { raw: "this month", days: 30, unit: "month" };
  }

  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
  if (rangeMatch) {
    const upper = Number.parseInt(rangeMatch[2], 10);
    return convertTimeline(rangeMatch[0], upper, rangeMatch[3]);
  }

  const exactMatch = text.match(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
  if (exactMatch) {
    return convertTimeline(exactMatch[0], Number.parseInt(exactMatch[1], 10), exactMatch[2]);
  }

  if (/next quarter/i.test(text)) {
    return { raw: "next quarter", days: 90, unit: "month" };
  }

  return undefined;
}

function convertTimeline(raw: string, amount: number, unit: string): ParsedTimeline {
  const normalizedUnit = unit.toLowerCase();
  switch (normalizedUnit) {
    case "day":
    case "days":
      return { raw, days: amount, unit: "day" };
    case "week":
    case "weeks":
      return { raw, days: amount * 7, unit: "week" };
    case "month":
    case "months":
      return { raw, days: amount * 30, unit: "month" };
    case "year":
    case "years":
      return { raw, days: amount * 365, unit: "year" };
    default:
      return { raw };
  }
}

export function parsePurpose(input: string): string | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (!text) {
    return undefined;
  }

  const keyword = PURPOSE_KEYWORDS.find((value) => text.includes(value));
  if (keyword) {
    return keyword.replace(/-/g, " ");
  }

  const forMatch = text.match(/for\s+([a-z\s-]{3,40})/i);
  if (forMatch) {
    return sanitizeFreeText(forMatch[1], 40).toLowerCase();
  }

  return undefined;
}

export function parseLocation(input: string): string | undefined {
  const original = sanitizeFreeText(input, 500);
  const text = original.toLowerCase();
  if (!text) {
    return undefined;
  }

  const hinted = text.match(/(?:in|at|around|near)\s+([a-z0-9 ,.'-]{2,80})/i);
  if (hinted) {
    return cleanLocationCandidate(hinted[1]);
  }

  const withoutBudget = text
    .replace(
      /(?:rs\.?|inr|₹)?\s*\d+(?:[.,]\d+)?\s*(?:k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?(?:\s*(?:to|-|and)\s*\d+(?:[.,]\d+)?\s*(?:k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million|b|bn|billion)?)?/gi,
      " "
    )
    .replace(/(\d+)\s*(day|days|week|weeks|month|months|year|years)/gi, " ")
    .replace(/(immediate|asap|urgent|investment|self use|rental income|commercial|residential)/gi, " ");

  const words = withoutBudget
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part && !fillerWords.has(part));

  if (words.length === 0) {
    return undefined;
  }

  return cleanLocationCandidate(words.join(" "));
}

function cleanLocationCandidate(value: string): string | undefined {
  const cleaned = sanitizeFreeText(value, 80)
    .replace(/\b(immediate|asap|investment|self use|rental income|commercial|residential)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,-]+$/, "");

  if (!cleaned || /\d{4,}/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

export function extractAnswers(input: string): ParsedAnswers {
  const budget = parseBudget(input);
  const location = parseLocation(input);
  const timeline = parseTimeline(input);
  const purpose = parsePurpose(input);

  return {
    ...(budget ? { budget } : {}),
    ...(location ? { location } : {}),
    ...(timeline ? { timeline } : {}),
    ...(purpose ? { purpose } : {})
  };
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
      parsedAnswers: {}
    };
  }

  if (conversation.state === "QUALIFIED") {
    return {
      nextState: "QUALIFIED",
      attributesToUpsert: [],
      outboundMessage: null,
      parsedAnswers: {}
    };
  }

  const text = sanitizeFreeText(inboundText ?? "", 500);
  const parsedAnswers = extractAnswers(text);
  const attributesToUpsert: LeadAttributeUpsert[] = [];
  let state: ConversationSnapshot["state"] = conversation.state;

  const capture = (key: LeadAttributeUpsert["key"], value: LeadAttributeUpsert["value"] | undefined): boolean => {
    if (value === undefined) {
      return false;
    }

    attributesToUpsert.push({ key, value });
    return true;
  };

  if (state === "ASK_BUDGET") {
    if (!capture("budget", parsedAnswers.budget as unknown as LeadAttributeUpsert["value"] | undefined)) {
      return {
        nextState: "ASK_BUDGET",
        attributesToUpsert,
        outboundMessage: promptForState(state),
        parsedAnswers
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
        parsedAnswers
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
        parsedAnswers
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
        parsedAnswers
      };
    }

    state = "QUALIFIED";
  }

  return {
    nextState: state,
    attributesToUpsert,
    outboundMessage: state === "QUALIFIED" ? QUALIFIED_MESSAGE : promptForState(state),
    parsedAnswers
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
