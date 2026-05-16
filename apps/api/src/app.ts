import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { z } from "zod";

import { getMetricsRegistry, observeHttpLatency } from "@real-estate/utils";
import type { ApiConfig } from "@real-estate/config";
import { createChildLogger, setLogContext } from "@real-estate/logger";
import type { TraceContext } from "@real-estate/types";

import type { LeadService } from "./services/lead-service";

const leadHeadersSchema = z.object({
  "x-api-key": z.string().min(1),
  "idempotency-key": z.string().min(8).max(128)
});
const authHeadersSchema = z.object({
  "x-api-key": z.string().min(1)
});
const bearerHeadersSchema = z.object({
  authorization: z.string().regex(/^Bearer\s+\S+$/i)
});

export async function buildApp(options: {
  service: LeadService;
  logger: Logger;
  config: ApiConfig;
}) {
  const getRequestId = (headerValue: string | string[] | undefined): string => {
    if (typeof headerValue === "string" && headerValue.trim().length > 0) {
      return headerValue.trim().slice(0, 128);
    }

    return randomUUID();
  };

  const getCorrelationId = (
    headerValue: string | string[] | undefined,
    requestId: string
  ): string => {
    if (typeof headerValue === "string" && headerValue.trim().length > 0) {
      return headerValue.trim().slice(0, 128);
    }

    return requestId;
  };

  const buildTrace = (request: { id: string; correlationId: string }): TraceContext => ({
    requestId: request.id,
    correlationId: request.correlationId
  });

  const timed = async <T>(
    request: FastifyRequest,
    operation: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await task();
    } finally {
      const durationMs = performance.now() - startedAt;
      request.log.info(
        {
          request_id: request.id,
          operation,
          duration_ms: Math.round(durationMs)
        },
        "request.operation.timing"
      );
    }
  };

  const auditDenied = async (
    request: FastifyRequest,
    action: string,
    actorType: string,
    actorId?: string | null,
    clientId?: string | null
  ): Promise<void> => {
    await options.service.auditUnauthorized({
      clientId,
      actorType,
      actorId,
      action,
      entity: "Route",
      entityId: request.routeOptions.url ?? request.url,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
      trace: buildTrace(request)
    });
  };

  const requireUser = (permissions: string[] = []) => async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = bearerHeadersSchema.safeParse(request.headers);
    if (!headers.success) {
      await auditDenied(request, "auth.missing_bearer", "anonymous");
      void reply.code(401).send({ error: "Unauthorized" });
      return null;
    }

    const token = headers.data.authorization.replace(/^Bearer\s+/i, "");
    const user = await options.service.authenticateJwt(token);
    if (!user) {
      await auditDenied(request, "auth.invalid_bearer", "anonymous");
      void reply.code(401).send({ error: "Unauthorized" });
      return null;
    }

    const permitted = user.roles.includes("SUPER_ADMIN") || permissions.every((permission) => user.permissions.includes(permission));
    if (!permitted) {
      await auditDenied(request, "auth.permission_denied", "user", user.id, user.clientId);
      void reply.code(403).send({ error: "Forbidden" });
      return null;
    }

    request.auth = { ...(request.auth ?? {}), user };
    return user;
  };

  const app = Fastify({
    loggerInstance: options.logger,
    genReqId(request) {
      return getRequestId(request.headers["x-request-id"]);
    },
    requestIdHeader: "x-request-id",
    disableRequestLogging: true,
    bodyLimit: options.config.requestBodyLimitBytes,
    childLoggerFactory(parent, bindings, _opts, rawReq) {
      const requestId = typeof bindings.reqId === "string" ? bindings.reqId : getRequestId(rawReq.headers["x-request-id"]);
      const correlationId = getCorrelationId(rawReq.headers["x-correlation-id"], requestId);
      return createChildLogger(parent, {
        ...bindings,
        request_id: requestId,
        correlation_id: correlationId
      });
    }
  });

  await app.register(helmet);
  await app.register(formbody);
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = getCorrelationId(request.headers["x-correlation-id"], request.id);
    reply.header("x-request-id", request.id);
    reply.header("x-correlation-id", request.correlationId);
    setLogContext({
      request_id: request.id,
      correlation_id: request.correlationId
    });
    request.log.info({ request_id: request.id, method: request.method, url: request.url }, "request.start");
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? request.url;
    observeHttpLatency(request.method, route, reply.statusCode, reply.elapsedTime);
    request.log.info(
      {
        request_id: request.id,
        status_code: reply.statusCode,
        latency_ms: reply.elapsedTime
      },
      "request.complete"
    );
  });

  app.get("/health", async () => options.service.healthCheck());

  app.get("/ready", async () => options.service.healthCheck());

  app.get("/live", async () => ({ ok: true }));

  app.get("/metrics", async (_request, reply) => {
    const registry = getMetricsRegistry();
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  app.post("/leads", { bodyLimit: options.config.requestBodyLimitBytes }, async (request, reply) => {
    const headers = leadHeadersSchema.parse(request.headers);
    const auth = await options.service.authenticateApiKey(headers["x-api-key"]);
    if (!auth) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    await Promise.all([
      options.service.enforceRateLimit(`api:${auth.id}`, {
        limit: options.config.API_RATE_LIMIT_PER_MINUTE,
        windowSeconds: options.config.apiRateLimitWindowSeconds,
        clientId: auth.clientId
      }),
      options.service.enforceRateLimit(`api-ip:${request.ip}`, {
        limit: options.config.API_RATE_LIMIT_PER_MINUTE * 2,
        windowSeconds: options.config.apiRateLimitWindowSeconds
      })
    ]);
    await options.service.enforceQuota({ clientId: auth.clientId, metric: "api_requests", trace: buildTrace(request) });
    const result = await timed(request, "lead.create", () =>
      options.service.createLead({
        auth,
        idempotencyKey: headers["idempotency-key"],
        body: request.body,
        trace: buildTrace(request)
      })
    );

    return reply.code(result.created ? 201 : 200).send({
      lead_id: result.leadId,
      created: result.created
    });
  });

  app.post("/auth/login", async (request, reply) => {
    const result = await timed(request, "auth.login", () =>
      options.service.login({
        body: request.body,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        trace: buildTrace(request)
      })
    );
    return reply.code(200).send(result);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const result = await timed(request, "auth.refresh", () =>
      options.service.refreshSession({
        body: request.body,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        trace: buildTrace(request)
      })
    );
    return reply.code(200).send(result);
  });

  async function authenticateDashboard(request: FastifyRequest, reply: FastifyReply) {
    const headers = authHeadersSchema.parse(request.headers);
    const auth = await options.service.authenticateApiKey(headers["x-api-key"]);
    if (!auth) {
      void reply.code(401).send({ error: "Unauthorized" });
      return null;
    }

    await options.service.enforceRateLimit(`dashboard:${auth.id}`, {
      limit: options.config.API_RATE_LIMIT_PER_MINUTE,
      windowSeconds: options.config.apiRateLimitWindowSeconds,
      clientId: auth.clientId
    });
    return auth;
  }

  app.get("/dashboard/leads", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    return timed(request, "dashboard.leads.list", () =>
      options.service.listDashboardLeads({ auth, query: request.query })
    );
  });

  app.get("/dashboard/leads/:id", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return timed(request, "dashboard.leads.get", () =>
      options.service.getDashboardLead({ auth, leadId: params.id })
    );
  });

  app.get("/dashboard/leads/:id/memory", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return timed(request, "dashboard.leads.memory", () =>
      options.service.retrieveLeadMemory({ auth, leadId: params.id, query: request.query })
    );
  });

  app.get("/dashboard/leads/:id/memory/benchmark", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return timed(request, "dashboard.leads.memory.benchmark", () =>
      options.service.benchmarkLeadMemoryRetrieval({ auth, leadId: params.id, query: request.query })
    );
  });

  app.get("/dashboard/analytics", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    return timed(request, "dashboard.analytics", () =>
      options.service.getDashboardAnalytics({ auth })
    );
  });

  app.get("/dashboard/pipeline", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    return timed(request, "dashboard.pipeline", () =>
      options.service.getDashboardPipeline({ auth })
    );
  });

  app.get("/dashboard/intelligence", async (request, reply) => {
    const user = await requireUser(["analytics:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "dashboard.intelligence", () =>
      options.service.getEnterpriseIntelligenceAnalytics({ auth: user, query: request.query })
    );
  });

  app.get("/dashboard/followups", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    return timed(request, "dashboard.followups.list", () =>
      options.service.listDashboardFollowups({ auth, query: request.query })
    );
  });

  app.get("/api-keys", async (request, reply) => {
    const user = await requireUser(["api_keys:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "api_keys.list", () => options.service.listApiKeys({ auth: user }));
  });

  app.post("/api-keys", async (request, reply) => {
    const user = await requireUser(["api_keys:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "api_keys.create", () =>
      options.service.createApiKey({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.post("/api-keys/:id/revoke", async (request, reply) => {
    const user = await requireUser(["api_keys:write"])(request, reply);
    if (!user) {
      return;
    }

    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return timed(request, "api_keys.revoke", () =>
      options.service.revokeApiKey({ auth: user, apiKeyId: params.id, trace: buildTrace(request) })
    );
  });

  app.get("/audit-events", async (request, reply) => {
    const user = await requireUser(["audit:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "audit_events.list", () =>
      options.service.listAuditEvents({ auth: user, query: request.query })
    );
  });

  app.get("/usage", async (request, reply) => {
    const user = await requireUser(["usage:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "usage.get", () =>
      options.service.getTenantUsage({ auth: user, query: request.query })
    );
  });

  app.get("/internal/admin/jobs/failed", async (request, reply) => {
    const user = await requireUser(["admin:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "admin.jobs.failed", () =>
      options.service.inspectFailedJobs({ auth: user, query: request.query })
    );
  });

  app.post("/internal/admin/jobs/replay", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "admin.jobs.replay", () =>
      options.service.replayFailedJob({ auth: user, body: request.body, trace: buildTrace(request) })
    );
  });

  app.post("/internal/admin/evaluation/datasets", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "admin.evaluation.dataset.upsert", () =>
      options.service.createEvaluationDataset({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.post("/internal/admin/evaluation/runs", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "admin.evaluation.run.schedule", () =>
      options.service.scheduleEvaluationRun({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(202).send(result);
  });

  app.post("/feedback", async (request, reply) => {
    const user = await requireUser(["feedback:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "feedback.ingest", () =>
      options.service.ingestFeedbackEvent({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.post("/internal/admin/slo/definitions", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "admin.slo.definition.upsert", () =>
      options.service.upsertSloDefinition({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.post("/internal/admin/slo/evaluate", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "admin.slo.evaluate", () =>
      options.service.evaluateSlo({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.post("/internal/admin/chaos/logs", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const result = await timed(request, "admin.chaos.log", () =>
      options.service.recordChaosScenario({ auth: user, body: request.body, trace: buildTrace(request) })
    );
    return reply.code(201).send(result);
  });

  app.get("/internal/admin/queues/health", async (request, reply) => {
    const user = await requireUser(["admin:read"])(request, reply);
    if (!user) {
      return;
    }

    return timed(request, "admin.queues.health", () => options.service.inspectQueueHealth());
  });

  app.post("/internal/admin/queues/:queue/pause", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const params = z.object({ queue: z.string().min(1).max(64) }).parse(request.params);
    return timed(request, "admin.queues.pause", () =>
      options.service.pauseQueue({ queue: params.queue, auth: user, trace: buildTrace(request) })
    );
  });

  app.post("/internal/admin/queues/:queue/resume", async (request, reply) => {
    const user = await requireUser(["admin:write"])(request, reply);
    if (!user) {
      return;
    }

    const params = z.object({ queue: z.string().min(1).max(64) }).parse(request.params);
    return timed(request, "admin.queues.resume", () =>
      options.service.resumeQueue({ queue: params.queue, auth: user, trace: buildTrace(request) })
    );
  });

  app.post(
    "/whatsapp/inbound",
    {
      config: { rawBody: true },
      bodyLimit: options.config.webhookBodyLimitBytes
    },
    async (request, reply) => {
    const result = await options.service.handleInboundWebhook({
      headers: request.headers,
      body: request.body,
      rawBody: typeof request.rawBody === "string" ? request.rawBody : request.rawBody?.toString("utf8") ?? "",
      requestUrl: options.config.WEBHOOK_BASE_URL,
      requestIp: request.ip,
      trace: buildTrace(request)
    });

      return reply.code(200).send(result);
    }
  );

  app.setErrorHandler((error, request, reply) => {
    const typedError = error as Error & { statusCode?: number };
    const statusCode = error instanceof z.ZodError ? 400 : typedError.statusCode ?? 500;
    request.log.error({ err: error, request_id: request.id }, "request.error");
    if (error instanceof z.ZodError) {
      return reply.code(statusCode).send({
        error: "Validation failed",
        details: error.flatten()
      });
    }

    const publicMessage = statusCode >= 500 ? "Internal Server Error" : typedError.message;
    return reply.code(statusCode).send({
      error: publicMessage
    });
  });

  return app;
}
