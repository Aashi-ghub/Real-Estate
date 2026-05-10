import { Worker } from "bullmq";

import { getWorkerConfig } from "@real-estate/config";
import { db, upsertJobMirror } from "@real-estate/db";
import { createLogger } from "@real-estate/logger";
import { queueNames } from "@real-estate/types";
import {
  assertRedisCompatibleWithBullMq,
  buildBullMqConnection,
  createRedisClient,
  initializeMetrics,
  redactRedisConnection,
  runBullMqRoundTripHealthcheck
} from "@real-estate/utils";

import { processCrmPush } from "./processors/crm";
import { processFollowup } from "./processors/followup";
import { processSendMessage } from "./processors/send-message";
import { WorkerQueues } from "./services/queue-runtime";

async function main(): Promise<void> {
  const config = getWorkerConfig();
  initializeMetrics("worker");

  const logger = createLogger("worker", config.LOG_LEVEL);
  logger.info({ redis: redactRedisConnection(config.redisConnection) }, "redis.connection.config");

  const redis = createRedisClient(config.redisConnection, {
    connectionName: "worker-runtime"
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
    connectionName: "worker-bullmq"
  });
  const queues = new WorkerQueues(bullmqConnection, {
    prefix: config.QUEUE_PREFIX,
    messageAttempts: config.MESSAGE_MAX_RETRIES,
    crmAttempts: config.CRM_MAX_RETRIES
  });
  await queues.waitUntilReady();
  await runBullMqRoundTripHealthcheck({
    connection: bullmqConnection,
    prefix: config.QUEUE_PREFIX,
    instanceName: `worker-${process.pid}`,
    logger
  });

  const messageWorker = new Worker(
    queueNames.messages,
    (job) => processSendMessage(job, { db, logger, config, queues }),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: config.workerConcurrency
    }
  );
  const followupWorker = new Worker(
    queueNames.followups,
    (job) => processFollowup(job, { db, logger, config, queues }),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: Math.max(1, Math.floor(config.workerConcurrency / 2))
    }
  );
  const crmWorker = new Worker(
    queueNames.crm,
    (job) => processCrmPush(job, { db, logger, config, queues }),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: Math.max(1, Math.floor(config.workerConcurrency / 2))
    }
  );

  await Promise.all([
    messageWorker.waitUntilReady(),
    followupWorker.waitUntilReady(),
    crmWorker.waitUntilReady()
  ]);

  const attachDeadLetter = (
    worker: Worker,
    queueName: string,
    addToDlq: (payload: Record<string, unknown>, jobId: string) => Promise<void>
  ): void => {
    worker.on("failed", async (job, error) => {
      if (!job) {
        return;
      }

      const attemptsAllowed = job.opts.attempts ?? 1;
      if (job.attemptsMade < attemptsAllowed) {
        return;
      }

      await addToDlq(
        {
          queue: queueName,
          data: job.data,
          error: error.message,
          failedAt: new Date().toISOString()
        },
        String(job.id)
      );
      await upsertJobMirror(db, {
        clientId: (job.data as { clientId: string }).clientId,
        leadId: (job.data as { leadId?: string }).leadId,
        queue: queueName,
        name: String(job.name),
        idempotencyKey: (job.data as { dedupeKey: string }).dedupeKey,
        payload: job.data as Record<string, unknown>,
        status: "dead_letter",
        attempts: job.attemptsMade,
        processedAt: new Date(),
        lastError: error.message
      });
    });

    worker.on("error", (error) => {
      logger.error({ err: error, queue: queueName }, "worker.runtime.error");
    });
  };

  attachDeadLetter(messageWorker, queueNames.messages, async (payload, jobId) => {
    await queues.messagesDlq.add("dead_letter", payload, {
      jobId,
      removeOnComplete: 1_000,
      removeOnFail: false
    });
  });
  attachDeadLetter(followupWorker, queueNames.followups, async (payload, jobId) => {
    await queues.followupsDlq.add("dead_letter", payload, {
      jobId,
      removeOnComplete: 1_000,
      removeOnFail: false
    });
  });
  attachDeadLetter(crmWorker, queueNames.crm, async (payload, jobId) => {
    await queues.crmDlq.add("dead_letter", payload, {
      jobId,
      removeOnComplete: 1_000,
      removeOnFail: false
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown.start");
    await Promise.all([messageWorker.close(), followupWorker.close(), crmWorker.close()]);
    await queues.close();
    await redis.quit();
    await db.$disconnect();
    logger.info({ signal }, "shutdown.complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info({ concurrency: config.workerConcurrency }, "worker.ready");
}

main().catch(async (error) => {
  const logger = createLogger("worker-bootstrap");
  logger.error({ err: error }, "worker.startup.failed");
  await db.$disconnect();
  process.exit(1);
});
