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

export const aiExecutionLatency = new Histogram({
  name: "ai_execution_latency_seconds",
  help: "AI runtime execution latency in seconds",
  labelNames: ["client_id", "task_type", "provider", "model", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry]
});

export const aiTokensTotal = new Counter({
  name: "ai_tokens_total",
  help: "Total AI tokens consumed",
  labelNames: ["client_id", "task_type", "provider", "model", "kind"],
  registers: [registry]
});

export const aiFailuresTotal = new Counter({
  name: "ai_failures_total",
  help: "Total AI runtime failures",
  labelNames: ["client_id", "task_type", "provider", "reason"],
  registers: [registry]
});

export const aiConfidenceDistribution = new Histogram({
  name: "ai_confidence",
  help: "AI output confidence distribution",
  labelNames: ["client_id", "task_type", "provider", "model"],
  buckets: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, 1],
  registers: [registry]
});

export const evaluationScoreDistribution = new Histogram({
  name: "evaluation_score",
  help: "Enterprise intelligence evaluation score distribution",
  labelNames: ["client_id", "run_type", "metric"],
  buckets: [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, 1],
  registers: [registry]
});

export const retrievalLatency = new Histogram({
  name: "retrieval_latency_seconds",
  help: "Memory retrieval benchmark latency in seconds",
  labelNames: ["client_id", "model"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry]
});

export const driftAnomaliesTotal = new Counter({
  name: "ai_drift_anomalies_total",
  help: "Total detected AI drift anomalies",
  labelNames: ["client_id", "metric_type"],
  registers: [registry]
});

export const workerSaturationGauge = new Gauge({
  name: "worker_saturation_score",
  help: "Worker saturation score by queue and pool",
  labelNames: ["queue", "worker_pool"],
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

export function observeAiExecution(options: {
  clientId: string;
  taskType: string;
  provider: string;
  model: string;
  status: string;
  latencyMs: number;
  confidence: number;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const labels = {
    client_id: options.clientId,
    task_type: options.taskType,
    provider: options.provider,
    model: options.model
  };
  aiExecutionLatency.observe({ ...labels, status: options.status }, options.latencyMs / 1000);
  aiConfidenceDistribution.observe(labels, options.confidence);
  aiTokensTotal.inc({ ...labels, kind: "input" }, options.inputTokens ?? 0);
  aiTokensTotal.inc({ ...labels, kind: "output" }, options.outputTokens ?? 0);
}

export function incrementAiFailure(clientId: string, taskType: string, provider: string, reason: string): void {
  aiFailuresTotal.inc({ client_id: clientId, task_type: taskType, provider, reason });
}

export function observeEvaluationScore(clientId: string, runType: string, metrics: Record<string, number>): void {
  for (const [metric, value] of Object.entries(metrics)) {
    if (Number.isFinite(value)) {
      evaluationScoreDistribution.observe({ client_id: clientId, run_type: runType, metric }, value);
    }
  }
}

export function observeRetrievalLatency(clientId: string, model: string, latencyMs: number): void {
  retrievalLatency.observe({ client_id: clientId, model }, latencyMs / 1000);
}

export function incrementDriftAnomaly(clientId: string, metricType: string): void {
  driftAnomaliesTotal.inc({ client_id: clientId, metric_type: metricType });
}

export function setWorkerSaturation(queueName: string, workerPool: string, score: number): void {
  workerSaturationGauge.set({ queue: queueName, worker_pool: workerPool }, score);
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
