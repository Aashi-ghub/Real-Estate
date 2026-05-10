# Real Estate Lead Qualification Backend

Production-oriented TypeScript backend for multi-tenant real estate lead qualification with Fastify, Prisma/PostgreSQL, BullMQ/Redis, deterministic WhatsApp conversation flows, CRM push, audit logging, and Prometheus metrics.

## Features

- Multi-tenant API with per-client API keys and tenant-scoped idempotency.
- Deterministic conversation engine backed by database state only.
- WhatsApp inbound/outbound integration with Twilio and Meta signature verification.
- BullMQ workers with retries, exponential backoff, mirrored job visibility, and dead-letter queues.
- Full audit log trail for lead mutations, PII handling, outbound messages, and CRM sync.
- Structured logs with request IDs and Prometheus metrics exposed at `/metrics`.

## Layout

- `apps/api`: Fastify HTTP API
- `apps/worker`: BullMQ workers
- `packages/db`: Prisma schema, migrations, seed, and DB helpers
- `packages/config`: environment parsing
- `packages/logger`: Pino logger factory
- `packages/types`: shared contracts
- `packages/utils`: conversation engine, parsers, security, adapters, metrics
- `docker`: Dockerfile, compose, and entrypoint scripts

## Environment

Copy `.env.example` to `.env` and update at least:

- `DATABASE_URL`
- `REDIS_URL` or `REDIS_HOST` / `REDIS_PORT`
- `APP_ENCRYPTION_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`

BullMQ is validated at startup against Redis Lua scripting. Use real Redis 6+ or 7+ only. The API and worker will refuse to start if the target server does not support `EVAL` / `EVALSHA`.

## Local Run

```bash
npm install
npm run db:generate
docker compose -f docker/docker-compose.yml up -d postgres redis
npm run db:deploy
npm run db:seed
npm run dev:api
npm run dev:worker
```

The seed prints a local client id and API key. By default:

- `client_id`: `11111111-1111-4111-8111-111111111111`
- `x-api-key`: `local-dev-api-key-123456`

## Full Docker Compose

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up --build
```

## Tests

```bash
npm test
```

## Example Requests

Create a lead:

```bash
curl -X POST http://localhost:3000/leads \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-dev-api-key-123456" \
  -H "idempotency-key: lead-0001" \
  -d '{
    "client_id": "11111111-1111-4111-8111-111111111111",
    "name": "Rohan Mehta",
    "phone": "+919811112222",
    "email": "rohan@example.com",
    "source": "landing-page",
    "metadata": {
      "campaign": "spring-launch"
    }
  }'
```

Health and metrics:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

Meta-style inbound webhook with HMAC:

```bash
BODY='{"client_id":"client-1","object":"whatsapp_business_account","entry":[{"changes":[{"value":{"metadata":{"display_phone_number":"+919999999999"},"messages":[{"id":"wamid.12345","from":"919812345678","text":{"body":"Budget 80 lakh to 1 crore in Whitefield within 2 months for investment"}}]}}]}]}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "meta-signing-secret" -hex | awk '{print $2}')

curl -X POST http://localhost:3000/whatsapp/inbound \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: sha256=$SIG" \
  -d "$BODY"
```

## Operational Notes

- API lead creation is idempotent by tenant-scoped `idempotency-key`.
- Webhook ingestion deduplicates on `providerMessageId`.
- Workers keep no in-memory conversation state; all transitions read/write PostgreSQL.
- Failed jobs are mirrored into the `Job` table and copied to queue-specific DLQs after retries are exhausted.
- Startup performs a Redis compatibility check plus a BullMQ enqueue/process/complete round-trip health probe before workers declare readiness.
