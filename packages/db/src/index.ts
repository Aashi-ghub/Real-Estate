import { Prisma } from "./generated";
import { PrismaClient } from "./generated";
import { createLogger } from "@real-estate/logger";

declare global {
  // eslint-disable-next-line no-var
  var __realEstatePrisma__: PrismaClient | undefined;
}

const prismaLogger = createLogger("database", process.env.LOG_LEVEL);

export function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" }
    ]
  });

  client.$on("warn", (event) => {
    prismaLogger.warn({ target: event.target, message: event.message }, "prisma.warn");
  });

  client.$on("error", (event) => {
    prismaLogger.error({ target: event.target, message: event.message }, "prisma.error");
  });

  return client;
}

export const db = globalThis.__realEstatePrisma__ ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__realEstatePrisma__ = db;
}

export function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function isNotFoundError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

export * from "./helpers";
export { Prisma, PrismaClient };
