import { Queue, type JobsOptions } from "bullmq";
import type IORedis from "ioredis";

import type { CrmPushJobData, FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";

export class WorkerQueues {
  readonly messagesQueue: Queue<SendMessageJobData>;
  readonly followupsQueue: Queue<FollowupNoReplyJobData>;
  readonly crmQueue: Queue<CrmPushJobData>;
  readonly messagesDlq: Queue;
  readonly followupsDlq: Queue;
  readonly crmDlq: Queue;

  constructor(
    readonly redis: IORedis,
    private readonly options: {
      prefix: string;
      messageAttempts: number;
      crmAttempts: number;
    }
  ) {
    this.messagesQueue = new Queue(queueNames.messages, {
      connection: redis,
      prefix: options.prefix
    });
    this.followupsQueue = new Queue(queueNames.followups, {
      connection: redis,
      prefix: options.prefix
    });
    this.crmQueue = new Queue(queueNames.crm, {
      connection: redis,
      prefix: options.prefix
    });
    this.messagesDlq = new Queue(queueNames.messagesDlq, {
      connection: redis,
      prefix: options.prefix
    });
    this.followupsDlq = new Queue(queueNames.followupsDlq, {
      connection: redis,
      prefix: options.prefix
    });
    this.crmDlq = new Queue(queueNames.crmDlq, {
      connection: redis,
      prefix: options.prefix
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
      this.crmQueue.close(),
      this.messagesDlq.close(),
      this.followupsDlq.close(),
      this.crmDlq.close()
    ]);
  }
}
