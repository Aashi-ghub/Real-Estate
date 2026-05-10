import type { JobsOptions } from "bullmq";

import type { JobTrace, QueueName } from "@real-estate/types";

export interface QueueRetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface QueueJobOptionsInput {
  attempts: number;
  backoffDelayMs: number;
  delayMs?: number;
  jobId: string;
  overrides?: JobsOptions;
}

export interface QueueRetryMetadata {
  attemptsMade: number;
  maxAttempts: number;
  willRetry: boolean;
  nextRetryDelayMs: number;
}

export function buildQueueJobOptions(input: QueueJobOptionsInput): JobsOptions {
  return {
    jobId: input.jobId,
    attempts: input.attempts,
    backoff: {
      type: "exponential",
      delay: input.backoffDelayMs
    },
    removeOnComplete: 500,
    removeOnFail: false,
    ...(typeof input.delayMs === "number" ? { delay: input.delayMs } : {}),
    ...(input.overrides ?? {})
  };
}

export function computeRetryMetadata(args: {
  attemptsMade: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): QueueRetryMetadata {
  const willRetry = args.attemptsMade < args.maxAttempts;
  const nextRetryDelayMs = willRetry
    ? Math.min(args.baseDelayMs * Math.pow(2, Math.max(0, args.attemptsMade - 1)), args.maxDelayMs)
    : 0;

  return {
    attemptsMade: args.attemptsMade,
    maxAttempts: args.maxAttempts,
    willRetry,
    nextRetryDelayMs
  };
}

export function buildJobTrace(
  trace: Partial<JobTrace> | undefined,
  fallback: {
    requestId: string;
    correlationId: string;
    source: JobTrace["source"];
    parentQueue?: QueueName;
    parentJobId?: string;
  }
): JobTrace {
  return {
    requestId: trace?.requestId ?? fallback.requestId,
    correlationId: trace?.correlationId ?? fallback.correlationId,
    source: trace?.source ?? fallback.source,
    enqueuedAt: trace?.enqueuedAt ?? new Date().toISOString(),
    ...(trace?.parentQueue ?? fallback.parentQueue ? { parentQueue: trace?.parentQueue ?? fallback.parentQueue } : {}),
    ...(trace?.parentJobId ?? fallback.parentJobId ? { parentJobId: trace?.parentJobId ?? fallback.parentJobId } : {})
  };
}
