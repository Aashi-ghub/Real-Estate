import "dotenv/config";

import { Queue } from "bullmq";

import { getWorkerConfig } from "@real-estate/config";
import { queueNames } from "@real-estate/types";
import { buildBullMqConnection } from "@real-estate/utils";

async function main(): Promise<void> {
  const config = getWorkerConfig();
  const connection = buildBullMqConnection(config.redisConnection, {
    connectionName: "inspect-failed-jobs"
  });
  const queues = [queueNames.messages, queueNames.followups, queueNames.crm] as const;

  for (const queueName of queues) {
    const queue = new Queue(queueName, {
      connection,
      prefix: config.QUEUE_PREFIX
    });
    const [waiting, active, delayed, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getCompletedCount(),
      queue.getFailedCount()
    ]);
    const failedJobs = await queue.getFailed(0, 20);

    console.log(JSON.stringify({
      queue: queueName,
      counts: { waiting, active, delayed, completed, failed },
      failed: failedJobs.map((job) => ({
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        stacktrace: job.stacktrace?.slice(0, 3),
        data: job.data
      }))
    }, null, 2));
    await queue.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
