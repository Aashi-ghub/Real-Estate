import { z } from "zod";

import type {
  ClientRuntimeConfig,
  CrmPushResult,
  GenericCrmConfig,
  JsonObject,
  JsonValue,
  ProviderCrmConfig
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

const providerCrmConfigSchema = z.object({
  endpoint: z.string().url().optional(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authType: z.enum(["none", "bearer", "api-key"]).optional(),
  accessTokenEncrypted: z.string().optional(),
  apiKeyEncrypted: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  portalId: z.string().optional(),
  module: z.string().optional(),
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

interface CrmPushSource {
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
}

interface CrmAdapter {
  buildRequest(args: {
    client: ClientRuntimeConfig;
    source: CrmPushSource;
    dedupeKey: string;
    encryptionKey: string;
  }): {
    endpoint: string;
    method: "POST" | "PUT" | "PATCH";
    headers: Record<string, string>;
    payload: JsonObject;
    timeoutMs: number;
    externalIdPath?: string;
  };
}

function buildSourcePayload(source: CrmPushSource) {
  return {
    lead: {
      ...source.lead,
      createdAt: source.lead.createdAt.toISOString()
    },
    attributes: source.attributes
  };
}

function withAuthHeaders(
  config: GenericCrmConfig | ProviderCrmConfig,
  encryptionKey: string,
  headers: Record<string, string>
): Record<string, string> {
  const secretEncrypted = "accessTokenEncrypted" in config && config.accessTokenEncrypted
    ? config.accessTokenEncrypted
    : config.apiKeyEncrypted;

  if (config.authType !== "none" && secretEncrypted) {
    const secret = decryptSecret(secretEncrypted, encryptionKey);
    if (config.authType === "bearer" || "accessTokenEncrypted" in config) {
      return { ...headers, Authorization: `Bearer ${secret}` };
    }

    return { ...headers, [config.apiKeyHeader ?? "x-api-key"]: secret };
  }

  return headers;
}

class GenericWebhookCrmAdapter implements CrmAdapter {
  buildRequest(args: Parameters<CrmAdapter["buildRequest"]>[0]) {
    const config = crmConfigSchema.parse(args.client.crmConfig) as GenericCrmConfig;
    const headers = withAuthHeaders(config, args.encryptionKey, {
      "Content-Type": "application/json",
      "Idempotency-Key": args.dedupeKey,
      ...(config.headers ?? {})
    });

    return {
      endpoint: config.endpoint,
      method: config.method ?? "POST",
      headers,
      payload: mapCrmPayload(config.fieldMap, buildSourcePayload(args.source)),
      timeoutMs: config.timeoutMs ?? 5_000,
      ...(config.externalIdPath ? { externalIdPath: config.externalIdPath } : {})
    };
  }
}

class ZohoCrmAdapter implements CrmAdapter {
  buildRequest(args: Parameters<CrmAdapter["buildRequest"]>[0]) {
    const config = providerCrmConfigSchema.parse(args.client.crmConfig) as ProviderCrmConfig;
    const moduleName = config.module ?? "Leads";
    const endpoint = config.endpoint ?? `https://www.zohoapis.com/crm/v2/${moduleName}`;
    const headers = withAuthHeaders({ ...config, authType: config.authType ?? "bearer" }, args.encryptionKey, {
      "Content-Type": "application/json",
      "Idempotency-Key": args.dedupeKey,
      ...(config.headers ?? {})
    });

    return {
      endpoint,
      method: config.method ?? "POST",
      headers,
      payload: { data: [mapCrmPayload(config.fieldMap, buildSourcePayload(args.source))] },
      timeoutMs: config.timeoutMs ?? 5_000,
      externalIdPath: config.externalIdPath ?? "data.0.details.id"
    };
  }
}

class HubSpotCrmAdapter implements CrmAdapter {
  buildRequest(args: Parameters<CrmAdapter["buildRequest"]>[0]) {
    const config = providerCrmConfigSchema.parse(args.client.crmConfig) as ProviderCrmConfig;
    const endpoint = config.endpoint ?? "https://api.hubapi.com/crm/v3/objects/contacts";
    const headers = withAuthHeaders({ ...config, authType: config.authType ?? "bearer" }, args.encryptionKey, {
      "Content-Type": "application/json",
      "Idempotency-Key": args.dedupeKey,
      ...(config.headers ?? {})
    });

    return {
      endpoint,
      method: config.method ?? "POST",
      headers,
      payload: { properties: mapCrmPayload(config.fieldMap, buildSourcePayload(args.source)) },
      timeoutMs: config.timeoutMs ?? 5_000,
      externalIdPath: config.externalIdPath ?? "id"
    };
  }
}

function getCrmAdapter(client: ClientRuntimeConfig): CrmAdapter {
  switch (client.crmType) {
    case "zoho":
      return new ZohoCrmAdapter();
    case "hubspot":
      return new HubSpotCrmAdapter();
    case "custom":
    default:
      return new GenericWebhookCrmAdapter();
  }
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
  const request = getCrmAdapter(args.client).buildRequest({
    client: args.client,
    source: {
      lead: args.lead,
      attributes: args.attributes
    },
    dedupeKey: args.dedupeKey,
    encryptionKey: args.encryptionKey
  });

  const response = await fetch(request.endpoint, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.payload),
    signal: AbortSignal.timeout(request.timeoutMs)
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
    request.externalIdPath && typeof body === "object" && body !== null
      ? (getPathValue(body as Record<string, unknown>, request.externalIdPath) as string | undefined)
      : undefined;

  return {
    statusCode: response.status,
    responseBody: body,
    ...(externalId ? { externalId } : {})
  };
}
