import "fastify";
import type { AuthenticatedApiKey, AuthenticatedUser } from "@real-estate/types";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    correlationId: string;
    auth?: {
      apiKey?: AuthenticatedApiKey;
      user?: AuthenticatedUser;
    };
  }
}
