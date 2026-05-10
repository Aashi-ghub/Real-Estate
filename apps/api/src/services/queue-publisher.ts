import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import type IORedis from "ioredis";

import type { CrmPushJobData, FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";
import { buildQueueJobOptions } from "@real-estate/utils";

export class QueuePublisher {
  private readonly messagesQueue: Queue<SendMessageJobData>;
  private readonly followupsQueue: Queue<FollowupNoReplyJobData>;
  private readonly crmQueue: Queue<CrmPushJobData>;

  constructor(
    private readonly redisClient: IORedis,
    private readonly bullmqConnection: ConnectionOptions,
    private readonly options: {
      prefix: string;
      messageAttempts: number;
      followupAttempts: number;
      crmAttempts: number;
      retryBackoffMs: number;
    }
  ) {
    this.messagesQueue = new Queue(queueNames.messages, {
      connection: this.bullmqConnection,
      prefix: this.options.prefix
    });
    this.followupsQueue = new Queue(queueNames.followups, {
      connection: this.bullmqConnection,
      prefix: this.options.prefix
    });
    this.crmQueue = new Queue(queueNames.crm, {
      connection: this.bullmqConnection,
      prefix: this.options.prefix
    });
  }

  async enqueueSendMessage(data: SendMessageJobData, overrides: JobsOptions = {}): Promise<void> {
    await this.messagesQueue.add(
      "send_message",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.messageAttempts,
        backoffDelayMs: this.options.retryBackoffMs,
        overrides
      })
    );
  }

  async enqueueFollowup(data: FollowupNoReplyJobData, delayMs: number, overrides: JobsOptions = {}): Promise<void> {
    await this.followupsQueue.add(
      "followup_no_reply",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.followupAttempts,
        backoffDelayMs: this.options.retryBackoffMs,
        delayMs,
        overrides
      })
    );
  }

  async enqueueCrmPush(data: CrmPushJobData, overrides: JobsOptions = {}): Promise<void> {
    await this.crmQueue.add(
      "crm_push",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.crmAttempts,
        backoffDelayMs: this.options.retryBackoffMs * 2,
        overrides
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      this.messagesQueue.close(),
      this.followupsQueue.close(),
      this.crmQueue.close()
    ]);
  }

  async healthCheck(): Promise<void> {
    await this.redisClient.ping();
    await Promise.all([
      this.messagesQueue.waitUntilReady(),
      this.followupsQueue.waitUntilReady(),
      this.crmQueue.waitUntilReady()
    ]);
  }

  get redis(): IORedis {
    return this.redisClient;
  }

  getMetricsTargets() {
    return [
      { name: queueNames.messages, queue: this.messagesQueue },
      { name: queueNames.followups, queue: this.followupsQueue },
      { name: queueNames.crm, queue: this.crmQueue }
    ];
  }
}
