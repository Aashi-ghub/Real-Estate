import pino, { type Bindings, type Logger, type LoggerOptions } from "pino";

import { maskEmail, maskPhone, redactSecrets } from "@real-estate/utils";

import { getLogContext, type LogContext } from "./context";

const secretKeyPattern = /(authorization|token|secret|password|signature|api[-_]?key)/i;
const phoneKeyPattern = /(^|_|-)(phone|from|to)($|_|-)/i;
const emailKeyPattern = /email/i;

function sanitizeBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(bindings)) {
    if (secretKeyPattern.test(key)) {
      sanitized[key] = "***";
      continue;
    }

    if (typeof value === "string" && phoneKeyPattern.test(key)) {
      sanitized[key] = maskPhone(value);
      continue;
    }

    if (typeof value === "string" && emailKeyPattern.test(key)) {
      sanitized[key] = maskEmail(value);
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = value.map((entry) =>
        typeof entry === "object" && entry !== null ? sanitizeBindings(entry as Record<string, unknown>) : entry
      );
      continue;
    }

    if (value && typeof value === "object") {
      sanitized[key] = sanitizeBindings(value as Record<string, unknown>);
      continue;
    }

    sanitized[key] = value;
  }

  return redactSecrets(sanitized);
}

function sanitizeContext(bindings: Bindings | LogContext): Record<string, unknown> {
  return sanitizeBindings(bindings as Record<string, unknown>);
}

export function createChildLogger<TLogger extends { child: (bindings: Bindings) => TLogger }>(
  logger: TLogger,
  bindings: Bindings
): TLogger {
  return logger.child(sanitizeContext(bindings) as Bindings);
}

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.x-api-key",
        "req.headers.x-correlation-id",
        "headers.authorization",
        "headers.x-api-key",
        "authorization",
        "apiKey",
        "token",
        "secret",
        "password",
        "signature"
      ],
      censor: "***"
    },
    mixin() {
      return {
        service,
        ...sanitizeContext(getLogContext())
      };
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

export * from "./context";
