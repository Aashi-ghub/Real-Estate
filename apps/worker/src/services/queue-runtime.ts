import { Queue, type ConnectionOptions, type Job, type JobsOptions } from "bullmq";

import type { CrmPushJobData, FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";
import { buildQueueJobOptions } from "@real-estate/utils";

export class WorkerQueues {
  readonly messagesQueue: Queue<SendMessageJobData>;
  readonly followupsQueue: Queue<FollowupNoReplyJobData>;
  readonly crmQueue: Queue<CrmPushJobData>;
  readonly messagesDlq: Queue;
  readonly followupsDlq: Queue;
  readonly crmDlq: Queue;

  constructor(
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
      prefix: options.prefix
    });
    this.followupsQueue = new Queue(queueNames.followups, {
      connection: this.bullmqConnection,
      prefix: options.prefix
    });
    this.crmQueue = new Queue(queueNames.crm, {
      connection: this.bullmqConnection,
      prefix: options.prefix
    });
    this.messagesDlq = new Queue(queueNames.messagesDlq, {
      connection: this.bullmqConnection,
      prefix: options.prefix
    });
    this.followupsDlq = new Queue(queueNames.followupsDlq, {
      connection: this.bullmqConnection,
      prefix: options.prefix
    });
    this.crmDlq = new Queue(queueNames.crmDlq, {
      connection: this.bullmqConnection,
      prefix: options.prefix
    });
  }

  async enqueueSendMessage(data: SendMessageJobData, overrides: JobsOptions = {}): Promise<void> {
    const job = await this.messagesQueue.add(
      "send_message",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.messageAttempts,
        backoffDelayMs: this.options.retryBackoffMs,
        overrides
      })
    );
    await this.requeueFailedJob(job);
  }

  async enqueueFollowup(data: FollowupNoReplyJobData, delayMs: number, overrides: JobsOptions = {}): Promise<void> {
    const job = await this.followupsQueue.add(
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
    await this.requeueFailedJob(job);
  }

  async enqueueCrmPush(data: CrmPushJobData, overrides: JobsOptions = {}): Promise<void> {
    const job = await this.crmQueue.add(
      "crm_push",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.crmAttempts,
        backoffDelayMs: this.options.retryBackoffMs * 2,
        overrides
      })
    );
    await this.requeueFailedJob(job);
  }

  private async requeueFailedJob(job: Job): Promise<void> {
    const state = await job.getState();
    if (state === "failed") {
      await job.retry("failed");
    }
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

  async waitUntilReady(): Promise<void> {
    await Promise.all([
      this.messagesQueue.waitUntilReady(),
      this.followupsQueue.waitUntilReady(),
      this.crmQueue.waitUntilReady(),
      this.messagesDlq.waitUntilReady(),
      this.followupsDlq.waitUntilReady(),
      this.crmDlq.waitUntilReady()
    ]);
  }

  getMetricsTargets() {
    return [
      { name: queueNames.messages, queue: this.messagesQueue },
      { name: queueNames.followups, queue: this.followupsQueue },
      { name: queueNames.crm, queue: this.crmQueue },
      { name: queueNames.messagesDlq, queue: this.messagesDlq },
      { name: queueNames.followupsDlq, queue: this.followupsDlq },
      { name: queueNames.crmDlq, queue: this.crmDlq }
    ];
  }
}
