import { Job, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";

import { db as defaultDb, upsertJobMirror, type PrismaClient } from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { buildJobDedupeKey, promptForState } from "@real-estate/utils";

import { WorkerQueues } from "../services/queue-runtime";
import { markJobComplete, markJobFailure, markJobProcessing } from "../services/runtime-helpers";

export async function processFollowup(
  job: Job<FollowupNoReplyJobData>,
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
    queue: "followups",
    name: "followup_no_reply",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts
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
        attempts
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
        attempts
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
      reason: "followup"
    };

    await upsertJobMirror(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "messages",
      name: "send_message",
      idempotencyKey: sendJob.dedupeKey,
      payload: sendJob,
      status: "queued"
    });
    await deps.queues.enqueueSendMessage(sendJob);

    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "followups",
      name: "followup_no_reply",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts
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
        attempts
      },
      error as Error
    );
    throw error;
  }
}
