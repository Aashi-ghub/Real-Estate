import { z } from "zod";

const booleanishSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }

    return ["true", "1", "yes"].includes(value);
  });

const optionalNonEmptyStringSchema = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);

const baseEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().url().optional(),
    REDIS_HOST: optionalNonEmptyStringSchema,
    REDIS_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    REDIS_USERNAME: optionalNonEmptyStringSchema,
    REDIS_PASSWORD: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
    REDIS_DB: z.coerce.number().int().min(0).default(0),
    REDIS_TLS_ENABLED: booleanishSchema.default(false),
    APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "APP_ENCRYPTION_KEY must be a 64-char hex string"),
    JWT_SECRET: z.string().min(32).optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    DEFAULT_MONTHLY_LEAD_LIMIT: z.coerce.number().int().positive().default(10_000),
    DEFAULT_MONTHLY_API_REQUEST_LIMIT: z.coerce.number().int().positive().default(1_000_000),
    DEFAULT_MONTHLY_WEBHOOK_LIMIT: z.coerce.number().int().positive().default(1_000_000),
    DEFAULT_MONTHLY_QUEUE_JOB_LIMIT: z.coerce.number().int().positive().default(1_000_000),
    QUOTA_WARNING_THRESHOLD_PERCENT: z.coerce.number().int().min(1).max(99).default(80),
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(90),
    API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
    WEBHOOK_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    WEBHOOK_BASE_URL: z.url(),
    WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
    WEBHOOK_REPLAY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(262_144),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(262_144),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
    FOLLOWUP_DELAY_MINUTES: z.coerce.number().int().positive().default(30),
    MESSAGE_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    FOLLOWUP_MAX_RETRIES: z.coerce.number().int().positive().optional(),
    CRM_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    QUEUE_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(1_000),
    QUEUE_RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
    QUEUE_METRICS_SAMPLE_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
    QUEUE_PREFIX: z.string().min(1).default("lead-qualifier"),
    WHATSAPP_DRY_RUN: booleanishSchema.optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_WHATSAPP_FROM: z.string().default("whatsapp:+14155238886"),
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().positive().default(3000)
  })
  .superRefine((value, ctx) => {
    if (value.QUEUE_RETRY_BACKOFF_MAX_MS < value.QUEUE_RETRY_BACKOFF_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["QUEUE_RETRY_BACKOFF_MAX_MS"],
        message: "QUEUE_RETRY_BACKOFF_MAX_MS must be greater than or equal to QUEUE_RETRY_BACKOFF_MS"
      });
    }

    if (value.TWILIO_ACCOUNT_SID && !value.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_AUTH_TOKEN"],
        message: "TWILIO_AUTH_TOKEN is required when TWILIO_ACCOUNT_SID is set"
      });
    }

    if (value.WEBHOOK_BODY_LIMIT_BYTES > value.REQUEST_BODY_LIMIT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WEBHOOK_BODY_LIMIT_BYTES"],
        message: "WEBHOOK_BODY_LIMIT_BYTES cannot exceed REQUEST_BODY_LIMIT_BYTES"
      });
    }

    if (value.NODE_ENV === "production" && !value.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "JWT_SECRET is required in production"
      });
    }
  });

type BaseEnvConfig = z.infer<typeof baseEnvSchema>;

export interface RedisConnectionConfig {
  url: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  db: number;
  tlsEnabled: boolean;
}

export type BaseConfig = BaseEnvConfig & {
  redisConnection: RedisConnectionConfig;
  apiRateLimitWindowSeconds: number;
  webhookRateLimitPerMinute: number;
  webhookRateLimitWindowSeconds: number;
  webhookReplayTtlSeconds: number;
  requestBodyLimitBytes: number;
  webhookBodyLimitBytes: number;
  followupMaxRetries: number;
  queueRetryBackoffMs: number;
  queueRetryBackoffMaxMs: number;
  queueMetricsSampleIntervalMs: number;
  whatsappDryRun: boolean;
  jwtSecret: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  quotaWarningThresholdPercent: number;
  defaultQuotas: {
    leads: number;
    api_requests: number;
    webhooks: number;
    queue_jobs: number;
  };
};

let cachedConfig: BaseConfig | null = null;

function assertRedisEnvSource(env: NodeJS.ProcessEnv): void {
  const hasRedisUrl = typeof env.REDIS_URL === "string" && env.REDIS_URL.length > 0;
  const hasDiscreteRedisConfig = [
    "REDIS_HOST",
    "REDIS_PORT",
    "REDIS_USERNAME",
    "REDIS_PASSWORD",
    "REDIS_DB",
    "REDIS_TLS_ENABLED"
  ].some((key) => typeof env[key] === "string" && env[key]!.length > 0);

  if (hasRedisUrl && hasDiscreteRedisConfig) {
    throw new Error(
      "Configure Redis with either REDIS_URL or REDIS_HOST/REDIS_PORT variables, not both."
    );
  }
}

function buildRedisUrl(config: Omit<RedisConnectionConfig, "url">): string {
  const protocol = config.tlsEnabled ? "rediss" : "redis";
  const url = new URL(`${protocol}://placeholder`);

  url.hostname = config.host;
  url.port = String(config.port);
  url.pathname = `/${config.db}`;

  if (config.username) {
    url.username = config.username;
  }

  if (config.password) {
    url.password = config.password;
  }

  return url.toString();
}

function parseRedisPathname(pathname: string): number {
  if (!pathname || pathname === "/") {
    return 0;
  }

  const parsed = Number(pathname.slice(1));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Redis database index in REDIS_URL: ${pathname}`);
  }

  return parsed;
}

function resolveRedisConnection(config: BaseEnvConfig): RedisConnectionConfig {
  if (config.REDIS_URL) {
    const url = new URL(config.REDIS_URL);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new Error(`Unsupported Redis protocol: ${url.protocol}`);
    }

    return {
      url: config.REDIS_URL,
      host: url.hostname,
      port: url.port ? Number(url.port) : 6379,
      username: url.username || undefined,
      password: url.password || undefined,
      db: parseRedisPathname(url.pathname),
      tlsEnabled: url.protocol === "rediss:"
    };
  }

  const resolved: Omit<RedisConnectionConfig, "url"> = {
    host: config.REDIS_HOST ?? "127.0.0.1",
    port: config.REDIS_PORT ?? 6379,
    username: config.REDIS_USERNAME,
    password: config.REDIS_PASSWORD || undefined,
    db: config.REDIS_DB,
    tlsEnabled: config.REDIS_TLS_ENABLED
  };

  return {
    ...resolved,
    url: buildRedisUrl(resolved)
  };
}

export function getBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  assertRedisEnvSource(env);

  const parsed = baseEnvSchema.parse(env);
  cachedConfig = {
    ...parsed,
    redisConnection: resolveRedisConnection(parsed),
    apiRateLimitWindowSeconds: parsed.API_RATE_LIMIT_WINDOW_SECONDS,
    webhookRateLimitPerMinute: parsed.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    webhookRateLimitWindowSeconds: parsed.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
    webhookReplayTtlSeconds: parsed.WEBHOOK_REPLAY_TTL_SECONDS,
    requestBodyLimitBytes: parsed.REQUEST_BODY_LIMIT_BYTES,
    webhookBodyLimitBytes: parsed.WEBHOOK_BODY_LIMIT_BYTES,
    followupMaxRetries: parsed.FOLLOWUP_MAX_RETRIES ?? parsed.MESSAGE_MAX_RETRIES,
    queueRetryBackoffMs: parsed.QUEUE_RETRY_BACKOFF_MS,
    queueRetryBackoffMaxMs: parsed.QUEUE_RETRY_BACKOFF_MAX_MS,
    queueMetricsSampleIntervalMs: parsed.QUEUE_METRICS_SAMPLE_INTERVAL_MS,
    whatsappDryRun: parsed.WHATSAPP_DRY_RUN ?? (parsed.NODE_ENV !== "production"),
    jwtSecret: parsed.JWT_SECRET ?? parsed.APP_ENCRYPTION_KEY,
    jwtAccessTtlSeconds: parsed.JWT_ACCESS_TTL_SECONDS,
    jwtRefreshTtlSeconds: parsed.JWT_REFRESH_TTL_SECONDS,
    quotaWarningThresholdPercent: parsed.QUOTA_WARNING_THRESHOLD_PERCENT,
    defaultQuotas: {
      leads: parsed.DEFAULT_MONTHLY_LEAD_LIMIT,
      api_requests: parsed.DEFAULT_MONTHLY_API_REQUEST_LIMIT,
      webhooks: parsed.DEFAULT_MONTHLY_WEBHOOK_LIMIT,
      queue_jobs: parsed.DEFAULT_MONTHLY_QUEUE_JOB_LIMIT
    }
  };
  return cachedConfig;
}

export interface ApiConfig extends BaseConfig {
  apiHost: string;
  apiPort: number;
}

export function getApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config = getBaseConfig(env);

  return {
    ...config,
    apiHost: config.API_HOST,
    apiPort: config.API_PORT
  };
}

export interface WorkerConfig extends BaseConfig {
  workerConcurrency: number;
}

export function getWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = getBaseConfig(env);

  return {
    ...config,
    workerConcurrency: config.WORKER_CONCURRENCY
  };
}
