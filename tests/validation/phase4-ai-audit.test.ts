import crypto from "node:crypto";

import { createLogger } from "@real-estate/logger";
import type { ApiConfig, WorkerConfig } from "@real-estate/config";
import { buildApp } from "../../apps/api/src/app";
import { LeadService } from "../../apps/api/src/services/lead-service";
import { processAiLeadIntelligence } from "../../apps/worker/src/processors/ai";
import { AiRuntime } from "../../apps/worker/src/services/ai-runtime";
import {
  deterministicAiLeadIntelligence,
  encryptSecret,
  hashApiKey,
  normalizeMixedLanguage
} from "@real-estate/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const logger = createLogger("phase4-ai-audit", "fatal");
const clientId = "11111111-1111-4111-8111-111111111111";
const leadId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

class AuditRedis {
  private readonly strings = new Map<string, string>();

  async incr(): Promise<number> {
    return 1;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.strings.set(key, value);
    return "OK";
  }
}

class AuditQueues {
  readonly redis = new AuditRedis();
  readonly sendMessages: unknown[] = [];
  readonly crmPushes: unknown[] = [];
  readonly aiJobs: unknown[] = [];
  failAiEnqueue = false;

  async enqueueSendMessage(payload: unknown): Promise<void> {
    this.sendMessages.push(payload);
  }

  async enqueueFollowup(): Promise<void> {
    return;
  }

  async enqueueCrmPush(payload: unknown): Promise<void> {
    this.crmPushes.push(payload);
  }

  async enqueueAiLeadIntelligence(payload: unknown): Promise<void> {
    if (this.failAiEnqueue) {
      throw new Error("simulated-ai-queue-outage");
    }
    this.aiJobs.push(payload);
  }

  async healthCheck(): Promise<void> {
    return;
  }
}

function config(): ApiConfig & WorkerConfig {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    REDIS_HOST: "localhost",
    REDIS_PORT: 6379,
    REDIS_USERNAME: undefined,
    REDIS_PASSWORD: undefined,
    REDIS_DB: 0,
    REDIS_TLS_ENABLED: false,
    APP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    JWT_SECRET: undefined,
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 2592000,
    DEFAULT_MONTHLY_LEAD_LIMIT: 10000,
    DEFAULT_MONTHLY_API_REQUEST_LIMIT: 1000000,
    DEFAULT_MONTHLY_WEBHOOK_LIMIT: 1000000,
    DEFAULT_MONTHLY_QUEUE_JOB_LIMIT: 1000000,
    QUOTA_WARNING_THRESHOLD_PERCENT: 80,
    API_RATE_LIMIT_PER_MINUTE: 120,
    API_RATE_LIMIT_WINDOW_SECONDS: 60,
    WEBHOOK_RATE_LIMIT_PER_MINUTE: 300,
    WEBHOOK_RATE_LIMIT_WINDOW_SECONDS: 60,
    WEBHOOK_BASE_URL: "http://localhost:3000/whatsapp/inbound",
    WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: 300,
    WEBHOOK_REPLAY_TTL_SECONDS: 86400,
    REQUEST_BODY_LIMIT_BYTES: 262144,
    WEBHOOK_BODY_LIMIT_BYTES: 262144,
    WORKER_CONCURRENCY: 4,
    FOLLOWUP_DELAY_MINUTES: 30,
    MESSAGE_MAX_RETRIES: 3,
    FOLLOWUP_MAX_RETRIES: 3,
    CRM_MAX_RETRIES: 3,
    AI_MAX_RETRIES: 2,
    AI_PROVIDER: "deterministic",
    OPENAI_API_KEY: undefined,
    AI_MODEL: "gpt-4.1-mini",
    AI_TIMEOUT_MS: 10,
    AI_WORKER_CONCURRENCY: 2,
    AI_CONFIDENCE_THRESHOLD: 0.55,
    QUEUE_RETRY_BACKOFF_MS: 1000,
    QUEUE_RETRY_BACKOFF_MAX_MS: 60000,
    QUEUE_METRICS_SAMPLE_INTERVAL_MS: 10000,
    QUEUE_PREFIX: "audit",
    WHATSAPP_DRY_RUN: true,
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
    API_HOST: "127.0.0.1",
    API_PORT: 3000,
    redisConnection: {
      url: "redis://localhost:6379/0",
      host: "localhost",
      port: 6379,
      db: 0,
      tlsEnabled: false
    },
    apiRateLimitWindowSeconds: 60,
    webhookRateLimitPerMinute: 300,
    webhookRateLimitWindowSeconds: 60,
    webhookReplayTtlSeconds: 86400,
    requestBodyLimitBytes: 262144,
    webhookBodyLimitBytes: 262144,
    followupMaxRetries: 3,
    queueRetryBackoffMs: 1000,
    queueRetryBackoffMaxMs: 60000,
    queueMetricsSampleIntervalMs: 10000,
    aiMaxRetries: 2,
    aiProvider: "deterministic",
    aiModel: "gpt-4.1-mini",
    aiTimeoutMs: 10,
    aiConfidenceThreshold: 0.55,
    whatsappDryRun: true,
    jwtSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    jwtAccessTtlSeconds: 900,
    jwtRefreshTtlSeconds: 2592000,
    quotaWarningThresholdPercent: 80,
    defaultQuotas: {
      leads: 10000,
      api_requests: 1000000,
      webhooks: 1000000,
      queue_jobs: 1000000
    },
    apiHost: "127.0.0.1",
    apiPort: 3000,
    workerConcurrency: 4,
    aiWorkerConcurrency: 2
  };
}

function aiJob(rawUtterance = "budget flexible till 1.2cr investment ke liye loan pending") {
  return {
    id: "ai-job-1",
    name: "lead_intelligence",
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      clientId,
      leadId,
      conversationId,
      rawUtterance,
      deterministic: {
        parsedAnswers: {},
        attributes: {},
        confidence: 0.72
      },
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
      ] as const,
      dedupeKey: "audit-ai-job",
      trace: {
        requestId: "req-audit",
        correlationId: "corr-audit",
        source: "webhook" as const,
        enqueuedAt: new Date().toISOString()
      }
    }
  };
}

function inboundBody() {
  return {
    client_id: clientId,
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "+919999999999" },
              contacts: [{ profile: { name: "Priya Shah" } }],
              messages: [
                {
                  id: "wamid.audit",
                  from: "919812345678",
                  text: {
                    body: "Budget 80 lakh to 1 crore in Whitefield within 2 months for investment"
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

function fakeInboundDb(runtimeConfig: ApiConfig) {
  const client = {
    id: clientId,
    name: "Audit Realty",
    status: "active",
    timezone: "Asia/Kolkata",
    whatsappProvider: "meta",
    whatsappConfig: {
      accessTokenEncrypted: encryptSecret("meta-access-token", runtimeConfig.APP_ENCRYPTION_KEY),
      phoneNumberId: "phone-number-id",
      fromNumber: "+919999999999",
      webhookSecretEncrypted: encryptSecret("meta-signing-secret", runtimeConfig.APP_ENCRYPTION_KEY),
      agentNotificationPhone: "+919876543210"
    },
    crmType: "custom",
    crmConfig: {
      endpoint: "https://crm.example.test/leads",
      method: "POST",
      authType: "none",
      fieldMap: {}
    }
  };
  const lead = {
    id: leadId,
    clientId,
    name: "Priya Shah",
    phone: "+919812345678",
    status: "new",
    score: 0,
    priority: "COLD",
    qualificationCompleteness: 0,
    intentConfidence: 0,
    idempotencyKey: "audit-existing",
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const conversation = {
    id: conversationId,
    leadId,
    channel: "whatsapp",
    state: "ASK_BUDGET",
    context: { lastOutboundAt: new Date(Date.now() - 60_000).toISOString(), responseCount: 0 },
    lastMessageAt: new Date()
  };
  const attributes = new Map<string, unknown>();
  const logs: unknown[] = [];
  const jobs = new Map<string, unknown>();

  const db = {
    logs,
    jobs,
    async $transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
      return fn(db);
    },
    async $executeRaw(): Promise<number> {
      return 1;
    },
    client: {
      async findUnique(): Promise<unknown> {
        return client;
      },
      async findFirst(): Promise<unknown> {
        return client;
      }
    },
    lead: {
      async findFirst(): Promise<unknown> {
        return {
          ...lead,
          attributes: Array.from(attributes.entries()).map(([key, value]) => ({ key, value })),
          conversation
        };
      },
      async update({ data }: { data: Record<string, unknown> }): Promise<unknown> {
        Object.assign(lead, data);
        return lead;
      },
      async count({ where }: { where: { status?: string } }): Promise<number> {
        return !where.status || lead.status === where.status ? 1 : 0;
      }
    },
    message: {
      async create(): Promise<unknown> {
        return { id: "message-audit" };
      },
      async findFirst(): Promise<unknown> {
        return null;
      }
    },
    leadAttribute: {
      async upsert({ where, create, update }: { where: { leadId_key: { key: string } }; create: { value: unknown }; update: { value: unknown } }): Promise<void> {
        attributes.set(where.leadId_key.key, update.value ?? create.value);
      }
    },
    conversation: {
      async update({ data }: { data: Record<string, unknown> }): Promise<unknown> {
        Object.assign(conversation, data);
        return conversation;
      }
    },
    auditLog: {
      async create({ data }: { data: unknown }): Promise<void> {
        logs.push(data);
      }
    },
    job: {
      async upsert({ where, create, update }: { where: { idempotencyKey: string }; create: unknown; update: unknown }): Promise<void> {
        jobs.set(where.idempotencyKey, jobs.has(where.idempotencyKey) ? update : create);
      }
    }
  };
  return db;
}

function processorDb() {
  const calls: Record<string, unknown[]> = {
    aiExecutionCreate: [],
    aiExecutionUpdate: [],
    aiCostMetricCreateMany: [],
    behavioralSignalCreate: [],
    emotionalProfileCreate: [],
    intentPredictionCreate: [],
    conversationalMemoryCreate: [],
    engagementPredictionCreate: [],
    aiSummaryCreate: [],
    aiRecommendationCreate: [],
    semanticEmbeddingUpsert: [],
    aiCostAllocationCreateMany: [],
    emotionalTimelineCreate: [],
    semanticNormalizationCreate: [],
    multilingualNormalizationCreate: [],
    aiSafetyViolationCreate: [],
    predictionDriftCreate: [],
    aiExecutionRecoveryCreate: [],
    jobUpsert: []
  };
  const db = {
    calls,
    async $transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
      return fn(db);
    },
    lead: {
      async findFirst(): Promise<unknown> {
        return { id: leadId, clientId };
      }
    },
    promptVersion: {
      async upsert(args: unknown): Promise<{ id: string }> {
        calls.promptVersionUpsert = [args];
        return { id: "prompt-version-1" };
      }
    },
    aiExecution: {
      async create(args: unknown): Promise<{ id: string }> {
        calls.aiExecutionCreate.push(args);
        return { id: "ai-execution-1" };
      },
      async update(args: unknown): Promise<void> {
        calls.aiExecutionUpdate.push(args);
      }
    },
    aiCostMetric: {
      async createMany(args: unknown): Promise<void> {
        calls.aiCostMetricCreateMany.push(args);
      }
    },
    aiCostAllocation: { async createMany(args: unknown): Promise<void> { calls.aiCostAllocationCreateMany.push(args); } },
    behavioralSignal: { async create(args: unknown): Promise<void> { calls.behavioralSignalCreate.push(args); } },
    emotionalProfile: { async create(args: unknown): Promise<void> { calls.emotionalProfileCreate.push(args); } },
    emotionalTimeline: { async create(args: unknown): Promise<void> { calls.emotionalTimelineCreate.push(args); } },
    intentPrediction: { async create(args: unknown): Promise<void> { calls.intentPredictionCreate.push(args); } },
    predictionDrift: { async create(args: unknown): Promise<void> { calls.predictionDriftCreate.push(args); } },
    semanticNormalization: { async create(args: unknown): Promise<void> { calls.semanticNormalizationCreate.push(args); } },
    multilingualNormalization: { async create(args: unknown): Promise<void> { calls.multilingualNormalizationCreate.push(args); } },
    conversationalMemory: { async create(args: unknown): Promise<void> { calls.conversationalMemoryCreate.push(args); } },
    engagementPrediction: { async create(args: unknown): Promise<void> { calls.engagementPredictionCreate.push(args); } },
    aiSummary: { async create(args: unknown): Promise<void> { calls.aiSummaryCreate.push(args); } },
    aiRecommendation: { async create(args: unknown): Promise<void> { calls.aiRecommendationCreate.push(args); } },
    aiSafetyViolation: { async create(args: unknown): Promise<void> { calls.aiSafetyViolationCreate.push(args); } },
    aiExecutionRecovery: { async create(args: unknown): Promise<void> { calls.aiExecutionRecoveryCreate.push(args); } },
    semanticEmbedding: { async upsert(args: unknown): Promise<void> { calls.semanticEmbeddingUpsert.push(args); } },
    job: {
      async upsert(args: unknown): Promise<void> {
        calls.jobUpsert.push(args);
      }
    }
  };
  return db;
}

describe("Phase 4 AI production audit validations", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("proves provider outage falls back to deterministic output with schema-valid result", async () => {
    const runtimeConfig = { ...config(), AI_PROVIDER: "openai" as const, aiProvider: "openai" as const, OPENAI_API_KEY: "test-key" };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("provider-outage");
    }));

    const result = await new AiRuntime(runtimeConfig, logger).executeLeadIntelligence(aiJob().data);

    expect(result.provider).toBe("deterministic");
    expect(result.fallbackUsed).toBe(true);
    expect(result.output.semantic.fields.financing_dependency).toBeDefined();
    expect(result.output.confidence).toBeGreaterThan(0.55);
  });

  it("proves malformed provider JSON falls back without throwing", async () => {
    const runtimeConfig = { ...config(), AI_PROVIDER: "openai" as const, aiProvider: "openai" as const, OPENAI_API_KEY: "test-key" };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{not-json" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
    })));

    const result = await new AiRuntime(runtimeConfig, logger).executeLeadIntelligence(aiJob().data);

    expect(result.provider).toBe("deterministic");
    expect(result.fallbackUsed).toBe(true);
  });

  it("proves webhook core flow succeeds when AI enqueue fails", async () => {
    const runtimeConfig = config();
    const queues = new AuditQueues();
    queues.failAiEnqueue = true;
    const service = new LeadService(fakeInboundDb(runtimeConfig) as never, queues as never, runtimeConfig, logger);
    const app = await buildApp({ service, logger, config: runtimeConfig });
    apps.push(app);
    const body = inboundBody();
    const rawBody = JSON.stringify(body);
    const signature = `sha256=${crypto.createHmac("sha256", "meta-signing-secret").update(rawBody).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/whatsapp/inbound",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature
      },
      payload: rawBody
    });

    expect(response.statusCode).toBe(200);
    expect(queues.sendMessages).toHaveLength(2);
    expect(queues.crmPushes).toHaveLength(1);
    expect(queues.aiJobs).toHaveLength(0);
  });

  it("proves AI processor persists traceable intelligence artifacts and cost rows", async () => {
    const db = processorDb();

    await processAiLeadIntelligence(aiJob(), {
      db: db as never,
      logger,
      config: config(),
      trace: {
        requestId: "req-audit",
        correlationId: "corr-audit",
        source: "worker",
        enqueuedAt: new Date().toISOString()
      }
    });

    expect(db.calls.aiExecutionCreate[0]).toMatchObject({
      data: {
        clientId,
        leadId,
        requestId: "req-audit",
        correlationId: "corr-audit",
        status: "running"
      }
    });
    expect(db.calls.aiExecutionUpdate[0]).toMatchObject({
      data: {
        status: "completed",
        provider: "deterministic",
        model: "rules-v1"
      }
    });
    expect((db.calls.aiCostMetricCreateMany[0] as { data: unknown[] }).data).toHaveLength(1);
    expect((db.calls.aiCostAllocationCreateMany[0] as { data: unknown[] }).data).toHaveLength(10);
    expect(db.calls.conversationalMemoryCreate.length).toBeGreaterThan(0);
    expect(db.calls.aiSummaryCreate.length).toBe(6);
    expect(db.calls.aiRecommendationCreate.length).toBeGreaterThan(0);
    expect(db.calls.semanticEmbeddingUpsert).toHaveLength(1);
    expect(db.calls.emotionalTimelineCreate).toHaveLength(1);
    expect(db.calls.semanticNormalizationCreate).toHaveLength(1);
    expect(db.calls.multilingualNormalizationCreate).toHaveLength(1);
    expect(db.calls.aiExecutionRecoveryCreate).toHaveLength(1);
  });

  it("proves semantic extraction covers required normalized cases", () => {
    const under80 = deterministicAiLeadIntelligence(aiJob("under 80L luxury only gated society next month").data);
    const sixMonths = deterministicAiLeadIntelligence(aiJob("within 6 months family shift karni hai").data);

    expect(under80.semantic.fields.budget?.value).toMatchObject({ max: 8000000 });
    expect(under80.semantic.fields.flexible_budget_range).toBeDefined();
    expect(under80.semantic.fields.preferred_amenities).toBeDefined();
    expect(under80.semantic.fields.luxury_sensitivity).toBeDefined();
    expect(under80.semantic.fields.purchase_timeline?.value).toMatchObject({ days: 30 });
    expect(sixMonths.semantic.fields.purchase_timeline?.value).toMatchObject({ days: 180 });
    expect(sixMonths.semantic.fields.family_intent).toBeDefined();
  });

  it("proves multilingual normalization maps required Hindi/Hinglish phrases", () => {
    const normalized = normalizeMixedLanguage("family shift karni hai next quarter purchase 50 lakh tak");

    expect(normalized.detected).toBe("hinglish");
    expect(normalized.normalizedText).toContain("family relocation");
    expect(normalized.normalizedText).toContain("purchase timeline next quarter");
    expect(normalized.normalizedText).toContain("up to");
  });
});
