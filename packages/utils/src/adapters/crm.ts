import { z } from "zod";

import type {
  ClientRuntimeConfig,
  CrmPushResult,
  GenericCrmConfig,
  JsonObject,
  JsonValue
} from "@real-estate/types";

import { ExternalServiceError } from "../errors";
import { decryptSecret } from "../security";
import { sanitizeFreeText } from "../sanitization";

const crmConfigSchema = z.object({
  endpoint: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
  authType: z.enum(["none", "bearer", "api-key"]).default("none"),
  apiKeyEncrypted: z.string().optional(),
  apiKeyHeader: z.string().default("x-api-key"),
  fieldMap: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().default(5_000),
  externalIdPath: z.string().optional()
});

function getPathValue(payload: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((accumulator, segment) => {
    if (typeof accumulator === "object" && accumulator !== null && segment in (accumulator as Record<string, unknown>)) {
      return (accumulator as Record<string, unknown>)[segment];
    }

    return undefined;
  }, payload);
}

function mapCrmPayload(fieldMap: Record<string, string>, source: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [internalField, externalField] of Object.entries(fieldMap)) {
    const value = getPathValue(source, internalField);
    if (value === undefined) {
      continue;
    }

    result[externalField] = value as JsonValue;
  }

  return result;
}

export async function pushToCRM(args: {
  client: ClientRuntimeConfig;
  lead: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
    source: string;
    status: string;
    score: number;
    createdAt: Date;
  };
  attributes: Record<string, JsonValue>;
  dedupeKey: string;
  encryptionKey: string;
}): Promise<CrmPushResult> {
  const config = crmConfigSchema.parse(args.client.crmConfig) as GenericCrmConfig;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": args.dedupeKey,
    ...(config.headers ?? {})
  };

  if (config.authType !== "none" && config.apiKeyEncrypted) {
    const secret = decryptSecret(config.apiKeyEncrypted, args.encryptionKey);
    if (config.authType === "bearer") {
      headers.Authorization = `Bearer ${secret}`;
    } else {
      headers[config.apiKeyHeader ?? "x-api-key"] = secret;
    }
  }

  const sourcePayload = {
    lead: {
      ...args.lead,
      createdAt: args.lead.createdAt.toISOString()
    },
    attributes: args.attributes
  };

  const payload = mapCrmPayload(config.fieldMap, sourcePayload);
  const response = await fetch(config.endpoint, {
    method: config.method ?? "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? 5_000)
  });

  const body = (await response.json().catch(async () => sanitizeFreeText(await response.text().catch(() => ""), 4_000))) as
    | JsonValue
    | undefined;
  if (!response.ok) {
    throw new ExternalServiceError("CRM push failed", {
      retryable: response.status >= 500 || response.status === 429,
      statusCode: response.status,
      responseBody: body
    });
  }

  const externalId =
    config.externalIdPath && typeof body === "object" && body !== null
      ? (getPathValue(body as Record<string, unknown>, config.externalIdPath) as string | undefined)
      : undefined;

  return {
    statusCode: response.status,
    responseBody: body,
    ...(externalId ? { externalId } : {})
  };
}
