import { Queue } from "bullmq";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";

const registry = new Registry();
let metricsInitialized = false;

export const httpLatency = new Histogram({
  name: "http_request_latency_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2],
  registers: [registry]
});

export const webhookProcessingLatency = new Histogram({
  name: "webhook_processing_latency_seconds",
  help: "Webhook processing latency in seconds",
  labelNames: ["provider", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry]
});

export const workerExecutionLatency = new Histogram({
  name: "worker_execution_latency_seconds",
  help: "Worker execution latency in seconds",
  labelNames: ["queue", "worker", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry]
});

export const queueDepthGauge = new Gauge({
  name: "queue_depth",
  help: "Queue depth by state",
  labelNames: ["queue", "state"],
  registers: [registry]
});

export const queueFailuresTotal = new Counter({
  name: "queue_failures_total",
  help: "Total queue job failures",
  labelNames: ["queue", "worker", "final"],
  registers: [registry]
});

export const queueDeadLetterTotal = new Counter({
  name: "queue_dead_letter_total",
  help: "Total jobs moved to dead letter queues",
  labelNames: ["queue", "worker"],
  registers: [registry]
});

export const queueRetryTotal = new Counter({
  name: "queue_retries_total",
  help: "Total queued retries scheduled after a failure",
  labelNames: ["queue", "worker"],
  registers: [registry]
});

export const webhookFailuresTotal = new Counter({
  name: "webhook_failures_total",
  help: "Total webhook failures",
  labelNames: ["provider", "reason"],
  registers: [registry]
});

export const leadCreatedTotal = new Counter({
  name: "lead_created_total",
  help: "Total number of leads created",
  labelNames: ["client_id"],
  registers: [registry]
});

export const messagesSentTotal = new Counter({
  name: "messages_sent_total",
  help: "Total number of outbound messages sent",
  labelNames: ["client_id", "reason"],
  registers: [registry]
});

export const messagesFailedTotal = new Counter({
  name: "messages_failed_total",
  help: "Total number of outbound message failures",
  labelNames: ["client_id", "reason"],
  registers: [registry]
});

export const qualificationRate = new Gauge({
  name: "qualification_rate",
  help: "Qualified leads divided by total leads",
  labelNames: ["client_id"],
  registers: [registry]
});

export const crmPushSuccessTotal = new Counter({
  name: "crm_push_success_total",
  help: "Total successful CRM pushes",
  labelNames: ["client_id"],
  registers: [registry]
});

export const crmPushFailedTotal = new Counter({
  name: "crm_push_failed_total",
  help: "Total failed CRM pushes",
  labelNames: ["client_id"],
  registers: [registry]
});

export function initializeMetrics(serviceName: string): void {
  if (!metricsInitialized) {
    collectDefaultMetrics({ register: registry });
    metricsInitialized = true;
  }

  registry.setDefaultLabels({ service: serviceName });
}

export function getMetricsRegistry(): Registry {
  return registry;
}

export function observeHttpLatency(method: string, route: string, statusCode: number, durationMs: number): void {
  httpLatency.observe(
    {
      method,
      route,
      status_code: String(statusCode)
    },
    durationMs / 1000
  );
}

export function observeWebhookProcessingLatency(
  provider: string,
  status: "processed" | "duplicate" | "ignored" | "failed",
  durationMs: number
): void {
  webhookProcessingLatency.observe(
    {
      provider,
      status
    },
    durationMs / 1000
  );
}

export function observeWorkerExecutionLatency(
  queueName: string,
  workerName: string,
  status: "completed" | "failed",
  durationMs: number
): void {
  workerExecutionLatency.observe(
    {
      queue: queueName,
      worker: workerName,
      status
    },
    durationMs / 1000
  );
}

export function incrementQueueFailure(queueName: string, workerName: string, finalFailure: boolean): void {
  queueFailuresTotal.inc({
    queue: queueName,
    worker: workerName,
    final: String(finalFailure)
  });
}

export function incrementQueueRetry(queueName: string, workerName: string): void {
  queueRetryTotal.inc({
    queue: queueName,
    worker: workerName
  });
}

export function incrementDeadLetter(queueName: string, workerName: string): void {
  queueDeadLetterTotal.inc({
    queue: queueName,
    worker: workerName
  });
}

export function incrementWebhookFailure(provider: string, reason: string): void {
  webhookFailuresTotal.inc({
    provider,
    reason
  });
}

export function setQualificationRate(clientId: string, rate: number): void {
  qualificationRate.set({ client_id: clientId }, rate);
}

export interface QueueMetricsHandle {
  close(): Promise<void>;
  sample(): Promise<void>;
}

interface QueueMetricTarget {
  name: string;
  queue: Queue;
}

const queueDepthStates = [
  "active",
  "completed",
  "delayed",
  "failed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children"
] as const;

export function createQueueMetricsHandle(options: {
  queues: QueueMetricTarget[];
  intervalMs: number;
  logger?: {
    debug?: (payload: Record<string, unknown>, message?: string) => void;
    warn?: (payload: Record<string, unknown>, message?: string) => void;
  };
}): QueueMetricsHandle {
  let closed = false;
  const interval = setInterval(() => {
    void sample().catch((error) => {
      options.logger?.warn?.(
        {
          err: error instanceof Error ? error : new Error("Unknown queue metrics sampling failure")
        },
        "queue.metrics.sample.failed"
      );
    });
  }, options.intervalMs);
  interval.unref();

  const sample = async (): Promise<void> => {
    if (closed) {
      return;
    }

    await Promise.all(
      options.queues.map(async ({ name, queue }) => {
        const counts = await queue.getJobCounts(...queueDepthStates);
        for (const state of queueDepthStates) {
          queueDepthGauge.set(
            {
              queue: name,
              state
            },
            counts[state] ?? 0
          );
        }
      })
    );

    options.logger?.debug?.({ queue_count: options.queues.length }, "queue.metrics.sampled");
  };

  return {
    async close() {
      closed = true;
      clearInterval(interval);
    },
    sample
  };
}
