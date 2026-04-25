import type { JsonObject, JsonValue } from "@real-estate/types";

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]+/g;
const MULTI_SPACE_PATTERN = /\s+/g;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sanitizeFreeText(input: unknown, maxLength = 500): string {
  if (typeof input !== "string") {
    return "";
  }

  return input
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(MULTI_SPACE_PATTERN, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizePhoneE164(input: string): string {
  const stripped = sanitizeFreeText(input, 32)
    .replace(/^whatsapp:/i, "")
    .replace(/[()\-\s]/g, "")
    .replace(/^00/, "+");

  if (!/^\+[1-9]\d{7,14}$/.test(stripped)) {
    throw new Error("Phone must be a valid E.164 number");
  }

  return stripped;
}

export function normalizeEmail(input?: string | null): string | null {
  if (!input) {
    return null;
  }

  const normalized = sanitizeFreeText(input, 255).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (!EMAIL_PATTERN.test(normalized)) {
    throw new Error("Email must be valid");
  }

  return normalized;
}

export function sanitizeObjectKey(key: string): string {
  return sanitizeFreeText(key, 64).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function sanitizeJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 5) {
    return null;
  }

  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return typeof value === "string" ? sanitizeFreeText(value, 1000) : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeJsonValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      result[sanitizeObjectKey(key)] = sanitizeJsonValue(entry, depth + 1);
    }

    return result;
  }

  return null;
}

export function maskPhone(phone?: string | null): string | null {
  if (!phone) {
    return null;
  }

  const normalized = phone.replace(/\s+/g, "");
  const suffix = normalized.slice(-4);
  const prefix = normalized.startsWith("+") ? "+" : "";
  return `${prefix}******${suffix}`;
}

export function maskEmail(email?: string | null): string | null {
  if (!email) {
    return null;
  }

  const [local, domain] = email.split("@");
  if (!local || !domain) {
    return "***";
  }

  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function redactSecrets<T>(payload: T): T {
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload === "string") {
    return payload.replace(/(token|secret|password|authorization)/gi, "***") as T;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => redactSecrets(item)) as T;
  }

  if (typeof payload === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      clone[key] = /(token|secret|password|authorization|api[-_]?key)/i.test(key)
        ? "***"
        : redactSecrets(value);
    }

    return clone as T;
  }

  return payload;
}
