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
        windowSeconds: options.config.apiRateLimitWindowSeconds
      }),
      options.service.enforceRateLimit(`api-ip:${request.ip}`, {
        limit: options.config.API_RATE_LIMIT_PER_MINUTE * 2,
        windowSeconds: options.config.apiRateLimitWindowSeconds
      })
    ]);
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

  async function authenticateDashboard(request: FastifyRequest, reply: FastifyReply) {
    const headers = authHeadersSchema.parse(request.headers);
    const auth = await options.service.authenticateApiKey(headers["x-api-key"]);
    if (!auth) {
      void reply.code(401).send({ error: "Unauthorized" });
      return null;
    }

    await options.service.enforceRateLimit(`dashboard:${auth.id}`, {
      limit: options.config.API_RATE_LIMIT_PER_MINUTE,
      windowSeconds: options.config.apiRateLimitWindowSeconds
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

  app.get("/dashboard/followups", async (request, reply) => {
    const auth = await authenticateDashboard(request, reply);
    if (!auth) {
      return;
    }

    return timed(request, "dashboard.followups.list", () =>
      options.service.listDashboardFollowups({ auth, query: request.query })
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
