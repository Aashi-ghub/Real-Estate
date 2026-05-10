import { sanitizeJsonValue } from "@real-estate/utils";
import type { TraceContext } from "@real-estate/types";

import { Prisma, type PrismaClient } from "./generated";

export type DbExecutor = PrismaClient | Prisma.TransactionClient;

export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return sanitizeJsonValue(value) as Prisma.InputJsonValue;
}

export async function acquireAdvisoryLock(db: DbExecutor, key: string): Promise<void> {
  await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

export async function createAuditLog(
  db: DbExecutor,
  entry: {
    clientId?: string | null;
    actor: string;
    action: string;
    entity: string;
    entityId: string;
    metadata: unknown;
    trace?: TraceContext;
  }
): Promise<void> {
  await db.auditLog.create({
    data: {
      clientId: entry.clientId ?? null,
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      requestId: entry.trace?.requestId ?? null,
      correlationId: entry.trace?.correlationId ?? null,
      metadata: toPrismaJson(entry.metadata)
    }
  });
}

export async function upsertJobMirror(
  db: DbExecutor,
  input: {
    clientId: string;
    leadId?: string | null;
    queue: string;
    name: string;
    idempotencyKey: string;
    payload: unknown;
    metadata?: unknown;
    status?: "queued" | "processing" | "completed" | "failed" | "dead_letter";
    attempts?: number;
    scheduledAt?: Date | null;
    processedAt?: Date | null;
    lastError?: string | null;
    trace?: TraceContext;
  }
): Promise<void> {
  const metadataValue =
    input.metadata === undefined ? undefined : input.metadata === null ? Prisma.JsonNull : toPrismaJson(input.metadata);

  await db.job.upsert({
    where: {
      idempotencyKey: input.idempotencyKey
    },
    create: {
      clientId: input.clientId,
      leadId: input.leadId ?? null,
      queue: input.queue,
      name: input.name,
      idempotencyKey: input.idempotencyKey,
      requestId: input.trace?.requestId ?? null,
      correlationId: input.trace?.correlationId ?? null,
      payload: toPrismaJson(input.payload),
      ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
      status: input.status ?? "queued",
      attempts: input.attempts ?? 0,
      scheduledAt: input.scheduledAt ?? null,
      processedAt: input.processedAt ?? null,
      lastError: input.lastError ?? null
    },
    update: {
      requestId: input.trace?.requestId ?? null,
      correlationId: input.trace?.correlationId ?? null,
      payload: toPrismaJson(input.payload),
      ...(metadataValue !== undefined ? { metadata: metadataValue } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(typeof input.attempts === "number" ? { attempts: input.attempts } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.processedAt !== undefined ? { processedAt: input.processedAt } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {})
    }
  });
}
