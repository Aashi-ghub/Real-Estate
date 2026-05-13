import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "@real-estate/logger";
import type { ApiConfig } from "@real-estate/config";
import { buildApp } from "../../apps/api/src/app";

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
    API_RATE_LIMIT_WINDOW_SECONDS: 60,
    WEBHOOK_RATE_LIMIT_PER_MINUTE: 300,
    WEBHOOK_RATE_LIMIT_WINDOW_SECONDS: 60,
    WEBHOOK_BASE_URL: "http://localhost:3000/whatsapp/inbound",
    WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: 300,
    WEBHOOK_REPLAY_TTL_SECONDS: 86400,
    REQUEST_BODY_LIMIT_BYTES: 262144,
    WEBHOOK_BODY_LIMIT_BYTES: 262144,
    WORKER_CONCURRENCY: 1,
    FOLLOWUP_DELAY_MINUTES: 30,
    MESSAGE_MAX_RETRIES: 3,
    FOLLOWUP_MAX_RETRIES: 3,
    CRM_MAX_RETRIES: 3,
    QUEUE_RETRY_BACKOFF_MS: 1000,
    QUEUE_RETRY_BACKOFF_MAX_MS: 60000,
    QUEUE_METRICS_SAMPLE_INTERVAL_MS: 10000,
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
    apiHost: "127.0.0.1",
    apiPort: 3000
  };
}

describe("dashboard API", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("authenticates dashboard requests and forwards tenant-scoped filters", async () => {
    const service = {
      authenticateApiKey: async (apiKey: string) =>
        apiKey === "dashboard-key"
          ? { id: "api-key-1", clientId: "client-1", clientStatus: "active" }
          : null,
      enforceRateLimit: async () => undefined,
      listDashboardLeads: async ({ auth, query }: { auth: { clientId: string }; query: Record<string, unknown> }) => ({
        page: Number(query.page ?? 1),
        page_size: Number(query.page_size ?? 25),
        total: 1,
        leads: [
          {
            id: "lead-1",
            clientId: auth.clientId,
            priority: query.priority,
            status: query.status
          }
        ]
      }),
      healthCheck: async () => ({ ok: true, postgres: "up", redis: "up", queues: "up" })
    };
    const app = await buildApp({
      service: service as never,
      logger: createLogger("test", "fatal"),
      config: createApiConfig()
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/dashboard/leads?page=2&page_size=10&priority=HOT&status=qualified",
      headers: {
        "x-api-key": "dashboard-key"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      page: 2,
      page_size: 10,
      leads: [
        {
          clientId: "client-1",
          priority: "HOT",
          status: "qualified"
        }
      ]
    });
  });
});
