import type { Logger } from "pino";

import { toPrismaJson, upsertJobMirror, type PrismaClient } from "@real-estate/db";
import type {
  ClientRuntimeConfig,
  ConversationContext,
  GenericCrmConfig,
  JsonValue,
  TraceContext,
  WhatsAppProvider
} from "@real-estate/types";
import { sanitizeJsonValue, parseWhatsAppConfig } from "@real-estate/utils";

export function asConversationContext(value: unknown): ConversationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as ConversationContext;
}

export function toClientRuntime(client: {
  id: string;
  name: string;
  timezone: string;
  status: string;
  whatsappProvider: WhatsAppProvider;
  whatsappConfig: unknown;
  crmType: string;
  crmConfig: unknown;
}): ClientRuntimeConfig {
  return {
    id: client.id,
    name: client.name,
    timezone: client.timezone,
    status: client.status as ClientRuntimeConfig["status"],
    whatsappProvider: client.whatsappProvider,
    whatsappConfig: parseWhatsAppConfig(client.whatsappProvider, client.whatsappConfig as JsonValue),
    crmType: client.crmType as ClientRuntimeConfig["crmType"],
    crmConfig: client.crmConfig as unknown as GenericCrmConfig
  };
}

export async function markJobProcessing(
  db: PrismaClient,
  job: {
    clientId: string;
    leadId?: string;
    queue: string;
    name: string;
    dedupeKey: string;
    payload: unknown;
    attempts: number;
    trace?: TraceContext;
    metadata?: unknown;
  }
): Promise<void> {
  await upsertJobMirror(db, {
    clientId: job.clientId,
    leadId: job.leadId,
    queue: job.queue,
    name: job.name,
    idempotencyKey: job.dedupeKey,
    payload: sanitizeJsonValue(job.payload),
    metadata: job.metadata,
    status: "processing",
    attempts: job.attempts,
    trace: job.trace
  });
}

export async function markJobComplete(
  db: PrismaClient,
  job: {
    clientId: string;
    leadId?: string;
    queue: string;
    name: string;
    dedupeKey: string;
    payload: unknown;
    attempts: number;
    trace?: TraceContext;
    metadata?: unknown;
  }
): Promise<void> {
  await upsertJobMirror(db, {
    clientId: job.clientId,
    leadId: job.leadId,
    queue: job.queue,
    name: job.name,
    idempotencyKey: job.dedupeKey,
    payload: sanitizeJsonValue(job.payload),
    metadata: job.metadata,
    status: "completed",
    attempts: job.attempts,
    processedAt: new Date(),
    lastError: null,
    trace: job.trace
  });
}

export async function markJobFailure(
  db: PrismaClient,
  logger: Logger,
  job: {
    clientId: string;
    leadId?: string;
    queue: string;
    name: string;
    dedupeKey: string;
    payload: unknown;
    attempts: number;
    trace?: TraceContext;
    metadata?: unknown;
  },
  error: Error,
  status: "failed" | "dead_letter" = "failed"
): Promise<void> {
  logger.error({ err: error, dedupeKey: job.dedupeKey, queue: job.queue }, "worker.job.failed");
  await upsertJobMirror(db, {
    clientId: job.clientId,
    leadId: job.leadId,
    queue: job.queue,
    name: job.name,
    idempotencyKey: job.dedupeKey,
    payload: sanitizeJsonValue(job.payload),
    metadata: job.metadata,
    status,
    attempts: job.attempts,
    processedAt: new Date(),
    lastError: error.message,
    trace: job.trace
  });
}

export function toSafeJson(value: unknown): JsonValue {
  return sanitizeJsonValue(value);
}

export function toJson(value: JsonValue) {
  return toPrismaJson(value);
}
