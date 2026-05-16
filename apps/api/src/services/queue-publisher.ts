import { Queue, type ConnectionOptions, type Job, type JobsOptions } from "bullmq";
import type IORedis from "ioredis";

import type { AiLeadIntelligenceJobData, CrmPushJobData, EvaluationRunJobData, FollowupNoReplyJobData, SendMessageJobData } from "@real-estate/types";
import { queueNames } from "@real-estate/types";
import { buildQueueJobOptions } from "@real-estate/utils";

export class QueuePublisher {
  private readonly messagesQueue: Queue<SendMessageJobData>;
  private readonly followupsQueue: Queue<FollowupNoReplyJobData>;
  private readonly crmQueue: Queue<CrmPushJobData>;
  private readonly aiQueue: Queue<AiLeadIntelligenceJobData>;
  private readonly evaluationQueue: Queue<EvaluationRunJobData>;

  constructor(
    private readonly redisClient: IORedis,
    private readonly bullmqConnection: ConnectionOptions,
    private readonly options: {
      prefix: string;
      messageAttempts: number;
      followupAttempts: number;
      crmAttempts: number;
      aiAttempts?: number;
      evaluationAttempts?: number;
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
    this.aiQueue = new Queue(queueNames.ai, {
      connection: this.bullmqConnection,
      prefix: this.options.prefix
    });
    this.evaluationQueue = new Queue(queueNames.evaluation, {
      connection: this.bullmqConnection,
      prefix: this.options.prefix
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
        overrides: { priority: 1, ...overrides }
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
        overrides: { priority: 5, ...overrides }
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
        overrides: { priority: 3, ...overrides }
      })
    );
    await this.requeueFailedJob(job);
  }

  async enqueueAiLeadIntelligence(data: AiLeadIntelligenceJobData, overrides: JobsOptions = {}): Promise<void> {
    const job = await this.aiQueue.add(
      "lead_intelligence",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.aiAttempts ?? 3,
        backoffDelayMs: this.options.retryBackoffMs * 2,
        overrides: { priority: 10, ...overrides }
      })
    );
    await this.requeueFailedJob(job);
  }

  async enqueueEvaluationRun(data: EvaluationRunJobData, overrides: JobsOptions = {}): Promise<void> {
    const job = await this.evaluationQueue.add(
      "evaluation_run",
      data,
      buildQueueJobOptions({
        jobId: data.dedupeKey,
        attempts: this.options.evaluationAttempts ?? 2,
        backoffDelayMs: this.options.retryBackoffMs * 3,
        overrides: { priority: 20, ...overrides }
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
      this.aiQueue.close(),
      this.evaluationQueue.close()
    ]);
  }

  async healthCheck(): Promise<void> {
    await this.redisClient.ping();
    await Promise.all([
      this.messagesQueue.waitUntilReady(),
      this.followupsQueue.waitUntilReady(),
      this.crmQueue.waitUntilReady(),
      this.aiQueue.waitUntilReady(),
      this.evaluationQueue.waitUntilReady()
    ]);
  }

  get redis(): IORedis {
    return this.redisClient;
  }

  getMetricsTargets() {
    return [
      { name: queueNames.messages, queue: this.messagesQueue },
      { name: queueNames.followups, queue: this.followupsQueue },
      { name: queueNames.crm, queue: this.crmQueue },
      { name: queueNames.ai, queue: this.aiQueue },
      { name: queueNames.evaluation, queue: this.evaluationQueue }
    ];
  }

  async getQueueHealth() {
    const queues = this.getMetricsTargets();
    return Promise.all(
      queues.map(async ({ name, queue }) => ({
        name,
        counts: await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused"),
        is_paused: await queue.isPaused()
      }))
    );
  }

  async pauseQueue(name: string): Promise<void> {
    await this.resolveQueue(name).pause();
  }

  async resumeQueue(name: string): Promise<void> {
    await this.resolveQueue(name).resume();
  }

  private resolveQueue(name: string): Queue {
    const target = this.getMetricsTargets().find((entry) => entry.name === name);
    if (!target) {
      throw new Error(`Unknown queue: ${name}`);
    }

    return target.queue;
  }
}
