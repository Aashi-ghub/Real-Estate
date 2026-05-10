import type { Logger } from "pino";
import { z } from "zod";

import {
  acquireAdvisoryLock,
  createAuditLog,
  db as defaultDb,
  isUniqueConstraintError,
  toPrismaJson,
  type PrismaClient,
  upsertJobMirror
} from "@real-estate/db";
import type { ApiConfig } from "@real-estate/config";
import type {
  AuthenticatedApiKey,
  ClientRuntimeConfig,
  ConversationContext,
  CrmPushJobData,
  GenericCrmConfig,
  JsonObject,
  JsonValue,
  LeadAttributeKey,
  NormalizedInboundMessage,
  SendMessageJobData,
  WhatsAppProvider
} from "@real-estate/types";
import {
  advanceState,
  buildJobDedupeKey,
  buildTenantIdempotencyKey,
  computeQualificationScore,
  hashApiKey,
  leadCreatedTotal,
  normalizeEmail,
  normalizePhoneE164,
  normalizeInboundMessage,
  parseWhatsAppConfig,
  sanitizeFreeText,
  sanitizeJsonValue,
  setQualificationRate,
  verifyWebhookSignature
} from "@real-estate/utils";

import { QueuePublisher } from "./queue-publisher";

const createLeadBodySchema = z.object({
  client_id: z.string().uuid(),
  name: z.string().min(1).max(160),
  phone: z.string().min(8).max(32),
  email: z.string().email().max(255).optional(),
  source: z.string().min(1).max(100),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const inboundBodySchema = z.record(z.string(), z.unknown());
const interactiveTransactionOptions = {
  isolationLevel: "Serializable" as const,
  maxWait: 10_000,
  timeout: 15_000
};

function asConversationContext(value: unknown): ConversationContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as ConversationContext;
}

function detectProvider(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>
): WhatsAppProvider {
  if ("x-twilio-signature" in headers || "MessageSid" in body) {
    return "twilio";
  }

  if ("x-hub-signature-256" in headers || "entry" in body) {
    return "meta";
  }

  throw new Error("Unable to determine webhook provider");
}

export class LeadService {
  constructor(
    private readonly db: PrismaClient = defaultDb,
    private readonly queues: QueuePublisher,
    private readonly config: ApiConfig,
    private readonly logger: Logger
  ) {}

  async authenticateApiKey(apiKey: string): Promise<AuthenticatedApiKey | null> {
    const hashed = hashApiKey(apiKey, this.config.APP_ENCRYPTION_KEY);
    const record = await this.db.apiKey.findFirst({
      where: {
        hashedKey: hashed,
        status: "active"
      },
      select: {
        id: true,
        clientId: true,
        client: {
          select: {
            status: true
          }
        }
      }
    });

    if (!record) {
      return null;
    }

    await this.db.apiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() }
    });

    return {
      id: record.id,
      clientId: record.clientId,
      clientStatus: record.client.status
    };
  }

  async enforceRateLimit(subject: string): Promise<void> {
    const windowKey = `rate_limit:${subject}:${Math.floor(Date.now() / 60_000)}`;
    const count = await this.queues.redis.incr(windowKey);
    if (count === 1) {
      await this.queues.redis.expire(windowKey, 60);
    }

    if (count > this.config.API_RATE_LIMIT_PER_MINUTE) {
      const error = new Error("Rate limit exceeded");
      (error as Error & { statusCode?: number }).statusCode = 429;
      throw error;
    }
  }

  async createLead(input: {
    auth: AuthenticatedApiKey;
    idempotencyKey: string;
    body: unknown;
  }): Promise<{ leadId: string; created: boolean }> {
    const body = createLeadBodySchema.parse(input.body);
    if (body.client_id !== input.auth.clientId) {
      const error = new Error("API key does not match client_id");
      (error as Error & { statusCode?: number }).statusCode = 403;
      throw error;
    }

    if (input.auth.clientStatus !== "active") {
      const error = new Error("Client is paused");
      (error as Error & { statusCode?: number }).statusCode = 403;
      throw error;
    }

    const normalizedPhone = normalizePhoneE164(body.phone);
    const normalizedEmail = normalizeEmail(body.email ?? null);
    const storedIdempotencyKey = buildTenantIdempotencyKey(body.client_id, input.idempotencyKey);

    try {
      const result = await this.db.$transaction(
        async (tx) => {
          const existing = await tx.lead.findUnique({
            where: {
              idempotencyKey: storedIdempotencyKey
            },
            include: {
              conversation: true
            }
          });

          if (existing?.conversation) {
            return {
              leadId: existing.id,
              conversationId: existing.conversation.id,
              created: false,
              phone: existing.phone
            };
          }

          const lead = await tx.lead.create({
            data: {
              clientId: body.client_id,
              name: sanitizeFreeText(body.name, 160),
              phone: normalizedPhone,
              email: normalizedEmail,
              source: sanitizeFreeText(body.source, 100),
              idempotencyKey: storedIdempotencyKey,
              ...(body.metadata ? { metadata: toPrismaJson(sanitizeJsonValue(body.metadata)) } : {}),
              conversation: {
                create: {
                  channel: "whatsapp",
                  state: "INIT",
                  context: toPrismaJson({ responseCount: 0 } satisfies JsonObject)
                }
              }
            },
            include: {
              conversation: true
            }
          });

          await createAuditLog(tx, {
            clientId: body.client_id,
            actor: `api_key:${input.auth.id}`,
            action: "lead.create",
            entity: "Lead",
            entityId: lead.id,
            metadata: {
              phone: normalizedPhone,
              email: normalizedEmail,
              source: body.source
            }
          });

          return {
            leadId: lead.id,
            conversationId: lead.conversation!.id,
            created: true,
            phone: lead.phone
          };
        },
        interactiveTransactionOptions
      );

      if (result.created) {
        const dedupeKey = buildJobDedupeKey(["intro", result.conversationId]);
        const job: SendMessageJobData = {
          clientId: body.client_id,
          leadId: result.leadId,
          conversationId: result.conversationId,
          to: result.phone,
          text: "Hi, thanks for your interest in our properties. I will ask a few quick questions to match the right options. What budget range are you considering?",
          dedupeKey,
          reason: "intro",
          transitionAfterSend: "ASK_BUDGET"
        };

        await upsertJobMirror(this.db, {
          clientId: body.client_id,
          leadId: result.leadId,
          queue: "messages",
          name: "send_message",
          idempotencyKey: dedupeKey,
          payload: job,
          status: "queued"
        });
        await this.queues.enqueueSendMessage(job);
        leadCreatedTotal.inc({ client_id: body.client_id });
        await this.refreshQualificationRate(body.client_id);
      }

      return {
        leadId: result.leadId,
        created: result.created
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.db.lead.findUnique({
          where: { idempotencyKey: storedIdempotencyKey }
        });
        if (existing) {
          return {
            leadId: existing.id,
            created: false
          };
        }
      }

      throw error;
    }
  }

  async handleInboundWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    rawBody: string;
    requestUrl: string;
  }): Promise<{ status: "processed" | "duplicate" | "ignored"; leadId?: string }> {
    const parsedBody = inboundBodySchema.parse(input.body);
    const provider = detectProvider(input.headers, parsedBody);
    const normalized = normalizeInboundMessage({
      provider,
      body: parsedBody
    });

    const client = await this.resolveClientForInbound(provider, normalized);
    const clientRuntime = this.toClientRuntime(client);
    const signatureValid = verifyWebhookSignature({
      provider,
      headers: input.headers,
      rawBody: input.rawBody,
      requestUrl: this.config.WEBHOOK_BASE_URL,
      parsedBody,
      config: clientRuntime.whatsappConfig,
      encryptionKey: this.config.APP_ENCRYPTION_KEY,
      fallbackTwilioAuthToken: this.config.TWILIO_AUTH_TOKEN
    });

    if (!signatureValid) {
      const error = new Error("Webhook signature verification failed");
      (error as Error & { statusCode?: number }).statusCode = 401;
      throw error;
    }

    const now = new Date();
    const outcome = await this.db.$transaction(
      async (tx) => {
        const lead = await tx.lead.findFirst({
          where: {
            clientId: client.id,
            phone: normalized.from
          },
          include: {
            attributes: true,
            conversation: true
          },
          orderBy: {
            updatedAt: "desc"
          }
        });

        if (!lead?.conversation) {
          await createAuditLog(tx, {
            clientId: client.id,
            actor: `webhook:${provider}`,
            action: "webhook.unmatched",
            entity: "Lead",
            entityId: normalized.from,
            metadata: {
              providerMessageId: normalized.providerMessageId,
              phone: normalized.from
            }
          });

          return { status: "ignored" as const };
        }

        await acquireAdvisoryLock(tx, `conversation:${lead.conversation.id}`);

        try {
          await tx.message.create({
            data: {
              conversationId: lead.conversation.id,
              direction: "inbound",
              content: normalized.text,
              providerMessageId: normalized.providerMessageId,
              status: "delivered",
              metadata: toPrismaJson({
                provider,
                raw: normalized.rawPayload
              })
            }
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            return { status: "duplicate" as const, leadId: lead.id };
          }

          throw error;
        }

        const currentContext = asConversationContext(lead.conversation.context);
        const responseLatencyMs = currentContext.lastOutboundAt
          ? now.getTime() - new Date(currentContext.lastOutboundAt).getTime()
          : null;
        const advance = advanceState(
          {
            id: lead.conversation.id,
            leadId: lead.id,
            state: lead.conversation.state,
            context: currentContext,
            lastMessageAt: lead.conversation.lastMessageAt
          },
          normalized.text
        );

        const attributeMap = new Map<LeadAttributeKey, JsonValue>(
          lead.attributes.map((attribute) => [attribute.key as LeadAttributeKey, attribute.value as JsonValue])
        );
        for (const attribute of advance.attributesToUpsert) {
          attributeMap.set(attribute.key, attribute.value);
          await tx.leadAttribute.upsert({
            where: {
              leadId_key: {
                leadId: lead.id,
                key: attribute.key
              }
            },
            create: {
              leadId: lead.id,
              key: attribute.key,
              value: toPrismaJson(attribute.value)
            },
            update: {
              value: toPrismaJson(attribute.value)
            }
          });
        }

        const nextContext: ConversationContext = {
          ...currentContext,
          lastInboundAt: now.toISOString(),
          responseCount: (currentContext.responseCount ?? 0) + 1,
          ...(typeof responseLatencyMs === "number" ? { lastResponseLatencyMs: responseLatencyMs } : {}),
          ...(advance.nextState === "QUALIFIED"
            ? { qualifiedAt: now.toISOString() }
            : currentContext.qualifiedAt
              ? { qualifiedAt: currentContext.qualifiedAt }
              : {})
        };

        const score =
          advance.nextState === "QUALIFIED"
            ? computeQualificationScore({
                timeline: advance.parsedAnswers.timeline,
                responseLatencyMs,
                completenessCount: attributeMap.size
              })
            : lead.score;

        await tx.lead.update({
          where: { id: lead.id },
          data: {
            status: advance.nextState === "QUALIFIED" ? "qualified" : lead.status === "new" ? "contacted" : lead.status,
            score
          }
        });

        await tx.conversation.update({
          where: { id: lead.conversation.id },
          data: {
            state: advance.nextState,
            context: toPrismaJson(nextContext),
            lastMessageAt: now
          }
        });

        await createAuditLog(tx, {
          clientId: client.id,
          actor: `webhook:${provider}`,
          action: "message.inbound",
          entity: "Conversation",
          entityId: lead.conversation.id,
          metadata: {
            leadId: lead.id,
            providerMessageId: normalized.providerMessageId,
            nextState: advance.nextState,
            phone: normalized.from
          }
        });

        return {
          status: "processed" as const,
          leadId: lead.id,
          conversationId: lead.conversation.id,
          phone: lead.phone,
          nextState: advance.nextState,
          outboundMessage: advance.outboundMessage,
          qualifiedAt: nextContext.qualifiedAt
        };
      },
      interactiveTransactionOptions
    );

    if (outcome.status !== "processed") {
      return outcome;
    }

    if (outcome.outboundMessage) {
      const outboundDedupeKey = buildJobDedupeKey([
        "reply",
        outcome.conversationId,
        normalized.providerMessageId,
        outcome.nextState
      ]);

      const outboundJob: SendMessageJobData = {
        clientId: client.id,
        leadId: outcome.leadId,
        conversationId: outcome.conversationId,
        to: outcome.phone,
        text: outcome.outboundMessage,
        dedupeKey: outboundDedupeKey,
        reason: outcome.nextState === "QUALIFIED" ? "qualification_ack" : "prompt",
        ...(outcome.nextState === "QUALIFIED" ? {} : { transitionAfterSend: outcome.nextState })
      };

      await upsertJobMirror(this.db, {
        clientId: client.id,
        leadId: outcome.leadId,
        queue: "messages",
        name: "send_message",
        idempotencyKey: outboundDedupeKey,
        payload: outboundJob,
        status: "queued"
      });
      await this.queues.enqueueSendMessage(outboundJob);
    }

    if (outcome.nextState === "QUALIFIED" && outcome.qualifiedAt) {
      const qualifiedAt = outcome.qualifiedAt;
      const crmJob: CrmPushJobData = {
        clientId: client.id,
        leadId: outcome.leadId,
        conversationId: outcome.conversationId,
        dedupeKey: buildJobDedupeKey(["crm", outcome.leadId, qualifiedAt]),
        qualifiedAt
      };

      await upsertJobMirror(this.db, {
        clientId: client.id,
        leadId: outcome.leadId,
        queue: "crm",
        name: "crm_push",
        idempotencyKey: crmJob.dedupeKey,
        payload: crmJob,
        status: "queued"
      });
      await this.queues.enqueueCrmPush(crmJob);
      await this.enqueueAgentNotification(clientRuntime, {
        leadId: outcome.leadId,
        conversationId: outcome.conversationId,
        qualifiedAt
      });
      await this.refreshQualificationRate(client.id);
    }

    return {
      status: "processed",
      leadId: outcome.leadId
    };
  }

  async healthCheck(): Promise<{ ok: true; postgres: string; redis: string; queues: string }> {
    await this.db.$queryRaw`SELECT 1`;
    await this.queues.healthCheck();
    return {
      ok: true,
      postgres: "up",
      redis: "up",
      queues: "up"
    };
  }

  private async resolveClientForInbound(
    provider: WhatsAppProvider,
    normalized: NormalizedInboundMessage
  ) {
    if (normalized.clientId) {
      const client = await this.db.client.findUnique({
        where: { id: normalized.clientId }
      });
      if (client) {
        return client;
      }
    }

    const client = await this.db.client.findFirst({
      where: {
        status: "active",
        whatsappProvider: provider,
        OR: [
          {
            whatsappConfig: {
              path: ["fromNumber"],
              equals: normalized.to
            }
          },
          {
            whatsappConfig: {
              path: ["fromNumber"],
              equals: `whatsapp:${normalized.to}`
            }
          }
        ]
      }
    });

    if (!client) {
      const error = new Error("No active client matched inbound webhook");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    return client;
  }

  private toClientRuntime(client: {
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

  private async enqueueAgentNotification(
    client: ClientRuntimeConfig,
    payload: {
      leadId: string;
      conversationId: string;
      qualifiedAt: string;
    }
  ): Promise<void> {
    const agentPhone =
      "agentNotificationPhone" in client.whatsappConfig ? client.whatsappConfig.agentNotificationPhone : null;
    if (!agentPhone) {
      this.logger.warn({ clientId: client.id }, "Skipping agent notification because agentNotificationPhone is not configured");
      return;
    }

    const job: SendMessageJobData = {
      clientId: client.id,
      leadId: payload.leadId,
      conversationId: payload.conversationId,
      to: normalizePhoneE164(agentPhone),
      text: `Qualified lead ${payload.leadId} is ready for follow-up.`,
      dedupeKey: buildJobDedupeKey(["agent", payload.leadId, payload.qualifiedAt]),
      reason: "agent_notification"
    };

    await upsertJobMirror(this.db, {
      clientId: client.id,
      leadId: payload.leadId,
      queue: "messages",
      name: "send_message",
      idempotencyKey: job.dedupeKey,
      payload: job,
      status: "queued"
    });
    await this.queues.enqueueSendMessage(job);
  }

  private async refreshQualificationRate(clientId: string): Promise<void> {
    const [total, qualified] = await Promise.all([
      this.db.lead.count({
        where: { clientId }
      }),
      this.db.lead.count({
        where: {
          clientId,
          status: "qualified"
        }
      })
    ]);

    setQualificationRate(clientId, total === 0 ? 0 : qualified / total);
  }
}
