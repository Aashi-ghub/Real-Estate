import { Job, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";

import {
  acquireAdvisoryLock,
  createAuditLog,
  db as defaultDb,
  toPrismaJson,
  type PrismaClient,
  upsertJobMirror
} from "@real-estate/db";
import type { WorkerConfig } from "@real-estate/config";
import type { ConversationState, SendMessageJobData } from "@real-estate/types";
import {
  ExternalServiceError,
  buildJobDedupeKey,
  messagesFailedTotal,
  messagesSentTotal,
  sendMessage
} from "@real-estate/utils";
import { normalizePhoneE164 } from "@real-estate/utils";

import { WorkerQueues } from "../services/queue-runtime";
import {
  asConversationContext,
  markJobComplete,
  markJobFailure,
  markJobProcessing,
  toClientRuntime
} from "../services/runtime-helpers";

export async function processSendMessage(
  job: Job<SendMessageJobData>,
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
    queue: "messages",
    name: "send_message",
    dedupeKey: job.data.dedupeKey,
    payload: job.data,
    attempts
  });

  const conversation = await db.conversation.findUnique({
    where: {
      id: job.data.conversationId
    },
    include: {
      lead: {
        include: {
          client: true
        }
      }
    }
  });

  if (!conversation || conversation.leadId !== job.data.leadId || conversation.lead.clientId !== job.data.clientId) {
    throw new UnrecoverableError("Conversation, lead, or client was not found for outbound message");
  }

  await db.$transaction(async (tx) => {
    await acquireAdvisoryLock(tx, `message:${job.data.dedupeKey}`);
    const existing = await tx.message.findUnique({
      where: {
        dedupeKey: job.data.dedupeKey
      }
    });

    if (!existing) {
      await tx.message.create({
        data: {
          conversationId: job.data.conversationId,
          direction: "outbound",
          content: job.data.text,
          dedupeKey: job.data.dedupeKey,
          status: "queued",
          metadata: toPrismaJson({
            reason: job.data.reason
          })
        }
      });
    }
  });

  const placeholder = await db.message.findUnique({
    where: {
      dedupeKey: job.data.dedupeKey
    }
  });
  if (placeholder?.providerMessageId && placeholder.status !== "failed") {
    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "messages",
      name: "send_message",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts
    });
    return;
  }

  try {
    const clientRuntime = toClientRuntime(conversation.lead.client);
    const sendResult = await sendMessage({
      client: clientRuntime,
      to: normalizePhoneE164(job.data.to),
      text: job.data.text,
      encryptionKey: deps.config.APP_ENCRYPTION_KEY,
      fallbackTwilioAccountSid: deps.config.TWILIO_ACCOUNT_SID,
      fallbackTwilioAuthToken: deps.config.TWILIO_AUTH_TOKEN,
      fallbackTwilioFrom: deps.config.TWILIO_WHATSAPP_FROM
    });

    const now = new Date();
    await db.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, `message:${job.data.dedupeKey}`);
      const updatedMessage = await tx.message.update({
        where: {
          dedupeKey: job.data.dedupeKey
        },
        data: {
          providerMessageId: sendResult.providerMessageId,
          status: "sent",
          metadata: toPrismaJson({
            reason: job.data.reason,
            sentAt: now.toISOString()
          })
        }
      });

      const currentConversation = await tx.conversation.findUnique({
        where: {
          id: job.data.conversationId
        }
      });
      const context = asConversationContext(currentConversation?.context);
      const nextState = job.data.transitionAfterSend ?? currentConversation?.state;
      await tx.conversation.update({
        where: {
          id: job.data.conversationId
        },
        data: {
          state: nextState,
          lastMessageAt: now,
          context: toPrismaJson({
            ...context,
            lastOutboundAt: now.toISOString(),
            lastPromptState: nextState
          })
        }
      });

      await createAuditLog(tx, {
        clientId: job.data.clientId,
        actor: "system:worker",
        action: "message.outbound",
        entity: "Message",
        entityId: updatedMessage.id,
        metadata: {
          leadId: job.data.leadId,
          reason: job.data.reason,
          to: job.data.to,
          providerMessageId: sendResult.providerMessageId
        }
      });
    });

    messagesSentTotal.inc({
      client_id: job.data.clientId,
      reason: job.data.reason
    });
    await markJobComplete(db, {
      clientId: job.data.clientId,
      leadId: job.data.leadId,
      queue: "messages",
      name: "send_message",
      dedupeKey: job.data.dedupeKey,
      payload: job.data,
      attempts
    });

    if (
      job.data.reason !== "followup" &&
      job.data.reason !== "qualification_ack" &&
      job.data.reason !== "agent_notification"
    ) {
      const followupState = job.data.transitionAfterSend;
      if (followupState && followupState !== "QUALIFIED" && followupState !== "INIT") {
        await scheduleFollowup(deps.queues, deps.config, {
          db,
          clientId: job.data.clientId,
          leadId: job.data.leadId,
          conversationId: job.data.conversationId,
          to: job.data.to,
          state: followupState,
          lastOutboundAt: now
        });
      }
    }
  } catch (error) {
    const outboundError = error as Error;
    messagesFailedTotal.inc({
      client_id: job.data.clientId,
      reason: job.data.reason
    });
    await db.message.updateMany({
      where: {
        dedupeKey: job.data.dedupeKey
      },
      data: {
        status: "failed",
        metadata: toPrismaJson({
          reason: job.data.reason,
          error: outboundError.message
        })
      }
    });
    await markJobFailure(
      db,
      deps.logger,
      {
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        queue: "messages",
        name: "send_message",
        dedupeKey: job.data.dedupeKey,
        payload: job.data,
        attempts
      },
      outboundError
    );

    if (error instanceof ExternalServiceError && !error.retryable) {
      throw new UnrecoverableError(error.message);
    }

    throw error;
  }
}

async function scheduleFollowup(
  queues: WorkerQueues,
  config: WorkerConfig,
  input: {
    db: PrismaClient;
    clientId: string;
    leadId: string;
    conversationId: string;
    to: string;
    state: Exclude<ConversationState, "INIT" | "QUALIFIED">;
    lastOutboundAt: Date;
  }
): Promise<void> {
  const dedupeKey = buildJobDedupeKey([
    "followup",
    input.conversationId,
    input.state,
    input.lastOutboundAt.toISOString()
  ]);

  await queues.enqueueFollowup(
    {
      clientId: input.clientId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      to: input.to,
      dedupeKey,
      expectedState: input.state,
      lastOutboundAt: input.lastOutboundAt.toISOString()
    },
    config.FOLLOWUP_DELAY_MINUTES * 60_000
  );
  await upsertJobMirror(input.db, {
    clientId: input.clientId,
    leadId: input.leadId,
    queue: "followups",
    name: "followup_no_reply",
    idempotencyKey: dedupeKey,
    payload: {
      clientId: input.clientId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      to: input.to,
      expectedState: input.state,
      lastOutboundAt: input.lastOutboundAt.toISOString()
    },
    status: "queued",
    scheduledAt: new Date(input.lastOutboundAt.getTime() + config.FOLLOWUP_DELAY_MINUTES * 60_000)
  });
}
