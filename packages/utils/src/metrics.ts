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
  name: "http_latency",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2],
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

export function setQualificationRate(clientId: string, rate: number): void {
  qualificationRate.set({ client_id: clientId }, rate);
}
