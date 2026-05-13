import type {
  ExtractedLeadField,
  JsonObject,
  JsonValue,
  LeadAttributeKey,
  ParsedAnswers,
  ParsedBudget,
  ParsedTimeline,
  QualificationExtractionResult
} from "@real-estate/types";

import { sanitizeFreeText } from "./sanitization";

const QUALIFICATION_FIELDS: LeadAttributeKey[] = [
  "budget",
  "location",
  "timeline",
  "property_type",
  "purpose",
  "financing_needed"
];

const PROPERTY_TYPES = [
  { pattern: /\b(?:1\s*bhk|one\s*bhk)\b/i, value: "1_bhk" },
  { pattern: /\b(?:2\s*bhk|two\s*bhk)\b/i, value: "2_bhk" },
  { pattern: /\b(?:3\s*bhk|three\s*bhk)\b/i, value: "3_bhk" },
  { pattern: /\b(?:4\s*bhk|four\s*bhk)\b/i, value: "4_bhk" },
  { pattern: /\b(apartment|flat)\b/i, value: "apartment" },
  { pattern: /\b(villa|independent house|kothi)\b/i, value: "villa" },
  { pattern: /\b(plot|land)\b/i, value: "plot" },
  { pattern: /\b(commercial|office|retail|shop|showroom)\b/i, value: "commercial" }
];

const PURPOSES = [
  { pattern: /\b(investment|invest)\b/i, value: "investment" },
  { pattern: /\b(self[ -]?use|end[ -]?use|own stay|personal use)\b/i, value: "self_use" },
  { pattern: /\b(rental income|rent|lease)\b/i, value: "rental_income" },
  { pattern: /\b(commercial use|business)\b/i, value: "commercial_use" }
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
  "near",
  "within",
  "next",
  "loan",
  "finance",
  "financing"
]);

function amountMultiplier(unit?: string): number {
  switch (unit?.toLowerCase()) {
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
    default:
      return 1;
  }
}

function parseAmount(amountText: string, unit?: string): number {
  return Math.round(Number.parseFloat(amountText.replace(/,/g, "")) * amountMultiplier(unit));
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match;
    }
  }

  return null;
}

export function parseBudget(input: string): ParsedBudget | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (!text) {
    return undefined;
  }

  const unit = "(k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million)";
  const amount = "(\\d+(?:[.,]\\d+)?)";
  const currency = "(?:rs\\.?|inr|₹)?";
  const rangeMatch = text.match(new RegExp(`${currency}\\s*${amount}\\s*${unit}?\\s*(?:to|-|and)\\s*${amount}\\s*${unit}?`, "i"));
  if (rangeMatch) {
    const leftUnit = rangeMatch[2] ?? rangeMatch[4];
    return {
      raw: rangeMatch[0],
      min: parseAmount(rangeMatch[1], leftUnit),
      max: parseAmount(rangeMatch[3], rangeMatch[4] ?? leftUnit),
      currency: "INR"
    };
  }

  const underMatch = firstMatch(text, [
    new RegExp(`(?:under|below|less than|up to|max(?:imum)?)\\s*${currency}\\s*${amount}\\s*${unit}?`, "i"),
    new RegExp(`${currency}\\s*${amount}\\s*${unit}\\s*(?:tak|ke andar)`, "i")
  ]);
  if (underMatch) {
    return {
      raw: underMatch[0],
      max: parseAmount(underMatch[1], underMatch[2]),
      currency: "INR"
    };
  }

  const aboveMatch = text.match(new RegExp(`(?:above|over|more than|minimum|from)\\s*${currency}\\s*${amount}\\s*${unit}?`, "i"));
  if (aboveMatch) {
    return {
      raw: aboveMatch[0],
      min: parseAmount(aboveMatch[1], aboveMatch[2]),
      currency: "INR"
    };
  }

  const singleAmount = text.match(new RegExp(`(?:budget|around|about|approx(?:imately)?)?\\s*${currency}\\s*${amount}\\s*${unit}\\b`, "i"));
  if (singleAmount) {
    const value = parseAmount(singleAmount[1], singleAmount[2]);
    return {
      raw: singleAmount[0],
      min: value,
      max: value,
      currency: "INR"
    };
  }

  return undefined;
}

export function parseTimeline(input: string): ParsedTimeline | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (!text) {
    return undefined;
  }

  if (/(immediate|asap|urgent|right away|today|this week|jaldi)/i.test(text)) {
    return { raw: "immediate", days: 7, unit: "day" };
  }

  if (/this month/i.test(text)) {
    return { raw: "this month", days: 30, unit: "month" };
  }

  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(day|days|week|weeks|month|months|year|years)/i);
  if (rangeMatch) {
    return convertTimeline(rangeMatch[0], Number.parseInt(rangeMatch[2], 10), rangeMatch[3]);
  }

  const exactMatch = text.match(/(?:next|within|in|after)?\s*(\d+)\s*(day|days|week|weeks|month|months|year|years|mahine|hafte)/i);
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
  if (["day", "days"].includes(normalizedUnit)) {
    return { raw, days: amount, unit: "day" };
  }
  if (["week", "weeks", "hafte"].includes(normalizedUnit)) {
    return { raw, days: amount * 7, unit: "week" };
  }
  if (["month", "months", "mahine"].includes(normalizedUnit)) {
    return { raw, days: amount * 30, unit: "month" };
  }
  if (["year", "years"].includes(normalizedUnit)) {
    return { raw, days: amount * 365, unit: "year" };
  }

  return { raw };
}

export function parsePurpose(input: string): string | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  const purpose = PURPOSES.find((candidate) => candidate.pattern.test(text));
  return purpose?.value;
}

export function parsePropertyType(input: string): string | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  const propertyType = PROPERTY_TYPES.find((candidate) => candidate.pattern.test(text));
  return propertyType?.value;
}

export function parseFinancingNeeded(input: string): boolean | undefined {
  const text = sanitizeFreeText(input, 500).toLowerCase();
  if (/\b(no loan|without loan|self funded|cash buyer|no finance|loan not needed)\b/i.test(text)) {
    return false;
  }

  if (/\b(loan|home loan|finance|financing|emi|mortgage)\b/i.test(text)) {
    return true;
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
    return cleanLocationCandidate(hinted[1].split(/\b(?:under|below|above|over|next|within|for|with|without)\b/i)[0]);
  }

  const withoutKnownAnswers = text
    .replace(/(?:rs\.?|inr|₹)?\s*\d+(?:[.,]\d+)?\s*(?:k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million)?(?:\s*(?:to|-|and)\s*\d+(?:[.,]\d+)?\s*(?:k|lac|lakh|lakhs|l|cr|crore|crores|m|mn|million)?)?/gi, " ")
    .replace(/(\d+)\s*(day|days|week|weeks|month|months|year|years|mahine|hafte)/gi, " ")
    .replace(/\b(immediate|asap|urgent|investment|invest|self use|end use|rental income|commercial|residential|loan|finance|financing|emi)\b/gi, " ")
    .replace(/\b([1-4]\s*bhk|apartment|flat|villa|plot|land|office|retail|shop|showroom)\b/gi, " ");

  const words = withoutKnownAnswers
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part && !fillerWords.has(part));

  return words.length > 0 ? cleanLocationCandidate(words.join(" ")) : undefined;
}

function cleanLocationCandidate(value: string): string | undefined {
  const cleaned = sanitizeFreeText(value, 80)
    .replace(/\b(immediate|asap|investment|self use|rental income|commercial|residential|loan|finance|financing)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,-]+$/, "");

  if (!cleaned || /\d{4,}/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

function field(
  key: LeadAttributeKey,
  value: JsonValue | undefined,
  rawValue: string | undefined,
  confidence: number,
  metadata?: JsonObject
): ExtractedLeadField | undefined {
  if (value === undefined || rawValue === undefined || rawValue.length === 0) {
    return undefined;
  }

  return {
    key,
    value,
    rawValue,
    confidence,
    source: "rule",
    ...(metadata ? { metadata } : {})
  };
}

export function extractLeadQualification(input: string): QualificationExtractionResult {
  const budget = parseBudget(input);
  const location = parseLocation(input);
  const timeline = parseTimeline(input);
  const propertyType = parsePropertyType(input);
  const purpose = parsePurpose(input);
  const financingNeeded = parseFinancingNeeded(input);

  const fields = [
    field("budget", budget as JsonValue | undefined, budget?.raw, budget?.min || budget?.max ? 0.92 : 0.75),
    field("location", location, location, location ? 0.72 : 0),
    field("timeline", timeline as JsonValue | undefined, timeline?.raw, timeline?.days ? 0.9 : 0.7),
    field("property_type", propertyType, propertyType, propertyType ? 0.86 : 0),
    field("purpose", purpose, purpose, purpose ? 0.86 : 0),
    field("financing_needed", financingNeeded, financingNeeded === undefined ? undefined : String(financingNeeded), 0.82)
  ].filter((item): item is ExtractedLeadField => Boolean(item));

  const parsedAnswers: ParsedAnswers = {
    ...(budget ? { budget } : {}),
    ...(location ? { location } : {}),
    ...(timeline ? { timeline } : {}),
    ...(propertyType ? { property_type: propertyType } : {}),
    ...(purpose ? { purpose } : {}),
    ...(financingNeeded !== undefined ? { financing_needed: financingNeeded } : {})
  };

  const completenessPercentage = computeQualificationCompleteness(fields.map((item) => item.key));
  const intentConfidence =
    fields.length === 0
      ? 0
      : Math.round((fields.reduce((sum, item) => sum + item.confidence, 0) / QUALIFICATION_FIELDS.length) * 100) / 100;

  return {
    fields,
    parsedAnswers,
    completenessPercentage,
    intentConfidence
  };
}

export function computeQualificationCompleteness(keys: Iterable<LeadAttributeKey>): number {
  const uniqueKeys = new Set(keys);
  return Math.round((uniqueKeys.size / QUALIFICATION_FIELDS.length) * 100);
}

export function qualificationFieldCount(): number {
  return QUALIFICATION_FIELDS.length;
}
