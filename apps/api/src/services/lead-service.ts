import { performance } from "node:perf_hooks";

import type { Logger } from "pino";
import { z } from "zod";

import {
  acquireAdvisoryLock,
  createAuditLog,
  db as defaultDb,
  isUniqueConstraintError,
  Prisma,
  toPrismaJson,
  type PrismaClient,
  upsertJobMirror
} from "@real-estate/db";
import type { ApiConfig } from "@real-estate/config";
import type {
  AuthenticatedApiKey,
  AuthenticatedUser,
  AiLeadIntelligenceJobData,
  ClientRuntimeConfig,
  ConversationContext,
  CrmPushJobData,
  GenericCrmConfig,
  JsonObject,
  JsonValue,
  LeadAttributeKey,
  NormalizedInboundMessage,
  SendMessageJobData,
  TraceContext,
  TenantUsageMetric,
  WhatsAppProvider
} from "@real-estate/types";
import {
  advanceState,
  buildJobTrace,
  buildJobDedupeKey,
  buildTenantIdempotencyKey,
  computeLeadScore,
  computeQualificationCompleteness,
  computeWorkerSaturation,
  calculateSloCompliance,
  classifyChaosRecovery,
  detectCostAnomaly,
  evaluateDrift,
  feedbackAcceptanceScore,
  generateApiKey,
  generateRefreshToken,
  getApiKeyPrefix,
  hashApiKey,
  hashRefreshToken,
  signJwt,
  incrementWebhookFailure,
  leadCreatedTotal,
  normalizeEmail,
  normalizePhoneE164,
  normalizeInboundMessage,
  observeRetrievalLatency,
  observeWebhookProcessingLatency,
  parseWhatsAppConfig,
  sanitizeFreeText,
  sanitizeJsonValue,
  verifyJwt,
  verifyPassword,
  setQualificationRate,
  stableHash,
  rankRetrievalCandidates,
  scoreRetrievalRanking,
  promptEfficiencyScore,
  verifyWebhookSignature
} from "@real-estate/utils";
import { withLogContext } from "@real-estate/logger";

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
const dashboardListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(),
  priority: z.enum(["HOT", "WARM", "COLD"]).optional(),
  source: z.string().max(100).optional(),
  search: z.string().max(100).optional(),
  sort: z.enum(["created_at", "updated_at", "score", "qualification"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc")
});
const dashboardFollowupSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["scheduled", "sent", "cancelled", "skipped", "failed"]).optional()
});
const memoryRetrievalSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  min_relevance: z.coerce.number().min(0).max(1).default(0.35),
  max_age_days: z.coerce.number().int().min(1).max(3650).default(365)
});
const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(256)
});
const refreshSchema = z.object({
  refresh_token: z.string().min(32)
});
const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1).max(120)).default(["leads:write"]),
  expires_at: z.string().datetime().optional()
});
const listAuditSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().max(120).optional(),
  entity: z.string().max(120).optional(),
  request_id: z.string().max(128).optional()
});
const adminListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  client_id: z.string().uuid().optional(),
  queue: z.string().max(64).optional(),
  status: z.string().max(40).optional()
});
const replaySchema = z.object({
  job_id: z.string().min(1).max(255),
  queue: z.string().min(1).max(64)
});
const createEvaluationDatasetSchema = z.object({
  client_id: z.string().uuid().optional(),
  name: z.string().min(1).max(160),
  dataset_type: z.enum([
    "semantic_extraction",
    "emotional_inference",
    "intent_prediction",
    "multilingual_understanding",
    "memory_retrieval",
    "summarization",
    "recommendation",
    "behavioral_accuracy",
    "hallucination_safety",
    "retrieval_quality"
  ]),
  version: z.string().min(1).max(40),
  examples: z.array(z.record(z.string(), z.unknown())).min(1).max(1_000),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const createEvaluationRunSchema = z.object({
  client_id: z.string().uuid().optional(),
  dataset_id: z.string().uuid().optional(),
  run_type: createEvaluationDatasetSchema.shape.dataset_type,
  model_version: z.string().min(1).max(120).default("rules-v1"),
  prompt_version: z.string().max(80).optional(),
  baseline_run_id: z.string().uuid().optional(),
  concurrency_limit: z.coerce.number().int().min(1).max(16).default(1)
});
const feedbackEventSchema = z.object({
  client_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  event_type: z.enum([
    "recommendation_accepted",
    "recommendation_rejected",
    "summary_corrected",
    "prediction_corrected",
    "extraction_corrected"
  ]),
  target_type: z.string().min(1).max(80),
  target_id: z.string().min(1).max(120),
  original_value: z.unknown(),
  corrected_value: z.unknown().optional()
});
const intelligenceQuerySchema = z.object({
  client_id: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30)
});
const sloDefinitionSchema = z.object({
  client_id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  target_type: z.enum(["api_latency", "webhook_latency", "ai_latency", "queue_throughput", "retrieval_latency"]),
  target: z.number().min(0.5).max(0.9999),
  window_minutes: z.number().int().min(1).max(43_200),
  threshold: z.record(z.string(), z.unknown()).default({})
});
const sloEvaluateSchema = z.object({
  client_id: z.string().uuid().optional(),
  slo_definition_id: z.string().uuid(),
  good_events: z.number().int().min(0),
  total_events: z.number().int().min(1),
  previous_burn_rate: z.number().min(0).optional(),
  correlation: z.record(z.string(), z.unknown()).default({})
});
const chaosLogSchema = z.object({
  client_id: z.string().uuid().optional(),
  scenario_type: z.enum(["redis_slowdown", "postgres_slowdown", "queue_corruption", "worker_crash", "malformed_embedding", "benchmark_corruption", "ai_provider_outage"]),
  operational_queue_impacted: z.boolean().default(false),
  fallback_activated: z.boolean().default(true),
  recovered: z.boolean().default(true),
  input: z.unknown().optional()
});
const interactiveTransactionOptions = {
  isolationLevel: "Serializable" as const,
  maxWait: 10_000,
  timeout: 15_000
};

function observeBackgroundTask(logger: Logger, name: string, task: Promise<unknown>, metadata: Record<string, unknown>): void {
  void task.catch((error) => {
    logger.error({ err: error, ...metadata }, name);
  });
}

type OptionalPhase2Delegates = {
  leadScore?: {
    create(args: unknown): Promise<unknown>;
  };
  followUp?: {
    updateMany(args: unknown): Promise<unknown>;
  };
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
    const prefix = getApiKeyPrefix(apiKey);
    const record = await this.db.apiKey.findFirst({
      where: {
        OR: [
          { hashedKey: hashed },
          ...(prefix ? [{ prefix, hashedKey: hashed }] : [])
        ]
      },
      select: {
        id: true,
        clientId: true,
        prefix: true,
        scopes: true,
        expiresAt: true,
        status: true,
        client: {
          select: {
            status: true
          }
        }
      }
    });

    if (!record || record.status !== "active" || (record.expiresAt && record.expiresAt <= new Date())) {
      return null;
    }

    observeBackgroundTask(
      this.logger,
      "api_key.last_used.update_failed",
      this.db.apiKey.update({
        where: { id: record.id },
        data: {
          lastUsedAt: new Date(),
          usageCount: {
            increment: 1
          }
        }
      }),
      { apiKeyId: record.id, clientId: record.clientId }
    );

    return {
      id: record.id,
      clientId: record.clientId,
      clientStatus: record.client.status,
      scopes: record.scopes ?? [],
      prefix: record.prefix
    };
  }

  async authenticateJwt(accessToken: string): Promise<AuthenticatedUser | null> {
    try {
      const payload = verifyJwt(accessToken, this.config.jwtSecret);
      const user = await this.db.user.findFirst({
        where: {
          id: payload.sub,
          status: "active"
        },
        select: {
          id: true,
          clientId: true,
          roles: {
            select: {
              role: {
                select: {
                  name: true,
                  permissions: {
                    select: {
                      permission: {
                        select: { key: true }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      });
      if (!user) {
        return null;
      }

      const roles = user.roles.map((entry) => entry.role.name);
      const permissions = Array.from(new Set(user.roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.permission.key))));
      return {
        id: user.id,
        clientId: user.clientId,
        roles,
        permissions,
        sessionId: payload.sessionId
      };
    } catch {
      return null;
    }
  }

  async login(input: { body: unknown; ipAddress?: string; userAgent?: string; trace: TraceContext }) {
    const body = loginSchema.parse(input.body);
    const user = await this.db.user.findUnique({
      where: { email: body.email.toLowerCase() },
      select: {
        id: true,
        clientId: true,
        passwordHash: true,
        status: true,
        roles: {
          select: {
            role: {
              select: {
                name: true,
                permissions: {
                  select: {
                    permission: {
                      select: { key: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!user || user.status !== "active" || !(await verifyPassword(body.password, user.passwordHash, this.config.APP_ENCRYPTION_KEY))) {
      await this.auditSecurityEvent({
        clientId: user?.clientId,
        actorType: "anonymous",
        action: "auth.login_denied",
        entity: "User",
        entityId: body.email,
        severity: "warn",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        trace: input.trace,
        metadata: {}
      });
      const error = new Error("Invalid credentials");
      (error as Error & { statusCode?: number }).statusCode = 401;
      throw error;
    }

    const roles = user.roles.map((entry) => entry.role.name);
    const permissions = Array.from(new Set(user.roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.permission.key))));
    const refreshToken = generateRefreshToken();
    const session = await this.db.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken, this.config.APP_ENCRYPTION_KEY),
        expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1_000),
        ipAddress: input.ipAddress?.slice(0, 64),
        userAgent: input.userAgent?.slice(0, 255)
      },
      select: { id: true }
    });

    await this.auditSecurityEvent({
      clientId: user.clientId,
      actorType: "user",
      actorId: user.id,
      action: "auth.login",
      entity: "RefreshSession",
      entityId: session.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      trace: input.trace,
      metadata: {}
    });

    return {
      access_token: signJwt(
        {
          sub: user.id,
          clientId: user.clientId,
          roles,
          permissions,
          sessionId: session.id
        },
        this.config.jwtSecret,
        this.config.jwtAccessTtlSeconds
      ),
      refresh_token: refreshToken,
      expires_in: this.config.jwtAccessTtlSeconds
    };
  }

  async refreshSession(input: { body: unknown; ipAddress?: string; userAgent?: string; trace: TraceContext }) {
    const body = refreshSchema.parse(input.body);
    const tokenHash = hashRefreshToken(body.refresh_token, this.config.APP_ENCRYPTION_KEY);
    const session = await this.db.refreshSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!session || session.status !== "active" || session.expiresAt <= new Date() || session.user.status !== "active") {
      const error = new Error("Invalid refresh token");
      (error as Error & { statusCode?: number }).statusCode = 401;
      throw error;
    }

    const refreshToken = generateRefreshToken();
    const newSession = await this.db.$transaction(async (tx) => {
      await tx.refreshSession.update({
        where: { id: session.id },
        data: { status: "revoked", revokedAt: new Date() }
      });
      return tx.refreshSession.create({
        data: {
          userId: session.userId,
          tokenHash: hashRefreshToken(refreshToken, this.config.APP_ENCRYPTION_KEY),
          expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1_000),
          ipAddress: input.ipAddress?.slice(0, 64),
          userAgent: input.userAgent?.slice(0, 255)
        },
        select: { id: true }
      });
    });
    const roles = session.user.roles.map((entry) => entry.role.name);
    const permissions = Array.from(new Set(session.user.roles.flatMap((entry) => entry.role.permissions.map((permission) => permission.permission.key))));

    return {
      access_token: signJwt(
        {
          sub: session.user.id,
          clientId: session.user.clientId,
          roles,
          permissions,
          sessionId: newSession.id
        },
        this.config.jwtSecret,
        this.config.jwtAccessTtlSeconds
      ),
      refresh_token: refreshToken,
      expires_in: this.config.jwtAccessTtlSeconds
    };
  }

  async auditUnauthorized(input: {
    clientId?: string | null;
    actorType: string;
    actorId?: string | null;
    action: string;
    entity?: string;
    entityId?: string | null;
    ipAddress?: string;
    userAgent?: string;
    trace: TraceContext;
  }): Promise<void> {
    await this.auditSecurityEvent({
      ...input,
      entity: input.entity ?? "Route",
      severity: "warn",
      metadata: {}
    });
  }

  async enforceRateLimit(
    subject: string,
    options: {
      limit: number;
      windowSeconds: number;
      clientId?: string | null;
    }
  ): Promise<void> {
    const bucket = Math.floor(Date.now() / (options.windowSeconds * 1_000));
    const windowKey = `rate_limit:${subject}:${bucket}`;
    const count = await this.queues.redis.incr(windowKey);
    if (count === 1) {
      await this.queues.redis.expire(windowKey, options.windowSeconds);
    }
    if ("rateLimitBucket" in this.db) {
      observeBackgroundTask(
        this.logger,
        "rate_limit.bucket_persist_failed",
        this.db.rateLimitBucket.upsert({
          where: {
            subject_windowKey: {
              subject: subject.slice(0, 180),
              windowKey: String(bucket)
            }
          },
          create: {
            clientId: options.clientId ?? null,
            subject: subject.slice(0, 180),
            windowKey: String(bucket),
            count,
            expiresAt: new Date(Date.now() + options.windowSeconds * 1_000)
          },
          update: {
            count,
            expiresAt: new Date(Date.now() + options.windowSeconds * 1_000)
          }
        }),
        { subject, clientId: options.clientId }
      );
    }

    if (count > options.limit) {
      const error = new Error("Rate limit exceeded");
      (error as Error & { statusCode?: number }).statusCode = 429;
      throw error;
    }
  }

  async enforceQuota(input: {
    clientId: string;
    metric: TenantUsageMetric;
    incrementBy?: number;
    trace?: TraceContext;
  }): Promise<void> {
    if (!("billingPeriod" in this.db) || !("tenantUsage" in this.db)) {
      return;
    }

    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const limit = this.config.defaultQuotas[input.metric];
    const incrementBy = input.incrementBy ?? 1;

    const usage = await this.db.$transaction(async (tx) => {
      const period = await tx.billingPeriod.upsert({
        where: {
          clientId_startsAt_endsAt: {
            clientId: input.clientId,
            startsAt: periodStart,
            endsAt: periodEnd
          }
        },
        create: {
          clientId: input.clientId,
          startsAt: periodStart,
          endsAt: periodEnd,
          planKey: "default",
          quotas: toPrismaJson(this.config.defaultQuotas)
        },
        update: {},
        select: { id: true }
      });

      return tx.tenantUsage.upsert({
        where: {
          clientId_billingPeriodId_metric: {
            clientId: input.clientId,
            billingPeriodId: period.id,
            metric: input.metric
          }
        },
        create: {
          clientId: input.clientId,
          billingPeriodId: period.id,
          metric: input.metric,
          used: incrementBy,
          limit
        },
        update: {
          used: { increment: incrementBy },
          limit
        },
        select: { id: true, billingPeriodId: true, used: true, limit: true, warnedAt: true }
      });
    });

    const warningAt = Math.floor((usage.limit * this.config.quotaWarningThresholdPercent) / 100);
    if (usage.used >= warningAt && !usage.warnedAt && usage.used <= usage.limit) {
      observeBackgroundTask(
        this.logger,
        "quota.warning_event_failed",
        this.db.$transaction([
          this.db.tenantUsage.update({ where: { id: usage.id }, data: { warnedAt: new Date() } }),
          this.db.quotaEvent.create({
            data: {
              clientId: input.clientId,
              billingPeriodId: usage.billingPeriodId,
              metric: input.metric,
              eventType: "warning",
              usageValue: usage.used,
              limitValue: usage.limit,
              requestId: input.trace?.requestId ?? null
            }
          })
        ]),
        { clientId: input.clientId, metric: input.metric }
      );
    }

    if (usage.used > usage.limit) {
      await this.db.$transaction([
        this.db.tenantUsage.update({ where: { id: usage.id }, data: { exceededAt: new Date() } }),
        this.db.quotaEvent.create({
          data: {
            clientId: input.clientId,
            billingPeriodId: usage.billingPeriodId,
            metric: input.metric,
            eventType: "enforced",
            usageValue: usage.used,
            limitValue: usage.limit,
            requestId: input.trace?.requestId ?? null
          }
        })
      ]);
      const error = new Error(`Tenant quota exceeded: ${input.metric}`);
      (error as Error & { statusCode?: number }).statusCode = 429;
      throw error;
    }
  }

  async createLead(input: {
    auth: AuthenticatedApiKey;
    idempotencyKey: string;
    body: unknown;
    trace: TraceContext;
  }): Promise<{ leadId: string; created: boolean }> {
    return withLogContext(
      {
        request_id: input.trace.requestId,
        correlation_id: input.trace.correlationId,
        client_id: input.auth.clientId
      },
      async () => {
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

        await this.enforceQuota({
          clientId: body.client_id,
          metric: "leads",
          trace: input.trace
        });

        const normalizedPhone = normalizePhoneE164(body.phone);
        const normalizedEmail = normalizeEmail(body.email ?? null);
        const storedIdempotencyKey = buildTenantIdempotencyKey(body.client_id, input.idempotencyKey);

        try {
          const lead = await this.db.lead.create({
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
            select: {
              id: true,
              phone: true,
              conversation: {
                select: {
                  id: true
                }
              }
            }
          });

          const result = {
            leadId: lead.id,
            conversationId: lead.conversation!.id,
            created: true,
            phone: lead.phone
          };

          const dedupeKey = buildJobDedupeKey(["intro", result.conversationId]);
          const job: SendMessageJobData = {
            clientId: body.client_id,
            leadId: result.leadId,
            conversationId: result.conversationId,
            to: result.phone,
            text: "Hi, thanks for your interest in our properties. I will ask a few quick questions to match the right options. What budget range are you considering?",
            dedupeKey,
            reason: "intro",
            transitionAfterSend: "ASK_BUDGET",
            trace: buildJobTrace(undefined, {
              requestId: input.trace.requestId,
              correlationId: input.trace.correlationId,
              source: "api"
            })
          };

          await this.queues.enqueueSendMessage(job);
          observeBackgroundTask(
            this.logger,
            "lead.create.bookkeeping_failed",
            Promise.all([
              createAuditLog(this.db, {
                clientId: body.client_id,
                actor: `api_key:${input.auth.id}`,
                action: "lead.create",
                entity: "Lead",
                entityId: lead.id,
                metadata: {
                  phone: normalizedPhone,
                  email: normalizedEmail,
                  source: body.source
                },
                trace: input.trace
              }),
              upsertJobMirror(this.db, {
                clientId: body.client_id,
                leadId: result.leadId,
                queue: "messages",
                name: "send_message",
                idempotencyKey: dedupeKey,
                payload: job,
                metadata: {
                  queueName: "messages",
                  source: "api"
                },
                status: "queued",
                trace: input.trace
              })
            ]),
            { clientId: body.client_id, leadId: result.leadId, request_id: input.trace.requestId }
          );
          this.logger.info(
            {
              clientId: body.client_id,
              leadId: result.leadId,
              queue: "messages",
              request_id: input.trace.requestId
            },
            "lead.intro.enqueued"
          );
          leadCreatedTotal.inc({ client_id: body.client_id });

          return {
            leadId: result.leadId,
            created: result.created
          };
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            const existing = await this.db.lead.findUnique({
              where: { idempotencyKey: storedIdempotencyKey },
              select: { id: true }
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
    );
  }

  async handleInboundWebhook(input: {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    rawBody: string;
    requestUrl: string;
    requestIp: string;
    trace: TraceContext;
  }): Promise<{ status: "processed" | "duplicate" | "ignored"; leadId?: string }> {
    return withLogContext(
      {
        request_id: input.trace.requestId,
        correlation_id: input.trace.correlationId
      },
      async () => {
        const startedAt = performance.now();
        let provider: WhatsAppProvider | "unknown" = "unknown";
        let outcomeStatus: "processed" | "duplicate" | "ignored" | "failed" = "failed";

        try {
          const parsedBody = inboundBodySchema.parse(input.body);
          provider = detectProvider(input.headers, parsedBody);
          await this.enforceRateLimit(`webhook:${provider}:${input.requestIp}`, {
            limit: this.config.webhookRateLimitPerMinute,
            windowSeconds: this.config.webhookRateLimitWindowSeconds
          });

          const normalized = normalizeInboundMessage({
            provider,
            body: parsedBody
          });
          const client = await this.resolveClientForInbound(provider, normalized);
          await this.enforceQuota({ clientId: client.id, metric: "webhooks", trace: input.trace });
          const clientRuntime = this.toClientRuntime(client);
          const signatureValid = verifyWebhookSignature({
            provider,
            headers: input.headers,
            rawBody: input.rawBody,
            requestUrl: input.requestUrl,
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

          const replayKey = this.buildWebhookReplayKey(provider, client.id, normalized.providerMessageId);
          if (await this.isWebhookReplay(replayKey)) {
            this.logger.warn(
              {
                clientId: client.id,
                provider,
                providerMessageId: normalized.providerMessageId
              },
              "webhook.replay.detected"
            );
            outcomeStatus = "duplicate";
            return { status: "duplicate", leadId: undefined };
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
                  },
                  trace: input.trace
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
                      requestId: input.trace.requestId,
                      correlationId: input.trace.correlationId,
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
                    value: toPrismaJson(attribute.value),
                    rawValue: attribute.rawValue ?? null,
                    confidence: attribute.confidence ?? 1,
                    source: attribute.source ?? "rule",
                    ...(attribute.metadata ? { metadata: toPrismaJson(attribute.metadata) } : {})
                  },
                  update: {
                    value: toPrismaJson(attribute.value),
                    rawValue: attribute.rawValue ?? null,
                    confidence: attribute.confidence ?? 1,
                    source: attribute.source ?? "rule",
                    ...(attribute.metadata ? { metadata: toPrismaJson(attribute.metadata) } : {})
                  }
                });
              }

              const nextContext: ConversationContext = {
                ...currentContext,
                lastInboundAt: now.toISOString(),
                responseCount: (currentContext.responseCount ?? 0) + 1,
                completionPercentage: advance.completenessPercentage,
                intentConfidence: advance.intentConfidence,
                ...(typeof responseLatencyMs === "number" ? { lastResponseLatencyMs: responseLatencyMs } : {}),
                ...(advance.nextState === "QUALIFIED"
                  ? { qualifiedAt: now.toISOString() }
                  : currentContext.qualifiedAt
                    ? { qualifiedAt: currentContext.qualifiedAt }
                    : {})
              };

              const score =
                computeLeadScore({
                  attributes: Object.fromEntries(attributeMap),
                  responseLatencyMs,
                  engagementCount: nextContext.responseCount ?? 0,
                  qualificationCompleteness: computeQualificationCompleteness(attributeMap.keys()),
                  config: this.extractScoringConfig(client.crmConfig)
                });

              await tx.lead.update({
                where: { id: lead.id },
                data: {
                  status:
                    advance.nextState === "QUALIFIED" ? "qualified" : lead.status === "new" ? "contacted" : lead.status,
                  score: score.total,
                  priority: score.priority,
                  qualificationCompleteness: computeQualificationCompleteness(attributeMap.keys()),
                  intentConfidence: advance.intentConfidence
                }
              });

              await (tx as unknown as OptionalPhase2Delegates).leadScore?.create({
                data: {
                  leadId: lead.id,
                  clientId: lead.clientId,
                  total: score.total,
                  priority: score.priority,
                  breakdown: toPrismaJson(score.breakdown),
                  version: score.version
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
              await (tx as unknown as OptionalPhase2Delegates).followUp?.updateMany({
                where: {
                  leadId: lead.id,
                  status: "scheduled"
                },
                data: {
                  status: "cancelled",
                  cancelledAt: now
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
                  completionPercentage: advance.completenessPercentage,
                  phone: normalized.from
                },
                trace: input.trace
              });

              return {
                status: "processed" as const,
                leadId: lead.id,
                conversationId: lead.conversation.id,
                phone: lead.phone,
                nextState: advance.nextState,
                outboundMessage: advance.outboundMessage,
                qualifiedAt: nextContext.qualifiedAt,
                deterministic: {
                  parsedAnswers: sanitizeJsonValue(advance.parsedAnswers) as JsonObject,
                  attributes: sanitizeJsonValue(Object.fromEntries(attributeMap)) as JsonObject,
                  confidence: advance.intentConfidence
                }
              };
            },
            interactiveTransactionOptions
          );

          if (outcome.status !== "processed") {
            await this.storeWebhookReplay(replayKey);
            outcomeStatus = outcome.status;
            return outcome;
          }

          const webhookTrace = buildJobTrace(undefined, {
            requestId: input.trace.requestId,
            correlationId: input.trace.correlationId,
            source: "webhook"
          });

          const aiJob: AiLeadIntelligenceJobData = {
            clientId: client.id,
            leadId: outcome.leadId,
            conversationId: outcome.conversationId,
            rawUtterance: normalized.text,
            deterministic: outcome.deterministic,
            tasks: [
              "semantic_understanding",
              "behavioral_intelligence",
              "buyer_intent_prediction",
              "conversational_memory",
              "multilingual_reasoning",
              "engagement_prediction",
              "conversation_summary",
              "followup_optimization",
              "sales_assist",
              "analytics_intelligence"
            ],
            dedupeKey: buildJobDedupeKey(["ai", outcome.conversationId, normalized.providerMessageId]),
            trace: webhookTrace
          };

          this.scheduleAiLeadIntelligence(aiJob, input.trace);

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
              ...(outcome.nextState === "QUALIFIED" ? {} : { transitionAfterSend: outcome.nextState }),
              trace: webhookTrace
            };

            await upsertJobMirror(this.db, {
              clientId: client.id,
              leadId: outcome.leadId,
              queue: "messages",
              name: "send_message",
              idempotencyKey: outboundDedupeKey,
              payload: outboundJob,
              metadata: {
                queueName: "messages",
                source: "webhook"
              },
              status: "queued",
              trace: input.trace
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
              qualifiedAt,
              trace: webhookTrace
            };

            await upsertJobMirror(this.db, {
              clientId: client.id,
              leadId: outcome.leadId,
              queue: "crm",
              name: "crm_push",
              idempotencyKey: crmJob.dedupeKey,
              payload: crmJob,
              metadata: {
                queueName: "crm",
                source: "webhook"
              },
              status: "queued",
              trace: input.trace
            });
            await this.queues.enqueueCrmPush(crmJob);
            await this.enqueueAgentNotification(
              clientRuntime,
              {
                leadId: outcome.leadId,
                conversationId: outcome.conversationId,
                qualifiedAt
              },
              input.trace
            );
            await this.refreshQualificationRate(client.id);
          }

          await this.storeWebhookReplay(replayKey);
          outcomeStatus = "processed";
          return {
            status: "processed",
            leadId: outcome.leadId
          };
        } catch (error) {
          incrementWebhookFailure(provider, this.classifyWebhookFailure(error));
          throw error;
        } finally {
          observeWebhookProcessingLatency(provider, outcomeStatus, performance.now() - startedAt);
        }
      }
    );
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

  async listDashboardLeads(input: {
    auth: AuthenticatedApiKey;
    query: unknown;
  }) {
    const query = dashboardListSchema.parse(input.query);
    const where = {
      clientId: input.auth.clientId,
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: "insensitive" as const } }
            ]
          }
        : {})
    };
    const orderBy =
      query.sort === "score"
        ? { score: query.order }
        : query.sort === "qualification"
          ? { qualificationCompleteness: query.order }
          : query.sort === "updated_at"
            ? { updatedAt: query.order }
            : { createdAt: query.order };
    const [total, leads] = await Promise.all([
      this.db.lead.count({ where }),
      this.db.lead.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.page_size,
        take: query.page_size,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          source: true,
          status: true,
          score: true,
          priority: true,
          qualificationCompleteness: true,
          intentConfidence: true,
          crmSyncStatus: true,
          crmExternalId: true,
          createdAt: true,
          updatedAt: true
        }
      })
    ]);

    return {
      page: query.page,
      page_size: query.page_size,
      total,
      leads
    };
  }

  async getDashboardLead(input: {
    auth: AuthenticatedApiKey;
    leadId: string;
  }) {
    const lead = await this.db.lead.findFirst({
      where: {
        id: input.leadId,
        clientId: input.auth.clientId
      },
      include: {
        attributes: true,
        conversation: {
          include: {
            messages: {
              orderBy: { createdAt: "desc" },
              take: 25
            }
          }
        },
        scores: {
          orderBy: { createdAt: "desc" },
          take: 5
        },
        followUps: {
          orderBy: { scheduledAt: "desc" },
          take: 20
        },
        crmSyncs: {
          orderBy: { updatedAt: "desc" },
          take: 5
        }
      }
    });

    if (!lead) {
      const error = new Error("Lead not found");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    return lead;
  }

  async getDashboardAnalytics(input: { auth: AuthenticatedApiKey }) {
    const clientId = input.auth.clientId;
    const [analytics] = await this.db.$queryRaw<{
      total_leads: bigint;
      qualified_leads: bigint;
      status_distribution: Record<string, number> | null;
      source_distribution: Record<string, number> | null;
      followup_distribution: Record<string, number> | null;
    }[]>`
      WITH lead_counts AS (
        SELECT
          COUNT(*)::bigint AS total_leads,
          COUNT(*) FILTER (WHERE status = 'qualified')::bigint AS qualified_leads
        FROM "Lead"
        WHERE "clientId" = ${clientId}::uuid
      ),
      status_distribution AS (
        SELECT COALESCE(jsonb_object_agg(status, row_count), '{}'::jsonb) AS value
        FROM (
          SELECT status::text AS status, COUNT(*)::int AS row_count
          FROM "Lead"
          WHERE "clientId" = ${clientId}::uuid
          GROUP BY status
        ) rows
      ),
      source_distribution AS (
        SELECT COALESCE(jsonb_object_agg(source, row_count), '{}'::jsonb) AS value
        FROM (
          SELECT source, COUNT(*)::int AS row_count
          FROM "Lead"
          WHERE "clientId" = ${clientId}::uuid
          GROUP BY source
        ) rows
      ),
      followup_distribution AS (
        SELECT COALESCE(jsonb_object_agg(status, row_count), '{}'::jsonb) AS value
        FROM (
          SELECT status::text AS status, COUNT(*)::int AS row_count
          FROM "FollowUp"
          WHERE "clientId" = ${clientId}::uuid
          GROUP BY status
        ) rows
      )
      SELECT
        lead_counts.total_leads,
        lead_counts.qualified_leads,
        status_distribution.value AS status_distribution,
        source_distribution.value AS source_distribution,
        followup_distribution.value AS followup_distribution
      FROM lead_counts, status_distribution, source_distribution, followup_distribution
    `;
    const total = Number(analytics?.total_leads ?? 0);
    const qualified = Number(analytics?.qualified_leads ?? 0);

    return {
      total_leads: total,
      qualification_rate: total === 0 ? 0 : qualified / total,
      lead_status_distribution: analytics?.status_distribution ?? {},
      source_conversion: analytics?.source_distribution ?? {},
      response_times: {
        average_ms: null
      },
      follow_up_effectiveness: analytics?.followup_distribution ?? {}
    };
  }

  async getDashboardPipeline(input: { auth: AuthenticatedApiKey }) {
    const rows = await this.db.lead.groupBy({
      by: ["status", "priority"],
      where: {
        clientId: input.auth.clientId
      },
      _count: { _all: true },
      _avg: { score: true }
    });

    return {
      stages: rows.map((row) => ({
        status: row.status,
        priority: row.priority,
        count: row._count._all,
        average_score: row._avg.score ?? 0
      }))
    };
  }

  async retrieveLeadMemory(input: {
    auth: AuthenticatedApiKey;
    leadId: string;
    query: unknown;
  }) {
    const query = memoryRetrievalSchema.parse(input.query ?? {});
    const cutoff = new Date(Date.now() - query.max_age_days * 24 * 60 * 60 * 1000);
    const memories = await this.db.conversationalMemory.findMany({
      where: {
        clientId: input.auth.clientId,
        leadId: input.leadId,
        relevanceScore: { gte: query.min_relevance },
        updatedAt: { gte: cutoff }
      },
      orderBy: [
        { relevanceScore: "desc" },
        { updatedAt: "desc" }
      ],
      take: query.limit
    });

    await this.db.memoryRetrievalLog.create({
      data: {
        clientId: input.auth.clientId,
        leadId: input.leadId,
        query: toPrismaJson(query),
        resultIds: memories.map((memory) => memory.id),
        relevanceScores: toPrismaJson(Object.fromEntries(memories.map((memory) => [memory.id, memory.relevanceScore]))),
        staleFiltered: 0
      }
    });

    return {
      lead_id: input.leadId,
      memories
    };
  }

  async listDashboardFollowups(input: {
    auth: AuthenticatedApiKey;
    query: unknown;
  }) {
    const query = dashboardFollowupSchema.parse(input.query);
    const where = {
      clientId: input.auth.clientId,
      ...(query.status ? { status: query.status } : {})
    };
    const [total, followups] = await Promise.all([
      this.db.followUp.count({ where }),
      this.db.followUp.findMany({
        where,
        orderBy: { scheduledAt: "asc" },
        skip: (query.page - 1) * query.page_size,
        take: query.page_size,
        include: {
          lead: {
            select: {
              id: true,
              name: true,
              phone: true,
              status: true,
              priority: true,
              score: true
            }
          }
        }
      })
    ]);

    return {
      page: query.page,
      page_size: query.page_size,
      total,
      followups
    };
  }

  async createApiKey(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = apiKeyCreateSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, input.auth.clientId);
    const generated = generateApiKey();
    const record = await this.db.apiKey.create({
      data: {
        clientId,
        name: body.name,
        prefix: generated.prefix,
        hashedKey: hashApiKey(generated.plaintext, this.config.APP_ENCRYPTION_KEY),
        scopes: body.scopes,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null
      },
      select: {
        id: true,
        prefix: true,
        name: true,
        scopes: true,
        expiresAt: true,
        createdAt: true
      }
    });

    await this.auditSecurityEvent({
      clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "api_key.create",
      entity: "ApiKey",
      entityId: record.id,
      trace: input.trace,
      metadata: { prefix: record.prefix, scopes: record.scopes }
    });

    return {
      ...record,
      api_key: generated.plaintext
    };
  }

  async listApiKeys(input: { auth: AuthenticatedUser }) {
    const clientId = this.resolveTenantForUser(input.auth, input.auth.clientId);
    return this.db.apiKey.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        usageCount: true,
        createdAt: true
      }
    });
  }

  async revokeApiKey(input: { auth: AuthenticatedUser; apiKeyId: string; trace: TraceContext }) {
    const clientId = this.resolveTenantForUser(input.auth, input.auth.clientId);
    const result = await this.db.apiKey.updateMany({
      where: {
        id: input.apiKeyId,
        clientId
      },
      data: {
        status: "revoked",
        revokedAt: new Date()
      }
    });
    if (result.count === 0) {
      const error = new Error("API key not found");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    await this.auditSecurityEvent({
      clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "api_key.revoke",
      entity: "ApiKey",
      entityId: input.apiKeyId,
      trace: input.trace,
      metadata: {}
    });

    return { revoked: true };
  }

  async listAuditEvents(input: { auth: AuthenticatedUser; query: unknown }) {
    const query = listAuditSchema.parse(input.query);
    const clientId = input.auth.roles.includes("SUPER_ADMIN") ? undefined : this.resolveTenantForUser(input.auth, input.auth.clientId);
    const where = {
      ...(clientId ? { clientId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.request_id ? { requestId: query.request_id } : {})
    };
    const [total, events] = await Promise.all([
      this.db.auditEvent.count({ where }),
      this.db.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.page_size,
        take: query.page_size
      })
    ]);

    return {
      page: query.page,
      page_size: query.page_size,
      total,
      events
    };
  }

  async getTenantUsage(input: { auth: AuthenticatedUser; query?: unknown }) {
    const query = z.object({ client_id: z.string().uuid().optional() }).parse(input.query ?? {});
    const clientId = this.resolveTenantForUser(input.auth, query.client_id ?? input.auth.clientId);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const period = await this.db.billingPeriod.findFirst({
      where: {
        clientId,
        startsAt: periodStart,
        endsAt: periodEnd
      },
      include: {
        usage: true
      }
    });

    return {
      client_id: clientId,
      period_start: periodStart,
      period_end: periodEnd,
      plan: period?.planKey ?? "default",
      usage: period?.usage ?? []
    };
  }

  async inspectFailedJobs(input: { auth: AuthenticatedUser; query: unknown }) {
    const query = adminListSchema.parse(input.query);
    const where = {
      status: "dead_letter" as const,
      ...(query.client_id ? { clientId: query.client_id } : {}),
      ...(query.queue ? { queue: query.queue } : {})
    };
    const [total, jobs] = await Promise.all([
      this.db.job.count({ where }),
      this.db.job.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.page_size,
        take: query.page_size,
        select: {
          id: true,
          clientId: true,
          leadId: true,
          queue: true,
          name: true,
          idempotencyKey: true,
          attempts: true,
          lastError: true,
          updatedAt: true,
          metadata: true
        }
      })
    ]);

    return { page: query.page, page_size: query.page_size, total, jobs };
  }

  async inspectQueueHealth() {
    const [failedJobs, heartbeats, queues] = await Promise.all([
      this.db.job.groupBy({
        by: ["queue", "status"],
        _count: { _all: true }
      }),
      "workerHeartbeat" in this.db
        ? this.db.workerHeartbeat.findMany({
            orderBy: { lastBeatAt: "desc" },
            take: 50
          })
        : Promise.resolve([])
      ,
      "getQueueHealth" in this.queues ? this.queues.getQueueHealth() : Promise.resolve([])
    ]);

    return {
      jobs: failedJobs,
      workers: heartbeats,
      queues
    };
  }

  async pauseQueue(input: { queue: string; auth: AuthenticatedUser; trace: TraceContext }) {
    await this.queues.pauseQueue(input.queue);
    await this.auditSecurityEvent({
      actorType: "user",
      actorId: input.auth.id,
      action: "queue.pause",
      entity: "Queue",
      entityId: input.queue,
      trace: input.trace,
      metadata: {}
    });
    return { paused: true };
  }

  async resumeQueue(input: { queue: string; auth: AuthenticatedUser; trace: TraceContext }) {
    await this.queues.resumeQueue(input.queue);
    await this.auditSecurityEvent({
      actorType: "user",
      actorId: input.auth.id,
      action: "queue.resume",
      entity: "Queue",
      entityId: input.queue,
      trace: input.trace,
      metadata: {}
    });
    return { resumed: true };
  }

  async replayFailedJob(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = replaySchema.parse(input.body);
    const replayLockKey = `replay:${body.queue}:${body.job_id}`;
    const lock = await this.queues.redis.set(replayLockKey, "1", "EX", 300, "NX");
    if (lock !== "OK") {
      const error = new Error("Replay already in progress");
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const job = await this.db.job.findFirst({
      where: {
        id: body.job_id,
        queue: body.queue,
        status: "dead_letter"
      }
    });
    if (!job) {
      const error = new Error("Dead-letter job not found");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    const replayKey = buildJobDedupeKey(["replay", job.idempotencyKey, String(Date.now())]);
    const payload = {
      ...(job.payload as JsonObject),
      dedupeKey: replayKey,
      trace: buildJobTrace(undefined, {
        requestId: input.trace.requestId,
        correlationId: input.trace.correlationId,
        source: "api"
      })
    };

    if (job.queue === "messages") {
      await this.queues.enqueueSendMessage(payload as SendMessageJobData);
    } else if (job.queue === "crm") {
      await this.queues.enqueueCrmPush(payload as CrmPushJobData);
    } else if (job.queue === "followups") {
      await this.queues.enqueueFollowup(payload as never, 0);
    } else if (job.queue === "ai") {
      await this.queues.enqueueAiLeadIntelligence(payload as AiLeadIntelligenceJobData);
    } else {
      const error = new Error("Replay is not supported for this queue");
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }

    await this.auditSecurityEvent({
      clientId: job.clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "job.replay",
      entity: "Job",
      entityId: job.id,
      trace: input.trace,
      metadata: {
        queue: job.queue,
        replayKey
      }
    });

    return { replayed: true, replay_key: replayKey };
  }

  async createEvaluationDataset(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = createEvaluationDatasetSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    const checksum = stableHash(body.examples);
    const existing = await this.db.evaluationDataset.findUnique({
      where: {
        clientId_datasetType_version: {
          clientId,
          datasetType: body.dataset_type,
          version: body.version
        }
      }
    });
    if (existing && existing.checksum !== checksum) {
      const error = new Error("Evaluation dataset versions are immutable; create a new version");
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }
    const dataset = existing ?? await this.db.evaluationDataset.create({
      data: {
        clientId,
        name: sanitizeFreeText(body.name, 160),
        datasetType: body.dataset_type,
        version: body.version,
        checksum,
        examples: toPrismaJson(body.examples),
        metadata: toPrismaJson({ ...(body.metadata ?? {}), immutable: true, manifestVersion: "phase5-v2" }),
        createdBy: input.auth.id
      }
    });

    await this.auditSecurityEvent({
      clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "evaluation_dataset.upsert",
      entity: "EvaluationDataset",
      entityId: dataset.id,
      trace: input.trace,
      metadata: { datasetType: body.dataset_type, version: body.version }
    });

    return dataset;
  }

  async scheduleEvaluationRun(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = createEvaluationRunSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    const dataset = body.dataset_id
      ? await this.db.evaluationDataset.findFirst({
          where: { id: body.dataset_id, clientId }
        })
      : null;
    if (body.dataset_id && !dataset) {
      const error = new Error("Evaluation dataset not found");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    const inputChecksum = stableHash({
      clientId,
      datasetId: body.dataset_id ?? "synthetic",
      datasetChecksum: dataset?.checksum ?? "synthetic",
      runType: body.run_type,
      modelVersion: body.model_version,
      promptVersion: body.prompt_version ?? null,
      baselineRunId: body.baseline_run_id ?? null
    });
    const dedupeKey = buildJobDedupeKey(["evaluation", inputChecksum]);
    const run = await this.db.evaluationRun.create({
      data: {
        clientId,
        datasetId: body.dataset_id ?? null,
        runType: body.run_type,
        status: "queued",
        modelVersion: body.model_version,
        promptVersion: body.prompt_version ?? null,
        baselineRunId: body.baseline_run_id ?? null,
        inputChecksum,
        concurrencyLimit: Math.min(body.concurrency_limit, this.config.evaluationMaxConcurrency),
        isolatedQueue: "evaluation"
      }
    });
    const job = {
      clientId,
      runId: run.id,
      datasetId: body.dataset_id,
      runType: body.run_type,
      modelVersion: body.model_version,
      promptVersion: body.prompt_version,
      baselineRunId: body.baseline_run_id,
      concurrencyLimit: Math.min(body.concurrency_limit, this.config.evaluationMaxConcurrency),
      dedupeKey,
      trace: buildJobTrace(undefined, {
        requestId: input.trace.requestId,
        correlationId: input.trace.correlationId,
        source: "api"
      })
    };

    await upsertJobMirror(this.db, {
      clientId,
      queue: "evaluation",
      name: "evaluation_run",
      idempotencyKey: dedupeKey,
      payload: job,
      metadata: {
        queueName: "evaluation",
        isolatedFromProduction: true,
        boundedConcurrency: job.concurrencyLimit
      },
      status: "queued",
      trace: input.trace
    });
    await this.queues.enqueueEvaluationRun(job);

    return { run_id: run.id, queued: true, queue: "evaluation" };
  }

  async ingestFeedbackEvent(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = feedbackEventSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    if (body.lead_id) {
      const lead = await this.db.lead.findFirst({ where: { id: body.lead_id, clientId }, select: { id: true } });
      if (!lead) {
        const error = new Error("Feedback lead target not found for tenant");
        (error as Error & { statusCode?: number }).statusCode = 404;
        throw error;
      }
    }
    if (body.target_type === "ai_recommendation") {
      const recommendation = await this.db.aiRecommendation.findFirst({
        where: { id: body.target_id, clientId },
        select: { id: true, leadId: true, effectiveness: true }
      });
      if (!recommendation) {
        const error = new Error("Feedback recommendation target not found for tenant");
        (error as Error & { statusCode?: number }).statusCode = 404;
        throw error;
      }
      if (body.lead_id && recommendation.leadId !== body.lead_id) {
        const error = new Error("Feedback recommendation does not belong to lead");
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }
    }
    const event = await this.db.feedbackEvent.create({
      data: {
        clientId,
        leadId: body.lead_id ?? null,
        actorId: input.auth.id,
        eventType: body.event_type,
        targetType: body.target_type,
        targetId: body.target_id,
        originalValue: toPrismaJson(body.original_value),
        correctedValue: body.corrected_value === undefined ? Prisma.JsonNull : toPrismaJson(body.corrected_value),
        acceptanceScore: feedbackAcceptanceScore(body.event_type),
        auditMetadata: toPrismaJson({
          requestId: input.trace.requestId,
          autonomousRetraining: false,
          evaluationAndRankingOnly: true
        })
      }
    });

    if (body.target_type === "ai_recommendation") {
      const accepted = body.event_type === "recommendation_accepted";
      const rejected = body.event_type === "recommendation_rejected";
      if (accepted || rejected) {
        await this.db.aiRecommendation.updateMany({
          where: { id: body.target_id, clientId },
          data: {
            status: accepted ? "accepted" : "rejected",
            acceptedAt: accepted ? new Date() : null,
            effectiveness: toPrismaJson({
              latestFeedbackEventId: event.id,
              acceptanceScore: event.acceptanceScore,
              updatedBy: input.auth.id,
              evaluationAndRankingOnly: true
            })
          }
        });
      }
    }

    await this.auditSecurityEvent({
      clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "feedback.ingest",
      entity: "FeedbackEvent",
      entityId: event.id,
      trace: input.trace,
      metadata: { eventType: body.event_type, targetType: body.target_type, targetId: body.target_id }
    });

    return event;
  }

  async getEnterpriseIntelligenceAnalytics(input: { auth: AuthenticatedUser; query: unknown }) {
    const query = intelligenceQuerySchema.parse(input.query ?? {});
    const clientId = this.resolveTenantForUser(input.auth, query.client_id ?? input.auth.clientId);
    const now = new Date();
    const rollupEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const since = new Date(rollupEnd.getTime() - query.days * 86_400_000);
    const [runs, feedback, drifts, recommendations, costs] = await Promise.all([
      this.db.evaluationRun.findMany({
        where: { clientId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 50
      }),
      this.db.feedbackEvent.groupBy({
        by: ["eventType"],
        where: { clientId, createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { acceptanceScore: true }
      }),
      this.db.driftMetric.findMany({
        where: { clientId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 50
      }),
      this.db.aiRecommendation.groupBy({
        by: ["status", "recommendationType"],
        where: { clientId, createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { confidence: true }
      }),
      this.db.aiCostMetric.findMany({
        where: { clientId, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" }
      })
    ]);
    const totalCostSeries = costs.map((entry) => Number(entry.costUsd));
    const costForecast = detectCostAnomaly(totalCostSeries);

    const response = {
      client_id: clientId,
      window_days: query.days,
      evaluation_runs: runs,
      feedback,
      drifts,
      recommendation_effectiveness: recommendations,
      cost_forecast: {
        forecast_cost_usd: costForecast.forecast,
        anomaly_score: costForecast.anomalyScore,
        confidence: costForecast.confidence
      }
    };
    await this.db.analyticsRollup.upsert({
      where: {
        clientId_rollupType_windowStart_windowEnd: {
          clientId,
          rollupType: "enterprise_intelligence",
          windowStart: since,
          windowEnd: rollupEnd
        }
      },
      create: {
        clientId,
        rollupType: "enterprise_intelligence",
        windowStart: since,
        windowEnd: rollupEnd,
        checksum: stableHash(response),
        metrics: toPrismaJson(response)
      },
      update: {
        checksum: stableHash(response),
        metrics: toPrismaJson(response)
      }
    });
    return response;
  }

  async benchmarkLeadMemoryRetrieval(input: { auth: AuthenticatedApiKey; leadId: string; query: unknown }) {
    const query = memoryRetrievalSchema.extend({
      text: z.string().min(1).max(500),
      expected_ids: z.array(z.string()).default([])
    }).parse(input.query ?? {});
    const startedAt = performance.now();
    const cutoff = new Date(Date.now() - query.max_age_days * 86_400_000);
    const memories = await this.db.conversationalMemory.findMany({
      where: {
        clientId: input.auth.clientId,
        leadId: input.leadId,
        updatedAt: { gte: cutoff }
      },
      orderBy: [
        { updatedAt: "desc" },
        { relevanceScore: "desc" }
      ],
      take: Math.min(500, Math.max(query.limit * 20, 100))
    });
    const ranked = rankRetrievalCandidates({
      query: query.text,
      candidates: memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        tags: memory.tags,
        relevanceScore: memory.relevanceScore,
        confidence: memory.confidence,
        updatedAt: memory.updatedAt,
        vector: Array.isArray((memory.content as { vector?: unknown }).vector)
          ? ((memory.content as { vector: number[] }).vector).filter((value) => typeof value === "number")
          : undefined
      }))
    }).filter((memory) => memory.finalScore >= query.min_relevance).slice(0, query.limit);
    const metrics = scoreRetrievalRanking(query.expected_ids, ranked.map((memory) => memory.id));
    const latencyMs = Math.round(performance.now() - startedAt);
    observeRetrievalLatency(input.auth.clientId, "hash-lexical-v1", latencyMs);

    await this.db.retrievalBenchmark.create({
      data: {
        clientId: input.auth.clientId,
        leadId: input.leadId,
        query: toPrismaJson(query),
        expectedMemoryIds: query.expected_ids,
        retrievedMemoryIds: ranked.map((memory) => memory.id),
        relevanceScores: toPrismaJson(Object.fromEntries(ranked.map((memory) => [memory.id, memory.finalScore]))),
        rankingMetrics: toPrismaJson(metrics),
        explainability: toPrismaJson(Object.fromEntries(ranked.map((memory) => [memory.id, memory.explanation]))),
        confidence: ranked.length === 0 ? 0 : ranked.reduce((sum, memory) => sum + memory.finalScore, 0) / ranked.length,
        latencyMs,
        staleFiltered: memories.length - ranked.length,
        model: "hash-lexical-v1"
      }
    });

    return {
      lead_id: input.leadId,
      results: ranked,
      metrics,
      latency_ms: latencyMs
    };
  }

  async recordOperationalIntelligenceMetrics(): Promise<void> {
    const health = await this.queues.getQueueHealth();
    await Promise.all(
      health.map(async (queue) => {
        const counts = queue.counts as Record<string, number>;
        const metric = computeWorkerSaturation({
          activeJobs: counts.active ?? 0,
          waitingJobs: counts.waiting ?? 0,
          delayedJobs: counts.delayed ?? 0,
          failedJobs: counts.failed ?? 0,
          concurrency: queue.name === "evaluation" ? this.config.evaluationMaxConcurrency : this.config.WORKER_CONCURRENCY
        });
        await this.db.workerSaturationMetric.create({
          data: {
            queueName: queue.name,
            workerPool: queue.name === "evaluation" ? "evaluation" : queue.name === "ai" ? "ai" : "operational",
            activeJobs: counts.active ?? 0,
            waitingJobs: counts.waiting ?? 0,
            delayedJobs: counts.delayed ?? 0,
            failedJobs: counts.failed ?? 0,
            concurrency: queue.name === "evaluation" ? this.config.evaluationMaxConcurrency : this.config.WORKER_CONCURRENCY,
            saturationScore: metric.saturationScore,
            starvationRisk: metric.starvationRisk,
            adaptiveConcurrency: toPrismaJson(metric.adaptiveConcurrency),
            observedAt: new Date()
          }
        });
        await this.db.queueFairnessMetric.create({
          data: {
            queueName: queue.name,
            partitionKey: queue.name === "ai" || queue.name === "evaluation" ? "ai-isolated" : "operational",
            waitingJobs: counts.waiting ?? 0,
            activeJobs: counts.active ?? 0,
            throughputPerMinute: counts.completed ?? 0,
            fairnessScore: Math.max(0, 1 - metric.starvationRisk),
            throttleApplied: Boolean(metric.adaptiveConcurrency.throttleAiHeavyTenant),
            metadata: toPrismaJson(metric.adaptiveConcurrency),
            observedAt: new Date()
          }
        });
      })
    );
  }

  async createDriftMetric(input: {
    clientId: string;
    leadId?: string;
    metricType: string;
    baselineVersion: string;
    currentVersion: string;
    baselineValue: unknown;
    currentValue: unknown;
    threshold: number;
  }) {
    const drift = evaluateDrift(input);
    return this.db.driftMetric.create({
      data: {
        clientId: input.clientId,
        leadId: input.leadId ?? null,
        metricType: input.metricType,
        baselineVersion: input.baselineVersion,
        currentVersion: input.currentVersion,
        baselineValue: toPrismaJson(input.baselineValue),
        currentValue: toPrismaJson(input.currentValue),
        driftScore: drift.driftScore,
        threshold: input.threshold,
        anomaly: drift.anomaly,
        trend: toPrismaJson(drift.trend)
      }
    });
  }

  async upsertSloDefinition(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = sloDefinitionSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    const definition = await this.db.sloDefinition.upsert({
      where: { clientId_name: { clientId, name: body.name } },
      create: {
        clientId,
        name: body.name,
        targetType: body.target_type,
        target: body.target,
        windowMinutes: body.window_minutes,
        threshold: toPrismaJson(body.threshold)
      },
      update: {
        targetType: body.target_type,
        target: body.target,
        windowMinutes: body.window_minutes,
        threshold: toPrismaJson(body.threshold),
        isActive: true
      }
    });
    await this.auditSecurityEvent({
      clientId,
      actorType: "user",
      actorId: input.auth.id,
      action: "slo_definition.upsert",
      entity: "SloDefinition",
      entityId: definition.id,
      trace: input.trace,
      metadata: { targetType: body.target_type, target: body.target }
    });
    return definition;
  }

  async evaluateSlo(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = sloEvaluateSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    const definition = await this.db.sloDefinition.findFirst({
      where: { id: body.slo_definition_id, clientId, isActive: true }
    });
    if (!definition) {
      const error = new Error("SLO definition not found");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }
    const compliance = calculateSloCompliance({
      target: definition.target,
      goodEvents: body.good_events,
      totalEvents: body.total_events,
      previousBurnRate: body.previous_burn_rate
    });
    const incident = compliance.degradation === "none"
      ? null
      : await this.db.sloIncident.create({
          data: {
            clientId,
            sloDefinitionId: definition.id,
            status: "open",
            severity: compliance.degradation === "critical" ? "critical" : "warn",
            burnRate: compliance.burnRate,
            compliance: compliance.compliance,
            errorBudgetRemaining: compliance.errorBudgetRemaining,
            degradation: compliance.degradation,
            correlation: toPrismaJson(body.correlation)
          }
        });
    return { definition, compliance, incident };
  }

  async recordChaosScenario(input: { auth: AuthenticatedUser; body: unknown; trace: TraceContext }) {
    const body = chaosLogSchema.parse(input.body);
    const clientId = this.resolveTenantForUser(input.auth, body.client_id ?? input.auth.clientId);
    const recovery = classifyChaosRecovery({
      scenarioType: body.scenario_type,
      operationalQueueImpacted: body.operational_queue_impacted,
      fallbackActivated: body.fallback_activated,
      recovered: body.recovered
    });
    return this.db.chaosExecutionLog.create({
      data: {
        clientId,
        scenarioType: body.scenario_type,
        status: recovery.status,
        inputChecksum: stableHash(body.input ?? body),
        recoveryAction: body.recovered ? "deterministic_recovery" : "manual_intervention_required",
        operationalImpact: toPrismaJson({ operationalQueueImpacted: body.operational_queue_impacted }),
        fallbackActivated: body.fallback_activated,
        quarantineReason: recovery.status === "failed" ? "operational_impact_or_unrecovered" : null,
        startedAt: new Date(),
        completedAt: new Date()
      }
    });
  }

  async persistCostForecast(clientId: string, periodStart: Date, periodEnd: Date) {
    const costs = await this.db.aiCostMetric.findMany({
      where: { clientId, createdAt: { gte: periodStart, lt: periodEnd } },
      orderBy: { createdAt: "asc" }
    });
    const byProvider = new Map<string, typeof costs>();
    for (const cost of costs) {
      const key = `${cost.provider}:${cost.model}`;
      byProvider.set(key, [...(byProvider.get(key) ?? []), cost]);
    }
    const created = [];
    for (const [key, entries] of byProvider.entries()) {
      const [provider, model] = key.split(":") as ["deterministic" | "openai", string];
      const anomaly = detectCostAnomaly(entries.map((entry) => Number(entry.costUsd)));
      const forecastTokens = Math.round(entries.reduce((sum, entry) => sum + entry.totalTokens, 0) * 30 / Math.max(1, entries.length));
      created.push(await this.db.costForecast.create({
        data: {
          clientId,
          periodStart,
          periodEnd,
          provider,
          model,
          forecastTokens,
          forecastCostUsd: anomaly.forecast,
          confidence: anomaly.confidence,
          anomalyScore: anomaly.anomalyScore,
          recommendations: toPrismaJson({
            providerComparison: true,
            promptEfficiency: entries.map((entry) => promptEfficiencyScore({
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              confidence: 0.75,
              costUsd: Number(entry.costUsd)
            }))
          })
        }
      }));
    }
    return created;
  }

  private resolveTenantForUser(auth: AuthenticatedUser, requestedClientId?: string | null): string {
    if (auth.roles.includes("SUPER_ADMIN")) {
      if (!requestedClientId) {
        const error = new Error("client_id is required");
        (error as Error & { statusCode?: number }).statusCode = 400;
        throw error;
      }
      return requestedClientId;
    }

    if (!auth.clientId || (requestedClientId && requestedClientId !== auth.clientId)) {
      const error = new Error("Forbidden");
      (error as Error & { statusCode?: number }).statusCode = 403;
      throw error;
    }

    return auth.clientId;
  }

  private async auditSecurityEvent(input: {
    clientId?: string | null;
    actorType: string;
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    severity?: "info" | "warn" | "error";
    ipAddress?: string;
    userAgent?: string;
    metadata: unknown;
    trace: TraceContext;
  }): Promise<void> {
    if (!("auditEvent" in this.db)) {
      await createAuditLog(this.db, {
        clientId: input.clientId,
        actor: `${input.actorType}:${input.actorId ?? "anonymous"}`,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? "unknown",
        metadata: input.metadata,
        trace: input.trace
      });
      return;
    }

    await this.db.auditEvent.create({
      data: {
        clientId: input.clientId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        requestId: input.trace.requestId,
        correlationId: input.trace.correlationId,
        ipAddress: input.ipAddress?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
        severity: input.severity ?? "info",
        metadata: toPrismaJson(input.metadata)
      }
    });
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

  private buildWebhookReplayKey(provider: WhatsAppProvider, clientId: string, providerMessageId: string): string {
    return `webhook:replay:${provider}:${clientId}:${providerMessageId}`;
  }

  private async isWebhookReplay(key: string): Promise<boolean> {
    const existing = await this.queues.redis.get(key);
    return existing === "1";
  }

  private async storeWebhookReplay(key: string): Promise<void> {
    await this.queues.redis.set(key, "1", "EX", this.config.webhookReplayTtlSeconds);
  }

  private classifyWebhookFailure(error: unknown): string {
    if (error instanceof z.ZodError) {
      return "validation";
    }

    const typedError = error as Error & { statusCode?: number };
    if (typedError.statusCode === 401) {
      return "signature";
    }

    if (typedError.statusCode === 404) {
      return "unmatched_client";
    }

    if (typedError.statusCode === 429) {
      return "rate_limit";
    }

    return "processing";
  }

  private extractScoringConfig(crmConfig: unknown) {
    if (!crmConfig || typeof crmConfig !== "object" || Array.isArray(crmConfig)) {
      return null;
    }

    const config = crmConfig as Record<string, unknown>;
    return config.scoring && typeof config.scoring === "object" && !Array.isArray(config.scoring)
      ? config.scoring as Record<string, number>
      : null;
  }

  private async enqueueAgentNotification(
    client: ClientRuntimeConfig,
    payload: {
      leadId: string;
      conversationId: string;
      qualifiedAt: string;
    },
    trace: TraceContext
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
      reason: "agent_notification",
      trace: buildJobTrace(undefined, {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        source: "webhook"
      })
    };

    await upsertJobMirror(this.db, {
      clientId: client.id,
      leadId: payload.leadId,
      queue: "messages",
      name: "send_message",
      idempotencyKey: job.dedupeKey,
      payload: job,
      metadata: {
        queueName: "messages",
        source: "webhook"
      },
      status: "queued",
      trace
    });
    await this.queues.enqueueSendMessage(job);
  }

  private scheduleAiLeadIntelligence(job: AiLeadIntelligenceJobData, trace: TraceContext): void {
    observeBackgroundTask(
      this.logger,
      "ai.enqueue.degraded",
      this.enqueueAiLeadIntelligenceBestEffort(job, trace),
      {
        clientId: job.clientId,
        leadId: job.leadId,
        conversationId: job.conversationId,
        dedupeKey: job.dedupeKey,
        queue: "ai"
      }
    );
  }

  private async enqueueAiLeadIntelligenceBestEffort(job: AiLeadIntelligenceJobData, trace: TraceContext): Promise<void> {
    try {
      await upsertJobMirror(this.db, {
        clientId: job.clientId,
        leadId: job.leadId,
        queue: "ai",
        name: "lead_intelligence",
        idempotencyKey: job.dedupeKey,
        payload: job,
        metadata: {
          queueName: "ai",
          source: "webhook",
          assistiveOnly: true,
          degradationSafe: true
        },
        status: "queued",
        trace
      });
      await this.queues.enqueueAiLeadIntelligence(job);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          clientId: job.clientId,
          leadId: job.leadId,
          conversationId: job.conversationId,
          dedupeKey: job.dedupeKey
        },
        "ai.enqueue.failed.degraded"
      );

      await createAuditLog(this.db, {
        clientId: job.clientId,
        actor: "ai:scheduler",
        action: "ai.enqueue_failed",
        entity: "Lead",
        entityId: job.leadId,
        metadata: {
          queue: "ai",
          dedupeKey: job.dedupeKey,
          degradationMode: true,
          error: error instanceof Error ? error.message : "unknown"
        },
        trace
      });
    }
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
