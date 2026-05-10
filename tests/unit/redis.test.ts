import { describe, expect, it } from "vitest";

import type { RedisConnectionConfig } from "@real-estate/config";
import { assertRedisCompatibleWithBullMq, buildBullMqConnection } from "@real-estate/utils";

class FakeRedis {
  constructor(
    private readonly infoResponse: string,
    private readonly evalResponse = "bullmq:lua:ok"
  ) {}

  async ping(): Promise<string> {
    return "PONG";
  }

  async info(_section: string): Promise<string> {
    return this.infoResponse;
  }

  async eval(): Promise<string> {
    return this.evalResponse;
  }

  async script(_command: string, _script: string): Promise<string> {
    return "script-sha";
  }

  async evalsha(): Promise<string> {
    return this.evalResponse;
  }
}

const redisConnection: RedisConnectionConfig = {
  url: "redis://127.0.0.1:6379/0",
  host: "127.0.0.1",
  port: 6379,
  db: 0,
  tlsEnabled: false
};

describe("redis compatibility", () => {
  it("rejects Redis versions lower than 6 before BullMQ starts", async () => {
    const redis = new FakeRedis("# Server\nredis_version:3.0.504\nredis_mode:standalone\n");

    await expect(assertRedisCompatibleWithBullMq(redis as never, redisConnection)).rejects.toThrow(
      "BullMQ requires Redis 6+ with Lua scripting support"
    );
  });

  it("accepts Redis 7 when EVAL and EVALSHA succeed", async () => {
    const redis = new FakeRedis("# Server\nredis_version:7.2.5\nredis_mode:standalone\n");

    await expect(assertRedisCompatibleWithBullMq(redis as never, redisConnection)).resolves.toMatchObject({
      endpoint: "127.0.0.1:6379",
      version: "7.2.5"
    });
  });

  it("builds BullMQ connection options from the shared Redis config", () => {
    expect(buildBullMqConnection(redisConnection)).toMatchObject({
      host: "127.0.0.1",
      port: 6379,
      db: 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false
    });
  });
});
