import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  correlation_id?: string;
  request_id?: string;
  queue_name?: string;
  worker_name?: string;
  job_id?: string;
  client_id?: string;
  lead_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

function mergeContext(bindings: LogContext): LogContext {
  return {
    ...(storage.getStore() ?? {}),
    ...bindings
  };
}

export function withLogContext<T>(bindings: LogContext, callback: () => T): T {
  return storage.run(mergeContext(bindings), callback);
}

export function setLogContext(bindings: LogContext): void {
  storage.enterWith(mergeContext(bindings));
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}
