import { Queue, QueueEvents, Worker, type RedisOptions as BullMqRedisOptions } from "bullmq";
import IORedis, { type Redis, type RedisOptions as IORedisOptions } from "ioredis";

import type { RedisConnectionConfig } from "@real-estate/config";

const unsupportedServerMarkers = [
  "garnet_version",
  "dragonfly_version",
  "keydb_version",
  "valkey_version",
  "memorydb_version"
] as const;

const evalProbeScript = "return ARGV[1]";
const evalProbeValue = "bullmq:lua:ok";
const defaultHealthQueueName = "queue-health";

interface LogSink {
  info?: (payload: Record<string, unknown>, message?: string) => void;
  error?: (payload: Record<string, unknown>, message?: string) => void;
}

export interface RedisServerCapabilities {
  endpoint: string;
  version: string;
  mode?: string;
  rawInfo: Record<string, string>;
}

export interface BullMqRoundTripHealthcheckOptions {
  connection: BullMqRedisOptions;
  prefix: string;
  timeoutMs?: number;
  queueName?: string;
  instanceName?: string;
  logger?: LogSink;
}

function parseRedisInfo(info: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of info.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    parsed[key] = value;
  }

  return parsed;
}

function getRedisMajorVersion(version: string): number {
  const [major] = version.split(".");
  return Number(major);
}

function formatRedisEndpoint(connection: RedisConnectionConfig): string {
  return `${connection.host}:${connection.port}`;
}

export function redactRedisConnection(connection: RedisConnectionConfig): Record<string, unknown> {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    hasPassword: Boolean(connection.password),
    db: connection.db,
    tlsEnabled: connection.tlsEnabled
  };
}

export function buildRedisClientOptions(
  connection: RedisConnectionConfig,
  overrides: Partial<IORedisOptions> = {}
): IORedisOptions {
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    db: connection.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...(connection.tlsEnabled ? { tls: {} } : {}),
    ...overrides
  };
}

export function buildBullMqConnection(
  connection: RedisConnectionConfig,
  overrides: Partial<BullMqRedisOptions> = {}
): BullMqRedisOptions {
  return {
    ...buildRedisClientOptions(connection),
    ...overrides
  };
}

export function createRedisClient(
  connection: RedisConnectionConfig,
  overrides: Partial<IORedisOptions> = {}
): Redis {
  return new IORedis(buildRedisClientOptions(connection, overrides));
}

export async function assertRedisCompatibleWithBullMq(
  redis: Redis,
  connection: RedisConnectionConfig
): Promise<RedisServerCapabilities> {
  const endpoint = formatRedisEndpoint(connection);

  try {
    const ping = await redis.ping();
    if (ping !== "PONG") {
      throw new Error(`unexpected PING response: ${ping}`);
    }

    const info = parseRedisInfo(await redis.info("server"));
    const version = info.redis_version;
    if (!version) {
      throw new Error("INFO SERVER did not return redis_version");
    }

    const unsupportedMarker = unsupportedServerMarkers.find((marker) => marker in info);
    if (unsupportedMarker) {
      throw new Error(
        `unsupported Redis-compatible server detected (${unsupportedMarker}). BullMQ requires Redis OSS/Redis Stack 6+ or 7+`
      );
    }

    const majorVersion = getRedisMajorVersion(version);
    if (!Number.isInteger(majorVersion) || majorVersion < 6) {
      throw new Error(`BullMQ requires Redis 6+ with Lua scripting support. Current redis_version: ${version}`);
    }

    const evalResult = await redis.eval(evalProbeScript, 0, evalProbeValue);
    if (evalResult !== evalProbeValue) {
      throw new Error(`EVAL returned unexpected result: ${String(evalResult)}`);
    }

    const scriptSha = String(await redis.script("LOAD", evalProbeScript));
    const evalShaResult = await redis.evalsha(scriptSha, 0, evalProbeValue);
    if (evalShaResult !== evalProbeValue) {
      throw new Error(`EVALSHA returned unexpected result: ${String(evalShaResult)}`);
    }

    return {
      endpoint,
      version,
      mode: info.redis_mode,
      rawInfo: info
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown Redis compatibility error";
    throw new Error(`Redis compatibility check failed for ${endpoint}: ${message}`);
  }
}

export async function runBullMqRoundTripHealthcheck(
  options: BullMqRoundTripHealthcheckOptions
): Promise<{ queueName: string; jobId: string }> {
  const queueName = options.queueName ?? defaultHealthQueueName;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const instanceName = options.instanceName ?? `pid-${process.pid}`;
  const jobId = `startup:${instanceName}:${Date.now()}`;

  const queue = new Queue(queueName, {
    connection: options.connection,
    prefix: options.prefix
  });
  const queueEvents = new QueueEvents(queueName, {
    connection: options.connection,
    prefix: options.prefix
  });
  const worker = new Worker(
    queueName,
    async (job) => ({
      ok: true,
      queueName,
      jobId: String(job.id)
    }),
    {
      connection: options.connection,
      prefix: options.prefix,
      concurrency: 1
    }
  );

  try {
    await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady()]);

    const job = await queue.add(
      "startup_probe",
      {
        instanceName,
        createdAt: new Date().toISOString()
      },
      {
        jobId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false
      }
    );

    await job.waitUntilFinished(queueEvents, timeoutMs);
    options.logger?.info?.({ queueName, jobId }, "bullmq.healthcheck.passed");

    return { queueName, jobId };
  } catch (error) {
    options.logger?.error?.(
      {
        err: error instanceof Error ? error : new Error("Unknown BullMQ healthcheck error"),
        queueName,
        jobId
      },
      "bullmq.healthcheck.failed"
    );
    throw error;
  } finally {
    await Promise.allSettled([worker.close(), queueEvents.close(), queue.close()]);
  }
}
