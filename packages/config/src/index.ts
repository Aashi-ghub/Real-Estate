import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "APP_ENCRYPTION_KEY must be a 64-char hex string"),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  WEBHOOK_BASE_URL: z.url(),
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  FOLLOWUP_DELAY_MINUTES: z.coerce.number().int().positive().default(30),
  MESSAGE_MAX_RETRIES: z.coerce.number().int().positive().default(5),
  CRM_MAX_RETRIES: z.coerce.number().int().positive().default(5),
  QUEUE_PREFIX: z.string().min(1).default("lead-qualifier"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().default("whatsapp:+14155238886"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000)
});

export type BaseConfig = z.infer<typeof baseEnvSchema>;

let cachedConfig: BaseConfig | null = null;

export function getBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = baseEnvSchema.parse(env);
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
