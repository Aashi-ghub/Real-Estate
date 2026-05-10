import crypto from "node:crypto";

import { createLogger } from "@real-estate/logger";
import type { ApiConfig } from "@real-estate/config";
import { buildApp } from "../../apps/api/src/app";
import { LeadService } from "../../apps/api/src/services/lead-service";
import { encryptSecret, hashApiKey } from "@real-estate/utils";
import { afterEach, describe, expect, it } from "vitest";

const createLeadClientId = "22222222-2222-4222-8222-222222222222";

class FakeRedis {
  private readonly counters = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async ping(): Promise<string> {
    return "PONG";
  }
}

class FakeQueues {
  readonly redis = new FakeRedis();
  readonly sendMessages: unknown[] = [];
  readonly followups: unknown[] = [];
  readonly crmPushes: unknown[] = [];

  async enqueueSendMessage(payload: unknown): Promise<void> {
    this.sendMessages.push(payload);
  }

  async enqueueFollowup(payload: unknown): Promise<void> {
    this.followups.push(payload);
  }

  async enqueueCrmPush(payload: unknown): Promise<void> {
    this.crmPushes.push(payload);
  }

  async close(): Promise<void> {
    return;
  }

  async healthCheck(): Promise<void> {
    await this.redis.ping();
  }
}

function createApiConfig(): ApiConfig {
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
    API_RATE_LIMIT_PER_MINUTE: 120,
    WEBHOOK_BASE_URL: "http://localhost:3000/whatsapp/inbound",
    WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: 300,
    WORKER_CONCURRENCY: 1,
    FOLLOWUP_DELAY_MINUTES: 30,
    MESSAGE_MAX_RETRIES: 3,
    CRM_MAX_RETRIES: 3,
    QUEUE_PREFIX: "test",
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
    apiHost: "127.0.0.1",
    apiPort: 3000
  };
}

class FakeDb {
  readonly logs: unknown[] = [];
  readonly jobs = new Map<string, unknown>();
  readonly attributes = new Map<string, Map<string, unknown>>();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly clients: Array<Record<string, unknown>>;
  readonly apiKeysStore: Array<Record<string, unknown>>;
  readonly leads: Array<Record<string, unknown>>;
  readonly conversations: Array<Record<string, unknown>>;

  constructor(config: ApiConfig) {
    const hashedApiKey = hashApiKey("test-api-key", config.APP_ENCRYPTION_KEY);
    const metaSecret = "meta-signing-secret";
    const client = {
      id: "client-1",
      name: "Acme Realty",
      status: "active",
      timezone: "Asia/Kolkata",
      whatsappProvider: "meta",
      whatsappConfig: {
        accessTokenEncrypted: encryptSecret("meta-access-token", config.APP_ENCRYPTION_KEY),
        phoneNumberId: "phone-number-id",
        fromNumber: "+919999999999",
        webhookSecretEncrypted: encryptSecret(metaSecret, config.APP_ENCRYPTION_KEY),
        agentNotificationPhone: "+919876543210"
      },
      crmType: "custom",
      crmConfig: {
        endpoint: "https://crm.example.test/leads",
        method: "POST",
        authType: "none",
        fieldMap: {
          "lead.id": "lead_id"
        }
      }
    };

    this.clients = [client];
    this.apiKeysStore = [
      {
        id: "api-key-1",
        clientId: client.id,
        hashedKey: hashedApiKey,
        status: "active",
        client: {
          status: "active"
        }
      }
    ];
    this.leads = [
      {
        id: "lead-existing",
        clientId: client.id,
        name: "Priya Shah",
        phone: "+919812345678",
        email: null,
        source: "website",
        status: "new",
        score: 0,
        idempotencyKey: "existing-key",
        createdAt: new Date("2026-04-24T09:00:00.000Z"),
        updatedAt: new Date("2026-04-24T09:00:00.000Z")
      }
    ];
    this.conversations = [
      {
        id: "conversation-existing",
        leadId: "lead-existing",
        channel: "whatsapp",
        state: "ASK_BUDGET",
        context: {
          lastOutboundAt: "2026-04-24T09:10:00.000Z",
          responseCount: 0
        },
        lastMessageAt: new Date("2026-04-24T09:10:00.000Z")
      }
    ];
    this.attributes.set("lead-existing", new Map());
  }

  async $transaction<T>(fn: (db: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async $queryRaw(): Promise<number> {
    return 1;
  }

  async $executeRaw(): Promise<number> {
    return 1;
  }

  readonly apiKey: {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  } = {
    findFirst: async () => null,
    update: async () => undefined
  };

  readonly client: {
    findUnique: (args: unknown) => Promise<unknown>;
    findFirst?: (args: unknown) => Promise<unknown>;
  } = {
    findUnique: async () => null
  };

  readonly lead: {
    findUnique: (args: unknown) => Promise<unknown>;
    create?: (args: unknown) => Promise<unknown>;
    count?: (args: unknown) => Promise<number>;
    findFirst?: (args: unknown) => Promise<unknown>;
    update?: (args: unknown) => Promise<unknown>;
  } = {
    findUnique: async () => null
  };

  readonly conversation: {
    update: (args: unknown) => Promise<unknown>;
  } = {
    update: async () => undefined
  };

  readonly leadAttribute: {
    upsert: (args: unknown) => Promise<unknown>;
  } = {
    upsert: async () => undefined
  };

  readonly message: {
    create: (args: unknown) => Promise<unknown>;
  } = {
    create: async () => undefined
  };

  readonly auditLog: {
    create: (args: unknown) => Promise<unknown>;
  } = {
    create: async () => undefined
  };

  readonly job: {
    upsert: (args: unknown) => Promise<unknown>;
  } = {
    upsert: async () => undefined
  };
}

function buildMetaWebhookBody(clientId: string): Record<string, unknown> {
  return {
    client_id: clientId,
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: {
                display_phone_number: "+919999999999"
              },
              contacts: [
                {
                  profile: {
                    name: "Priya Shah"
                  }
                }
              ],
              messages: [
                {
                  id: "wamid.12345",
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

describe("API integration", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates a lead and enqueues the intro message", async () => {
    const config = createApiConfig();
    const queues = new FakeQueues();
    const db = createCreateLeadFakeDb(config);
    const service = new LeadService(db as never, queues as never, config, createLogger("test", "fatal"));
    const app = await buildApp({ service, logger: createLogger("test", "fatal") });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/leads",
      headers: {
        "x-api-key": "test-api-key",
        "idempotency-key": "lead-12345678"
      },
      payload: {
        client_id: createLeadClientId,
        name: "Rohan Mehta",
        phone: "+919811112222",
        source: "landing-page"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      lead_id: "lead-1",
      created: true
    });
    expect(queues.sendMessages).toHaveLength(1);
    expect(queues.sendMessages[0]).toMatchObject({
      reason: "intro",
      leadId: "lead-1"
    });
  });

  it("processes an inbound webhook, advances state, and enqueues outbound + CRM jobs", async () => {
    const config = createApiConfig();
    const db = createInboundFakeDb(config);
    const queues = new FakeQueues();
    const service = new LeadService(db as never, queues as never, config, createLogger("test", "fatal"));
    const app = await buildApp({ service, logger: createLogger("test", "fatal") });
    apps.push(app);

    const body = buildMetaWebhookBody("client-1");
    const rawBody = JSON.stringify(body);
    const signature = `sha256=${crypto
      .createHmac("sha256", "meta-signing-secret")
      .update(rawBody)
      .digest("hex")}`;

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
    expect(response.json()).toEqual({
      status: "processed",
      leadId: "lead-existing"
    });
    expect(queues.sendMessages).toHaveLength(2);
    expect(queues.sendMessages[0]).toMatchObject({
      reason: "qualification_ack"
    });
    expect(queues.sendMessages[1]).toMatchObject({
      reason: "agent_notification"
    });
    expect(queues.crmPushes).toHaveLength(1);
  });
});

function createCreateLeadFakeDb(config: ApiConfig): FakeDb {
  const db = new FakeDb(config);
  db.clients[0] = {
    ...db.clients[0],
    id: createLeadClientId,
    whatsappProvider: "twilio",
    whatsappConfig: {
      fromNumber: "whatsapp:+14155238886"
    }
  };
  db.apiKeysStore[0] = {
    ...db.apiKeysStore[0],
    clientId: createLeadClientId
  };
  db.leads.length = 0;
  db.conversations.length = 0;

  db.apiKey.findFirst = async ({ where }: { where: { hashedKey: string } }) =>
    db.apiKeysStore.find((record) => record.hashedKey === where.hashedKey) ?? null;
  db.apiKey.update = async () => undefined;
  db.lead.findUnique = async ({ where }: { where: { idempotencyKey: string } }) =>
    db.leads.find((lead) => lead.idempotencyKey === where.idempotencyKey) ?? null;
  db.lead.create = async ({ data }: { data: Record<string, unknown> }) => {
    const lead = {
      id: "lead-1",
      clientId: data.clientId,
      name: data.name,
      phone: data.phone,
      email: data.email ?? null,
      source: data.source,
      status: "new",
      score: 0,
      idempotencyKey: data.idempotencyKey,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const conversation = {
      id: "conversation-1",
      leadId: "lead-1",
      channel: "whatsapp",
      state: "INIT",
      context: { responseCount: 0 },
      lastMessageAt: null
    };
    db.leads.push(lead);
    db.conversations.push(conversation);
    db.attributes.set("lead-1", new Map());
    return {
      ...lead,
      conversation
    };
  };
  db.lead.count = async ({ where }: { where: { clientId: string; status?: string } }) =>
    db.leads.filter((lead) => lead.clientId === where.clientId && (!where.status || lead.status === where.status)).length;
  db.auditLog.create = async ({ data }: { data: unknown }) => {
    db.logs.push(data);
  };
  db.job.upsert = async ({ create, update, where }: { create: unknown; update: unknown; where: { idempotencyKey: string } }) => {
    db.jobs.set(where.idempotencyKey, db.jobs.get(where.idempotencyKey) ? update : create);
  };

  return db;
}

function createInboundFakeDb(config: ApiConfig): FakeDb {
  const db = new FakeDb(config);
  db.apiKey.findFirst = async () => null;
  db.client.findUnique = async ({ where }: { where: { id: string } }) =>
    db.clients.find((client) => client.id === where.id) ?? null;
  db.client.findFirst = async () => db.clients[0] ?? null;
  db.lead.findFirst = async ({ where }: { where: { clientId: string; phone: string } }) => {
    const lead = db.leads.find((entry) => entry.clientId === where.clientId && entry.phone === where.phone);
    if (!lead) {
      return null;
    }

    return {
      ...lead,
      attributes: Array.from(db.attributes.get(lead.id)?.entries() ?? []).map(([key, value]) => ({ key, value })),
      conversation: db.conversations.find((conversation) => conversation.leadId === lead.id) ?? null
    };
  };
  db.lead.update = async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const lead = db.leads.find((entry) => entry.id === where.id);
    if (lead) {
      Object.assign(lead, data, { updatedAt: new Date() });
    }
    return lead;
  };
  db.lead.count = async ({ where }: { where: { clientId: string; status?: string } }) =>
    db.leads.filter((lead) => lead.clientId === where.clientId && (!where.status || lead.status === where.status)).length;
  db.message.create = async ({ data }: { data: Record<string, unknown> }) => {
    db.messages.push({ id: `message-${db.messages.length + 1}`, ...data });
    return db.messages.at(-1);
  };
  db.leadAttribute.upsert = async ({
    where,
    create,
    update
  }: {
    where: { leadId_key: { leadId: string; key: string } };
    create: { value: unknown };
    update: { value: unknown };
  }) => {
    const map = db.attributes.get(where.leadId_key.leadId) ?? new Map();
    map.set(where.leadId_key.key, update.value ?? create.value);
    db.attributes.set(where.leadId_key.leadId, map);
  };
  db.conversation.update = async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const conversation = db.conversations.find((entry) => entry.id === where.id);
    if (conversation) {
      Object.assign(conversation, data);
    }
    return conversation;
  };
  db.auditLog.create = async ({ data }: { data: unknown }) => {
    db.logs.push(data);
  };
  db.job.upsert = async ({ create, update, where }: { create: unknown; update: unknown; where: { idempotencyKey: string } }) => {
    db.jobs.set(where.idempotencyKey, db.jobs.get(where.idempotencyKey) ? update : create);
  };

  return db;
}
