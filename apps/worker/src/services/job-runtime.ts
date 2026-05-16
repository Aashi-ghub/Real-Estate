import { performance } from "node:perf_hooks";
import os from "node:os";

import type { Job, Worker } from "bullmq";
import type { Logger } from "pino";

import { upsertJobMirror, type PrismaClient } from "@real-estate/db";
import type { DeadLetterJobData, JobTrace, QueueName } from "@real-estate/types";
import {
  buildJobTrace,
  computeRetryMetadata,
  incrementDeadLetter,
  incrementQueueFailure,
  incrementQueueRetry,
  observeWorkerExecutionLatency,
  sanitizeJsonValue
} from "@real-estate/utils";
import { createChildLogger, withLogContext } from "@real-estate/logger";

import { markJobFailure } from "./runtime-helpers";

export interface WorkerIdentity {
  queueName: QueueName;
  workerName: string;
}

export interface WorkerProcessorDependencies<TDeps> {
  logger: Logger;
  deps: TDeps;
}

function resolveJobTrace(job: Job<{ trace?: Partial<JobTrace> }>, identity: WorkerIdentity): JobTrace {
  const fallbackRequestId = typeof job.id === "string" ? job.id : `job-${Date.now()}`;
  return buildJobTrace(job.data.trace, {
    requestId: fallbackRequestId,
    correlationId: job.data.trace?.correlationId ?? fallbackRequestId,
    source: "worker",
    parentQueue: identity.queueName,
    parentJobId: typeof job.id === "string" ? job.id : undefined
  });
}

export function createWorkerProcessor<TData extends { trace?: Partial<JobTrace> }, TDeps>(
  identity: WorkerIdentity,
  options: WorkerProcessorDependencies<TDeps>,
  processor: (job: Job<TData>, deps: TDeps & { logger: Logger; trace: JobTrace }) => Promise<void>
): (job: Job<TData>) => Promise<void> {
  return async (job) => {
    const trace = resolveJobTrace(job as Job<{ trace?: Partial<JobTrace> }>, identity);
    const workerLogger = createChildLogger(options.logger, {
      request_id: trace.requestId,
      correlation_id: trace.correlationId,
      queue_name: identity.queueName,
      worker_name: identity.workerName,
      job_id: String(job.id)
    });
    const startedAt = performance.now();

    return withLogContext(
      {
        request_id: trace.requestId,
        correlation_id: trace.correlationId,
        queue_name: identity.queueName,
        worker_name: identity.workerName,
        job_id: String(job.id),
        client_id: "clientId" in job.data ? String(job.data.clientId ?? "") : undefined,
        lead_id: "leadId" in job.data ? String(job.data.leadId ?? "") : undefined
      },
      async () => {
        workerLogger.info(
          {
            job_name: job.name,
            attempts_allowed: job.opts.attempts ?? 1
          },
          "worker.job.start"
        );

        try {
          await processor(job, {
            ...(options.deps as TDeps),
            logger: workerLogger,
            trace
          });
          observeWorkerExecutionLatency(identity.queueName, identity.workerName, "completed", performance.now() - startedAt);
          workerLogger.info({ attempts_made: job.attemptsMade + 1 }, "worker.job.complete");
        } catch (error) {
          observeWorkerExecutionLatency(identity.queueName, identity.workerName, "failed", performance.now() - startedAt);
          workerLogger.error({ err: error }, "worker.job.error");
          throw error;
        }
      }
    );
  };
}

export function attachWorkerLifecycle<TData extends { clientId?: string; leadId?: string; dedupeKey?: string; trace?: Partial<JobTrace> }>(
  worker: Worker<TData>,
  options: {
    db: PrismaClient;
    logger: Logger;
    identity: WorkerIdentity;
    deadLetterQueue: {
      add: (name: string, data: DeadLetterJobData, options: { jobId: string; removeOnComplete: number; removeOnFail: boolean }) => Promise<unknown>;
    };
    retryBackoffMs: number;
    retryBackoffMaxMs: number;
  }
): void {
  worker.on("failed", async (job, error) => {
    try {
      if (!job) {
        return;
      }

      const maxAttempts = job.opts.attempts ?? 1;
      const retryMetadata = computeRetryMetadata({
        attemptsMade: job.attemptsMade,
        maxAttempts,
        baseDelayMs: options.retryBackoffMs,
        maxDelayMs: options.retryBackoffMaxMs
      });
      const trace = resolveJobTrace(job as Job<{ trace?: Partial<JobTrace> }>, options.identity);

      incrementQueueFailure(options.identity.queueName, options.identity.workerName, !retryMetadata.willRetry);
      options.logger.warn(
        {
          err: error,
          queue: options.identity.queueName,
          worker_name: options.identity.workerName,
          job_id: String(job.id),
          job_name: job.name,
          attempts_made: retryMetadata.attemptsMade,
          max_attempts: retryMetadata.maxAttempts,
          will_retry: retryMetadata.willRetry,
          next_retry_delay_ms: retryMetadata.nextRetryDelayMs
        },
        "worker.job.failed.lifecycle"
      );
      if (retryMetadata.willRetry) {
        incrementQueueRetry(options.identity.queueName, options.identity.workerName);
        return;
      }

      const deadLetterPayload: DeadLetterJobData = {
        queue: options.identity.queueName,
        workerName: options.identity.workerName,
        jobId: String(job.id),
        jobName: job.name,
        clientId: job.data.clientId,
        leadId: job.data.leadId,
        dedupeKey: job.data.dedupeKey,
        payload: sanitizeJsonValue(job.data),
        error: {
          message: error.message,
          failedAt: new Date().toISOString(),
          attemptsMade: retryMetadata.attemptsMade,
          maxAttempts: retryMetadata.maxAttempts,
          willRetry: false,
          nextRetryDelayMs: 0
        },
        trace
      };

      incrementDeadLetter(options.identity.queueName, options.identity.workerName);
      await options.deadLetterQueue.add("dead_letter", deadLetterPayload, {
        jobId: String(job.id),
        removeOnComplete: 1_000,
        removeOnFail: false
      });
      await markJobFailure(
        options.db,
        options.logger,
        {
          clientId: String(job.data.clientId ?? ""),
          leadId: job.data.leadId,
          queue: options.identity.queueName,
          name: job.name,
          dedupeKey: String(job.data.dedupeKey ?? job.id),
          payload: job.data,
          attempts: retryMetadata.attemptsMade,
          metadata: {
            retry: retryMetadata,
            workerName: options.identity.workerName,
            finalFailureAt: deadLetterPayload.error.failedAt
          },
          trace
        },
        error,
        "dead_letter"
      );
    } catch (lifecycleError) {
      options.logger.error(
        {
          err: lifecycleError,
          original_error: error,
          queue: options.identity.queueName,
          worker_name: options.identity.workerName,
          job_id: job ? String(job.id) : undefined
        },
        "worker.failed_lifecycle.error"
      );
      return;
    }
  });

  worker.on("error", (error) => {
    options.logger.error(
      {
        err: error,
        queue: options.identity.queueName,
        worker_name: options.identity.workerName
      },
      "worker.runtime.error"
    );
  });
}

export async function persistDeadLetterRecord(
  db: PrismaClient,
  payload: DeadLetterJobData
): Promise<void> {
  if (!payload.clientId || !payload.dedupeKey) {
    return;
  }

  await upsertJobMirror(db, {
    clientId: payload.clientId,
    leadId: payload.leadId,
    queue: payload.queue,
    name: payload.jobName,
    idempotencyKey: payload.dedupeKey,
    payload: payload.payload,
    metadata: {
      workerName: payload.workerName,
      deadLetter: payload.error
    },
    status: "dead_letter",
    attempts: payload.error.attemptsMade,
    processedAt: new Date(payload.error.failedAt),
    lastError: payload.error.message,
    trace: payload.trace
  });
}

export function startWorkerHeartbeat(options: {
  db: PrismaClient;
  logger: Logger;
  identities: WorkerIdentity[];
  intervalMs: number;
}): { close: () => Promise<void> } {
  const hostname = os.hostname().slice(0, 120);
  const processId = process.pid;
  let closed = false;

  const beat = async (status: "running" | "stopping"): Promise<void> => {
    if (!("workerHeartbeat" in options.db)) {
      return;
    }

    const now = new Date();
    await Promise.all(
      options.identities.map((identity) =>
        options.db.workerHeartbeat.upsert({
          where: {
            workerName_queueName_processId_hostname: {
              workerName: identity.workerName,
              queueName: identity.queueName,
              processId,
              hostname
            }
          },
          create: {
            workerName: identity.workerName,
            queueName: identity.queueName,
            processId,
            hostname,
            status,
            lastBeatAt: now,
            metadata: sanitizeJsonValue({ intervalMs: options.intervalMs })
          },
          update: {
            status,
            lastBeatAt: now,
            metadata: sanitizeJsonValue({ intervalMs: options.intervalMs })
          }
        })
      )
    );
  };

  void beat("running").catch((error) => {
    options.logger.warn({ err: error }, "worker.heartbeat.failed");
  });
  const handle = setInterval(() => {
    if (closed) {
      return;
    }

    void beat("running").catch((error) => {
      options.logger.warn({ err: error }, "worker.heartbeat.failed");
    });
  }, options.intervalMs);
  handle.unref();

  return {
    close: async () => {
      closed = true;
      clearInterval(handle);
      await beat("stopping");
    }
  };
}
