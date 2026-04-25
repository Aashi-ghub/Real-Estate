import { Prisma } from "./generated";
import { PrismaClient } from "./generated";

declare global {
  // eslint-disable-next-line no-var
  var __realEstatePrisma__: PrismaClient | undefined;
}

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" }
    ]
  });
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
