import { createLogger } from "@real-estate/logger";
import { afterEach, describe, expect, it } from "vitest";

import { processFollowup } from "../../apps/worker/src/processors/followup";
import { attachWorkerLifecycle } from "../../apps/worker/src/services/job-runtime";

class FakeWorker<TData extends { clientId?: string; leadId?: string; dedupeKey?: string; trace?: unknown }> {
  handlers: {
    failed?: (job: FakeJob<TData> | undefined, error: Error) => Promise<void>;
    error?: (error: Error) => void;
  } = {};

  on(event: "failed" | "error", handler: ((job: FakeJob<TData> | undefined, error: Error) => Promise<void>) | ((error: Error) => void)) {
    if (event === "failed") {
      this.handlers.failed = handler as (job: FakeJob<TData> | undefined, error: Error) => Promise<void>;
      return this;
    }

    this.handlers.error = handler as (error: Error) => void;
    return this;
  }
}

interface FakeJob<TData> {
  id: string;
  name: string;
  data: TData;
  attemptsMade: number;
  opts: {
    attempts?: number;
  };
}

function createJobUpsertRecorder() {
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    async upsert(args: Record<string, unknown>) {
      calls.push(args);
      return args;
    }
  };
}

describe("worker runtime integration", () => {
  const logger = createLogger("test", "fatal");

  afterEach(() => {
    return;
  });

  it("does not move retryable failures to the dead letter queue before the final attempt", async () => {
    const jobRecorder = createJobUpsertRecorder();
    const worker = new FakeWorker<{
      clientId: string;
      leadId: string;
      dedupeKey: string;
      trace: {
        requestId: string;
        correlationId: string;
        source: "api";
        enqueuedAt: string;
      };
    }>();
    const deadLetterAdds: unknown[] = [];

    attachWorkerLifecycle(worker as never, {
      db: {
        job: {
          upsert: jobRecorder.upsert
        }
      } as never,
      logger,
      identity: {
        queueName: "messages",
        workerName: "message-worker"
      },
      deadLetterQueue: {
        async add(_name, payload) {
          deadLetterAdds.push(payload);
        }
      },
      retryBackoffMs: 1_000,
      retryBackoffMaxMs: 60_000
    });

    await worker.handlers.failed?.(
      {
        id: "job-1",
        name: "send_message",
        attemptsMade: 1,
        opts: {
          attempts: 3
        },
        data: {
          clientId: "client-1",
          leadId: "lead-1",
          dedupeKey: "dedupe-1",
          trace: {
            requestId: "req-1",
            correlationId: "corr-1",
            source: "api",
            enqueuedAt: new Date().toISOString()
          }
        }
      },
      new Error("retry me")
    );

    expect(deadLetterAdds).toHaveLength(0);
    expect(jobRecorder.calls).toHaveLength(0);
  });

  it("moves terminal failures to the dead letter queue and persists correlation metadata", async () => {
    const jobRecorder = createJobUpsertRecorder();
    const worker = new FakeWorker<{
      clientId: string;
      leadId: string;
      dedupeKey: string;
      trace: {
        requestId: string;
        correlationId: string;
        source: "webhook";
        enqueuedAt: string;
      };
    }>();
    const deadLetterAdds: Array<Record<string, unknown>> = [];

    attachWorkerLifecycle(worker as never, {
      db: {
        job: {
          upsert: jobRecorder.upsert
        }
      } as never,
      logger,
      identity: {
        queueName: "crm",
        workerName: "crm-worker"
      },
      deadLetterQueue: {
        async add(_name, payload) {
          deadLetterAdds.push(payload as unknown as Record<string, unknown>);
        }
      },
      retryBackoffMs: 2_000,
      retryBackoffMaxMs: 60_000
    });

    await worker.handlers.failed?.(
      {
        id: "job-2",
        name: "crm_push",
        attemptsMade: 3,
        opts: {
          attempts: 3
        },
        data: {
          clientId: "client-2",
          leadId: "lead-2",
          dedupeKey: "dedupe-2",
          trace: {
            requestId: "req-terminal",
            correlationId: "corr-terminal",
            source: "webhook",
            enqueuedAt: new Date().toISOString()
          }
        }
      },
      new Error("terminal failure")
    );

    expect(deadLetterAdds).toHaveLength(1);
    expect(deadLetterAdds[0]).toMatchObject({
      queue: "crm",
      workerName: "crm-worker",
      trace: {
        requestId: "req-terminal",
        correlationId: "corr-terminal"
      }
    });
    expect(jobRecorder.calls).toHaveLength(1);
    expect(jobRecorder.calls[0]).toMatchObject({
      update: {
        requestId: "req-terminal",
        correlationId: "corr-terminal",
        status: "dead_letter"
      }
    });
  });

  it("propagates request_id from queue jobs into worker persistence updates", async () => {
    const jobRecorder = createJobUpsertRecorder();
    const db = {
      conversation: {
        async findUnique() {
          return {
            id: "conversation-1",
            leadId: "lead-1",
            state: "QUALIFIED",
            messages: []
          };
        }
      },
      message: {
        async findFirst() {
          return null;
        }
      },
      job: {
        upsert: jobRecorder.upsert
      }
    };

    await processFollowup(
      {
        id: "followup-job-1",
        name: "followup_no_reply",
        attemptsMade: 0,
        opts: {
          attempts: 2
        },
        data: {
          clientId: "client-1",
          leadId: "lead-1",
          conversationId: "conversation-1",
          to: "+919811112222",
          dedupeKey: "followup-dedupe",
          expectedState: "ASK_BUDGET",
          lastOutboundAt: new Date().toISOString(),
          trace: {
            requestId: "req-worker-123",
            correlationId: "corr-worker-123",
            source: "worker",
            enqueuedAt: new Date().toISOString()
          }
        }
      } as never,
      {
        db: db as never,
        logger,
        config: {
          APP_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          FOLLOWUP_DELAY_MINUTES: 30,
          queueRetryBackoffMs: 1_000,
          queueRetryBackoffMaxMs: 60_000
        } as never,
        queues: {
          enqueueSendMessage: async () => undefined
        } as never,
        trace: {
          requestId: "req-worker-123",
          correlationId: "corr-worker-123",
          source: "worker",
          enqueuedAt: new Date().toISOString()
        }
      }
    );

    expect(jobRecorder.calls).toHaveLength(2);
    expect(jobRecorder.calls[0]).toMatchObject({
      create: {
        requestId: "req-worker-123",
        correlationId: "corr-worker-123",
        status: "processing"
      }
    });
    expect(jobRecorder.calls[1]).toMatchObject({
      update: {
        requestId: "req-worker-123",
        correlationId: "corr-worker-123",
        status: "completed"
      }
    });
  });
});
