import { Job, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";

import {
  createAuditLog,
  db as defaultDb,
  toPrismaJson,
  type PrismaClient,
  upsertJobMirror
} from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { CrmPushJobData, JsonValue } from "@real-estate/types";
import { ExternalServiceError, crmPushFailedTotal, crmPushSuccessTotal, pushToCRM } from "@real-estate/utils";

import { WorkerQueues } from "../services/queue-runtime";
import { markJobComplete, markJobFailure, markJobProcessing, toClientRuntime } from "../services/runtime-helpers";

export async function processCrmPush(
  job: Job<CrmPushJobData>,
  deps: {
    db?: PrismaClient;
    logger: Logger;
    config: WorkerConfig;
    queues: WorkerQueues;
  }
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const attempts = job.attemptsMade + 1;
  await markJobProcessing(db, {
    clientId: job.data.clientId,
    leadId: job.data.leadId,
    queue: "crm",
    name: "crm_push",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts
  });

  const lead = await db.lead.findUnique({
    where: {
      id: job.data.leadId
    },
    include: {
      client: true,
      attributes: true
    }
  });

  if (!lead || lead.clientId !== job.data.clientId) {
    throw new UnrecoverableError("Lead not found for CRM push");
  }

  const attributes = Object.fromEntries(
    lead.attributes.map((attribute) => [attribute.key, attribute.value as JsonValue])
  );
  const client = toClientRuntime(lead.client);
  const requestPayload = {
    lead: {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source: lead.source,
      status: lead.status,
      score: lead.score,
      createdAt: lead.createdAt.toISOString()
    },
    attributes
  };

  try {
    await db.crmSync.upsert({
      where: {
        idempotencyKey: job.data.dedupeKey
      },
      create: {
        clientId: lead.clientId,
        leadId: lead.id,
        idempotencyKey: job.data.dedupeKey,
        status: "processing",
        requestPayload: toPrismaJson(requestPayload),
        attempts
      },
      update: {
        status: "processing",
        requestPayload: toPrismaJson(requestPayload),
        attempts,
        lastError: null
      }
    });

    const result = await pushToCRM({
      client,
      lead: {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: lead.source,
        status: lead.status,
        score: lead.score,
        createdAt: lead.createdAt
      },
      attributes,
      dedupeKey: job.data.dedupeKey,
      encryptionKey: deps.config.APP_ENCRYPTION_KEY
    });

    await db.$transaction(async (tx) => {
      await tx.crmSync.update({
        where: {
          idempotencyKey: job.data.dedupeKey
        },
        data: {
          status: "success",
          attempts,
          lastError: null,
          ...(result.responseBody ? { responsePayload: toPrismaJson(result.responseBody) } : {}),
          ...(result.externalId ? { externalId: result.externalId } : {})
        }
      });

      await createAuditLog(tx, {
        clientId: lead.clientId,
        actor: "system:worker",
        action: "crm.push",
        entity: "Lead",
        entityId: lead.id,
        metadata: {
          statusCode: result.statusCode,
          externalId: result.externalId
        }
      });
    });

    crmPushSuccessTotal.inc({ client_id: lead.clientId });
    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "crm",
      name: "crm_push",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts
    });
  } catch (error) {
    const crmError = error as Error;
    await db.crmSync.updateMany({
      where: {
        idempotencyKey: job.data.dedupeKey
      },
      data: {
        status: "failed",
        attempts,
        lastError: crmError.message
      }
    });
    crmPushFailedTotal.inc({ client_id: lead.clientId });
    await markJobFailure(
      db,
      deps.logger,
      {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "crm",
        name: "crm_push",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts
      },
      crmError
    );

    if (error instanceof ExternalServiceError && !error.retryable) {
      throw new UnrecoverableError(error.message);
    }

    throw error;
  }
}
