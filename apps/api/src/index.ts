import "dotenv/config";

import { getApiConfig } from "@real-estate/config";
import { db } from "@real-estate/db";
import { createLogger } from "@real-estate/logger";
import {
  assertRedisCompatibleWithBullMq,
  buildBullMqConnection,
  createQueueMetricsHandle,
  createRedisClient,
  initializeMetrics,
  redactRedisConnection
} from "@real-estate/utils";

import { buildApp } from "./app";
import { LeadService } from "./services/lead-service";
import { QueuePublisher } from "./services/queue-publisher";

async function main(): Promise<void> {
  const config = getApiConfig();
  initializeMetrics("api");

  const logger = createLogger("api", config.LOG_LEVEL);
  logger.info({ redis: redactRedisConnection(config.redisConnection) }, "redis.connection.config");

  const redis = createRedisClient(config.redisConnection, {
    connectionName: "api-runtime"
  });
  const redisCapabilities = await assertRedisCompatibleWithBullMq(redis, config.redisConnection);
  logger.info(
    {
      redis: {
        ...redactRedisConnection(config.redisConnection),
        version: redisCapabilities.version,
        mode: redisCapabilities.mode
      }
    },
    "redis.compatibility.verified"
  );

  const bullmqConnection = buildBullMqConnection(config.redisConnection, {
    connectionName: "api-bullmq"
  });
  const queues = new QueuePublisher(redis, bullmqConnection, {
    prefix: config.QUEUE_PREFIX,
    messageAttempts: config.MESSAGE_MAX_RETRIES,
    followupAttempts: config.followupMaxRetries,
    crmAttempts: config.CRM_MAX_RETRIES,
    aiAttempts: config.aiMaxRetries,
    evaluationAttempts: config.evaluationMaxRetries,
    retryBackoffMs: config.queueRetryBackoffMs
  });
  await queues.healthCheck();
  const queueMetrics = createQueueMetricsHandle({
    queues: queues.getMetricsTargets(),
    intervalMs: config.queueMetricsSampleIntervalMs,
    logger
  });
  await queueMetrics.sample();

  const service = new LeadService(db, queues, config, logger);
  const app = await buildApp({ service, logger, config });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown.start");
    await app.close();
    await queueMetrics.close();
    await queues.close();
    await redis.quit();
    await db.$disconnect();
    logger.info({ signal }, "shutdown.complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({
    host: config.apiHost,
    port: config.apiPort
  });
}

main().catch(async (error) => {
  const logger = createLogger("api-bootstrap");
  logger.error({ err: error }, "api.startup.failed");
  await db.$disconnect();
  process.exit(1);
});
