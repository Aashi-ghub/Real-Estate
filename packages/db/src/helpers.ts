import { sanitizeJsonValue } from "@real-estate/utils";

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
  }
): Promise<void> {
  await db.auditLog.create({
    data: {
      clientId: entry.clientId ?? null,
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
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
    status?: "queued" | "processing" | "completed" | "failed" | "dead_letter";
    attempts?: number;
    scheduledAt?: Date | null;
    processedAt?: Date | null;
    lastError?: string | null;
  }
): Promise<void> {
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
      payload: toPrismaJson(input.payload),
      status: input.status ?? "queued",
      attempts: input.attempts ?? 0,
      scheduledAt: input.scheduledAt ?? null,
      processedAt: input.processedAt ?? null,
      lastError: input.lastError ?? null
    },
    update: {
      payload: toPrismaJson(input.payload),
      ...(input.status ? { status: input.status } : {}),
      ...(typeof input.attempts === "number" ? { attempts: input.attempts } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.processedAt !== undefined ? { processedAt: input.processedAt } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {})
    }
  });
}
