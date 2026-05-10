import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    correlationId: string;
  }
}
