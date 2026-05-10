import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import type IORedis from "ioredis";

import type { CrmPushJobData, FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";

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
      crmAttempts: number;
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
    await this.messagesQueue.add("send_message", data, {
      jobId: data.dedupeKey,
      attempts: this.options.messageAttempts,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: false,
      ...overrides
    });
  }

  async enqueueFollowup(data: FollowupNoReplyJobData, delayMs: number, overrides: JobsOptions = {}): Promise<void> {
    await this.followupsQueue.add("followup_no_reply", data, {
      jobId: data.dedupeKey,
      attempts: this.options.messageAttempts,
      backoff: { type: "exponential", delay: 1_000 },
      delay: delayMs,
      removeOnComplete: 500,
      removeOnFail: false,
      ...overrides
    });
  }

  async enqueueCrmPush(data: CrmPushJobData, overrides: JobsOptions = {}): Promise<void> {
    await this.crmQueue.add("crm_push", data, {
      jobId: data.dedupeKey,
      attempts: this.options.crmAttempts,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 500,
      removeOnFail: false,
      ...overrides
    });
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
}
