import { Job, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";

import { db as defaultDb, upsertJobMirror, type PrismaClient } from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { FollowupNoReplyJobData, JobTrace, SendMessageJobData } from "@real-estate/types";
import { buildJobDedupeKey, buildJobTrace, computeRetryMetadata, promptForState } from "@real-estate/utils";

import { WorkerQueues } from "../services/queue-runtime";
import { markJobComplete, markJobFailure, markJobProcessing } from "../services/runtime-helpers";

export async function processFollowup(
  job: Job<FollowupNoReplyJobData>,
  deps: {
    db?: PrismaClient;
    logger: Logger;
    config: WorkerConfig;
    queues: WorkerQueues;
    trace: JobTrace;
  }
): Promise<void> {
  const db = deps.db ?? defaultDb;
  const attempts = job.attemptsMade + 1;
  const retryMetadata = computeRetryMetadata({
    attemptsMade: attempts,
    maxAttempts: job.opts.attempts ?? 1,
    baseDelayMs: deps.config.queueRetryBackoffMs,
    maxDelayMs: deps.config.queueRetryBackoffMaxMs
  });

  await markJobProcessing(db, {
    clientId: job.data.clientId,
    leadId: job.data.leadId,
    queue: "followups",
    name: "followup_no_reply",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts,
    metadata: {
      retry: retryMetadata,
      workerName: "followup-worker"
    },
    trace: deps.trace
  });

  try {
    const conversation = await db.conversation.findUnique({
      where: {
        id: job.data.conversationId
      },
      include: {
        messages: {
          orderBy: {
            createdAt: "desc"
          },
          take: 1
        }
      }
    });

    if (!conversation || conversation.leadId !== job.data.leadId) {
      throw new UnrecoverableError("Conversation not found for follow-up");
    }

    if (conversation.state !== job.data.expectedState) {
      await markJobComplete(db, {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "followups",
        name: "followup_no_reply",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts,
        metadata: {
          retry: retryMetadata,
          workerName: "followup-worker"
        },
        trace: deps.trace
      });
      return;
    }

    const lastInbound = await db.message.findFirst({
      where: {
        conversationId: job.data.conversationId,
        direction: "inbound",
        createdAt: {
          gt: new Date(job.data.lastOutboundAt)
        }
      }
    });
    if (lastInbound) {
      await markJobComplete(db, {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "followups",
        name: "followup_no_reply",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts,
        metadata: {
          retry: retryMetadata,
          workerName: "followup-worker"
        },
        trace: deps.trace
      });
      return;
    }

    const sendJob: SendMessageJobData = {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      conversationId: job.data.conversationId,
      to: job.data.to,
      text: `Just following up. ${promptForState(job.data.expectedState)}`,
      dedupeKey: buildJobDedupeKey(["followup-message", job.data.conversationId, job.data.lastOutboundAt]),
      reason: "followup",
      trace: buildJobTrace(job.data.trace, {
        requestId: deps.trace.requestId,
        correlationId: deps.trace.correlationId,
        source: "worker",
        parentQueue: "followups",
        parentJobId: String(job.id)
      })
    };

    await upsertJobMirror(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "messages",
      name: "send_message",
      idempotencyKey: sendJob.dedupeKey,
      payload: sendJob,
      metadata: {
        queueName: "messages",
        source: "worker"
      },
      status: "queued",
      trace: deps.trace
    });
    await deps.queues.enqueueSendMessage(sendJob);

    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "followups",
      name: "followup_no_reply",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts,
      metadata: {
        retry: retryMetadata,
        workerName: "followup-worker"
      },
      trace: deps.trace
    });
  } catch (error) {
    await markJobFailure(
      db,
      deps.logger,
      {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "followups",
        name: "followup_no_reply",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts,
        metadata: {
          retry: retryMetadata,
          workerName: "followup-worker"
        },
        trace: deps.trace
      },
      error as Error
    );
    throw error;
  }
}
