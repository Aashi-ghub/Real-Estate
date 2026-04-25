import IORedis from "ioredis";

import { getApiConfig } from "@real-estate/config";
import { db } from "@real-estate/db";
import { createLogger } from "@real-estate/logger";
import { initializeMetrics } from "@real-estate/utils";

import { buildApp } from "./app";
import { LeadService } from "./services/lead-service";
import { QueuePublisher } from "./services/queue-publisher";

async function main(): Promise<void> {
  const config = getApiConfig();
  initializeMetrics("api");

  const logger = createLogger("api", config.LOG_LEVEL);
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false
  });
  const queues = new QueuePublisher(redis, {
    prefix: config.QUEUE_PREFIX,
    messageAttempts: config.MESSAGE_MAX_RETRIES,
    crmAttempts: config.CRM_MAX_RETRIES
  });
  const service = new LeadService(db, queues, config, logger);
  const app = await buildApp({ service, logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown.start");
    await app.close();
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
