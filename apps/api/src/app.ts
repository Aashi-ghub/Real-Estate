import Fastify from "fastify";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { z } from "zod";

import { getMetricsRegistry, observeHttpLatency } from "@real-estate/utils";

import type { LeadService } from "./services/lead-service";

const leadHeadersSchema = z.object({
  "x-api-key": z.string().min(1),
  "idempotency-key": z.string().min(8).max(128)
});

export async function buildApp(options: {
  service: LeadService;
  logger: Logger;
}) {
  const app = Fastify({
    loggerInstance: options.logger,
    requestIdHeader: "x-request-id",
    disableRequestLogging: true
  });

  await app.register(helmet);
  await app.register(formbody);
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  app.addHook("onRequest", async (request) => {
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

  app.post("/leads", async (request, reply) => {
    const headers = leadHeadersSchema.parse(request.headers);
    const auth = await options.service.authenticateApiKey(headers["x-api-key"]);
    if (!auth) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    await options.service.enforceRateLimit(auth.id);
    const result = await options.service.createLead({
      auth,
      idempotencyKey: headers["idempotency-key"],
      body: request.body
    });

    return reply.code(result.created ? 201 : 200).send({
      lead_id: result.leadId,
      created: result.created
    });
  });

  app.post("/whatsapp/inbound", { config: { rawBody: true } }, async (request, reply) => {
    const result = await options.service.handleInboundWebhook({
      headers: request.headers,
      body: request.body,
      rawBody: typeof request.rawBody === "string" ? request.rawBody : request.rawBody?.toString("utf8") ?? "",
      requestUrl: request.url
    });

    return reply.code(200).send(result);
  });

  app.setErrorHandler((error, request, reply) => {
    const typedError = error as Error & { statusCode?: number };
    const statusCode = error instanceof z.ZodError ? 400 : typedError.statusCode ?? 500;
    request.log.error({ err: error, request_id: request.id }, "request.error");
    return reply.code(statusCode).send(error instanceof z.ZodError
      ? {
          error: "Validation failed",
          details: error.flatten()
        }
      : {
          error: typedError.message,
      });
  });

  return app;
}
