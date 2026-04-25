import pino, { type Logger, type LoggerOptions } from "pino";

import { maskEmail, maskPhone, redactSecrets } from "@real-estate/utils";

function sanitizeBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets({
    ...bindings,
    phone: typeof bindings.phone === "string" ? maskPhone(bindings.phone) : bindings.phone,
    email: typeof bindings.email === "string" ? maskEmail(bindings.email) : bindings.email
  });
}

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-api-key",
        "headers.authorization",
        "headers.x-api-key",
        "authorization",
        "apiKey",
        "token",
        "secret"
      ],
      censor: "***"
    },
    mixin() {
      return { service };
    },
    formatters: {
      bindings(bindings) {
        return sanitizeBindings(bindings);
      },
      log(object) {
        return sanitizeBindings(object);
      }
    },
    serializers: {
      err(error: Error & { statusCode?: number }) {
        return {
          type: error.name,
          message: error.message,
          statusCode: error.statusCode,
          stack: error.stack
        };
      }
    }
  };

  return pino(options);
}
