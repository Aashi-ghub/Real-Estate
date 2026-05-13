import "dotenv/config";

import { Worker } from "bullmq";

import { getWorkerConfig } from "@real-estate/config";
import { db } from "@real-estate/db";
import { createLogger } from "@real-estate/logger";
import type { DeadLetterJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";
import {
  assertRedisCompatibleWithBullMq,
  buildBullMqConnection,
  createQueueMetricsHandle,
  createRedisClient,
  initializeMetrics,
  redactRedisConnection,
  runBullMqRoundTripHealthcheck
} from "@real-estate/utils";

import { processCrmPush } from "./processors/crm";
import { processFollowup } from "./processors/followup";
import { processSendMessage } from "./processors/send-message";
import { createWorkerProcessor, attachWorkerLifecycle, persistDeadLetterRecord } from "./services/job-runtime";
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
    followupAttempts: config.followupMaxRetries,
    crmAttempts: config.CRM_MAX_RETRIES,
    retryBackoffMs: config.queueRetryBackoffMs
  });
  await queues.waitUntilReady();
  const queueMetrics = createQueueMetricsHandle({
    queues: queues.getMetricsTargets(),
    intervalMs: config.queueMetricsSampleIntervalMs,
    logger
  });
  await queueMetrics.sample();

  await runBullMqRoundTripHealthcheck({
    connection: bullmqConnection,
    prefix: config.QUEUE_PREFIX,
    instanceName: `worker-${process.pid}`,
    logger
  });

  const messageWorker = new Worker(
    queueNames.messages,
    createWorkerProcessor(
      { queueName: queueNames.messages, workerName: "message-worker" },
      { logger, deps: { db, config, queues } },
      processSendMessage
    ),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: config.workerConcurrency
    }
  );
  const followupWorker = new Worker(
    queueNames.followups,
    createWorkerProcessor(
      { queueName: queueNames.followups, workerName: "followup-worker" },
      { logger, deps: { db, config, queues } },
      processFollowup
    ),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: Math.max(1, Math.floor(config.workerConcurrency / 2))
    }
  );
  const crmWorker = new Worker(
    queueNames.crm,
    createWorkerProcessor(
      { queueName: queueNames.crm, workerName: "crm-worker" },
      { logger, deps: { db, config, queues } },
      processCrmPush
    ),
    {
      connection: bullmqConnection,
      prefix: config.QUEUE_PREFIX,
      concurrency: Math.max(1, Math.floor(config.workerConcurrency / 2))
    }
  );

  const createDlqWorker = (
    queueName: typeof queueNames.messagesDlq | typeof queueNames.followupsDlq | typeof queueNames.crmDlq,
    workerName: string
  ) =>
    new Worker<DeadLetterJobData>(
      queueName,
      createWorkerProcessor(
        { queueName, workerName },
        { logger, deps: { db } },
        async (job, { db: dlqDb, logger: dlqLogger }) => {
          await persistDeadLetterRecord(dlqDb, job.data);
          dlqLogger.warn(
            {
              queue: job.data.queue,
              failed_job_id: job.data.jobId,
              attempts_made: job.data.error.attemptsMade
            },
            "worker.dead_letter.persisted"
          );
        }
      ),
      {
        connection: bullmqConnection,
        prefix: config.QUEUE_PREFIX,
        concurrency: 1
      }
    );

  const messagesDlqWorker = createDlqWorker(queueNames.messagesDlq, "messages-dlq-worker");
  const followupsDlqWorker = createDlqWorker(queueNames.followupsDlq, "followups-dlq-worker");
  const crmDlqWorker = createDlqWorker(queueNames.crmDlq, "crm-dlq-worker");

  attachWorkerLifecycle(messageWorker, {
    db,
    logger,
    identity: { queueName: queueNames.messages, workerName: "message-worker" },
    deadLetterQueue: queues.messagesDlq,
    retryBackoffMs: config.queueRetryBackoffMs,
    retryBackoffMaxMs: config.queueRetryBackoffMaxMs
  });
  attachWorkerLifecycle(followupWorker, {
    db,
    logger,
    identity: { queueName: queueNames.followups, workerName: "followup-worker" },
    deadLetterQueue: queues.followupsDlq,
    retryBackoffMs: config.queueRetryBackoffMs,
    retryBackoffMaxMs: config.queueRetryBackoffMaxMs
  });
  attachWorkerLifecycle(crmWorker, {
    db,
    logger,
    identity: { queueName: queueNames.crm, workerName: "crm-worker" },
    deadLetterQueue: queues.crmDlq,
    retryBackoffMs: config.queueRetryBackoffMs * 2,
    retryBackoffMaxMs: config.queueRetryBackoffMaxMs
  });

  for (const dlqWorker of [messagesDlqWorker, followupsDlqWorker, crmDlqWorker]) {
    dlqWorker.on("error", (error) => {
      logger.error({ err: error }, "worker.dlq.runtime.error");
    });
  }

  await Promise.all([
    messageWorker.waitUntilReady(),
    followupWorker.waitUntilReady(),
    crmWorker.waitUntilReady(),
    messagesDlqWorker.waitUntilReady(),
    followupsDlqWorker.waitUntilReady(),
    crmDlqWorker.waitUntilReady()
  ]);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown.start");
    await Promise.all([
      messageWorker.close(),
      followupWorker.close(),
      crmWorker.close(),
      messagesDlqWorker.close(),
      followupsDlqWorker.close(),
      crmDlqWorker.close()
    ]);
    await queueMetrics.close();
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
