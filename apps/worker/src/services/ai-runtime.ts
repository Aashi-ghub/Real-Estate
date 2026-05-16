import { performance } from "node:perf_hooks";

import type { Logger } from "pino";

import type { WorkerConfig } from "@real-estate/config";
import type { AiLeadIntelligenceJobData, JsonObject } from "@real-estate/types";
import {
  aiLeadIntelligenceSchema,
  deterministicAiLeadIntelligence,
  hashAiInput,
  incrementAiFailure,
  observeAiExecution,
  redactPromptPii,
  sanitizeJsonValue,
  type AiLeadIntelligence
} from "@real-estate/utils";

export interface AiProviderResult {
  output: AiLeadIntelligence;
  provider: "deterministic" | "openai";
  model: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  costUsd: number;
  latencyMs: number;
  fallbackUsed: boolean;
}

export class AiRuntime {
  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: Logger
  ) {}

  async executeLeadIntelligence(job: AiLeadIntelligenceJobData): Promise<AiProviderResult> {
    const startedAt = performance.now();
    if (this.config.aiProvider !== "openai") {
      return this.runDeterministic(job, startedAt, false);
    }

    try {
      const output = await this.withTimeout(this.callOpenAi(job), this.config.aiTimeoutMs);
      const parsed = aiLeadIntelligenceSchema.parse(output.parsedOutput);
      const latencyMs = Math.round(performance.now() - startedAt);
      this.recordMetrics(job, "openai", this.config.aiModel, "completed", latencyMs, parsed.confidence, output.tokenUsage);
      return {
        output: parsed,
        provider: "openai",
        model: this.config.aiModel,
        tokenUsage: output.tokenUsage,
        costUsd: this.estimateCostUsd(output.tokenUsage),
        latencyMs,
        fallbackUsed: false
      };
    } catch (error) {
      incrementAiFailure(job.clientId, "semantic_understanding", "openai", error instanceof Error ? error.name : "unknown");
      this.logger.warn({ err: error, leadId: job.leadId }, "ai.provider.fallback");
      return this.runDeterministic(job, startedAt, true);
    }
  }

  buildInputHash(job: AiLeadIntelligenceJobData): string {
    return hashAiInput({
      clientId: job.clientId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      rawUtterance: redactPromptPii(job.rawUtterance),
      deterministic: job.deterministic,
      tasks: job.tasks
    });
  }

  private runDeterministic(job: AiLeadIntelligenceJobData, startedAt: number, fallbackUsed: boolean): AiProviderResult {
    const output = deterministicAiLeadIntelligence(job);
    const latencyMs = Math.round(performance.now() - startedAt);
    const tokenUsage = {
      inputTokens: Math.ceil(job.rawUtterance.length / 4),
      outputTokens: Math.ceil(JSON.stringify(output).length / 4),
      totalTokens: Math.ceil((job.rawUtterance.length + JSON.stringify(output).length) / 4)
    };
    this.recordMetrics(job, "deterministic", "rules-v1", fallbackUsed ? "fallback" : "completed", latencyMs, output.confidence, tokenUsage);
    return {
      output,
      provider: "deterministic",
      model: "rules-v1",
      tokenUsage,
      costUsd: 0,
      latencyMs,
      fallbackUsed
    };
  }

  private async callOpenAi(job: AiLeadIntelligenceJobData): Promise<{
    parsedOutput: unknown;
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  }> {
    if (!this.config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const controller = new AbortController();
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.aiModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You enrich deterministic real-estate lead intelligence.",
              "Return only JSON matching the required schema.",
              "Never invent facts. Include confidence, reasoning, and provenance.",
              "Treat AI as recommendation-only and preserve tenant isolation."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              rawUtterance: redactPromptPii(job.rawUtterance),
              deterministic: sanitizeJsonValue(job.deterministic),
              tasks: job.tasks
            })
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI response was empty");
    }

    return {
      parsedOutput: JSON.parse(content),
      tokenUsage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ?? 0
      }
    };
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("AI provider timeout")), timeoutMs);
          timeout.unref();
        })
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private estimateCostUsd(tokenUsage: { inputTokens: number; outputTokens: number }): number {
    return Number(((tokenUsage.inputTokens / 1_000_000) * 0.15 + (tokenUsage.outputTokens / 1_000_000) * 0.6).toFixed(6));
  }

  private recordMetrics(
    job: AiLeadIntelligenceJobData,
    provider: "deterministic" | "openai",
    model: string,
    status: string,
    latencyMs: number,
    confidence: number,
    tokenUsage: { inputTokens: number; outputTokens: number }
  ): void {
    for (const taskType of job.tasks) {
      observeAiExecution({
        clientId: job.clientId,
        taskType,
        provider,
        model,
        status,
        latencyMs,
        confidence,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens
      });
    }
  }
}

export function aiReasoningMetadata(output: AiLeadIntelligence, fallbackUsed: boolean): JsonObject {
  return sanitizeJsonValue({
    ...output.reasoning,
    fallbackUsed,
    schemaValidated: true,
    confidence: output.confidence
  }) as JsonObject;
}
