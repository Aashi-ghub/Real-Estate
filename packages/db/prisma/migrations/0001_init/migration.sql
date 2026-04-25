CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "ClientStatus" AS ENUM ('active', 'paused');
CREATE TYPE "WhatsAppProvider" AS ENUM ('twilio', 'meta');
CREATE TYPE "CrmType" AS ENUM ('zoho', 'hubspot', 'custom');
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'visit_booked', 'closed', 'lost');
CREATE TYPE "LeadAttributeKey" AS ENUM ('budget', 'location', 'timeline', 'purpose');
CREATE TYPE "ConversationChannel" AS ENUM ('whatsapp');
CREATE TYPE "ConversationState" AS ENUM ('INIT', 'ASK_BUDGET', 'ASK_LOCATION', 'ASK_TIMELINE', 'ASK_PURPOSE', 'QUALIFIED');
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');
CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'revoked');
CREATE TYPE "JobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'dead_letter');
CREATE TYPE "CrmSyncStatus" AS ENUM ('pending', 'processing', 'success', 'failed');

CREATE TABLE "Client" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(120) NOT NULL,
  "status" "ClientStatus" NOT NULL,
  "timezone" VARCHAR(64) NOT NULL,
  "whatsappProvider" "WhatsAppProvider" NOT NULL,
  "whatsappConfig" JSONB NOT NULL,
  "crmType" "CrmType" NOT NULL,
  "crmConfig" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiKey" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "hashedKey" VARCHAR(128) NOT NULL,
  "status" "ApiKeyStatus" NOT NULL DEFAULT 'active',
  "lastUsedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApiKey_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Lead" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "phone" VARCHAR(32) NOT NULL,
  "email" VARCHAR(255),
  "source" VARCHAR(100) NOT NULL,
  "status" "LeadStatus" NOT NULL DEFAULT 'new',
  "score" INTEGER NOT NULL DEFAULT 0,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Lead_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LeadAttribute" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "leadId" UUID NOT NULL,
  "key" "LeadAttributeKey" NOT NULL,
  "value" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadAttribute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeadAttribute_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Conversation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "leadId" UUID NOT NULL,
  "channel" "ConversationChannel" NOT NULL,
  "state" "ConversationState" NOT NULL DEFAULT 'INIT',
  "context" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lastMessageAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Message" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL,
  "direction" "MessageDirection" NOT NULL,
  "content" TEXT NOT NULL,
  "providerMessageId" VARCHAR(120),
  "dedupeKey" VARCHAR(255),
  "status" "MessageStatus" NOT NULL DEFAULT 'queued',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "queue" VARCHAR(64) NOT NULL,
  "name" VARCHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "scheduledAt" TIMESTAMPTZ,
  "processedAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Job_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AuditLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "actor" VARCHAR(120) NOT NULL,
  "action" VARCHAR(120) NOT NULL,
  "entity" VARCHAR(120) NOT NULL,
  "entityId" VARCHAR(64) NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CrmSync" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "status" "CrmSyncStatus" NOT NULL DEFAULT 'pending',
  "requestPayload" JSONB NOT NULL,
  "responsePayload" JSONB,
  "externalId" VARCHAR(128),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmSync_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CrmSync_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CrmSync_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey" ("hashedKey");
CREATE UNIQUE INDEX "Lead_idempotencyKey_key" ON "Lead" ("idempotencyKey");
CREATE UNIQUE INDEX "LeadAttribute_leadId_key_key" ON "LeadAttribute" ("leadId", "key");
CREATE UNIQUE INDEX "Conversation_leadId_key" ON "Conversation" ("leadId");
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message" ("providerMessageId");
CREATE UNIQUE INDEX "Message_dedupeKey_key" ON "Message" ("dedupeKey");
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job" ("idempotencyKey");
CREATE UNIQUE INDEX "CrmSync_idempotencyKey_key" ON "CrmSync" ("idempotencyKey");

CREATE INDEX "Client_status_idx" ON "Client" ("status");
CREATE INDEX "ApiKey_clientId_status_idx" ON "ApiKey" ("clientId", "status");
CREATE INDEX "Lead_phone_idx" ON "Lead" ("phone");
CREATE INDEX "Lead_clientId_phone_idx" ON "Lead" ("clientId", "phone");
CREATE INDEX "Lead_clientId_status_idx" ON "Lead" ("clientId", "status");
CREATE INDEX "Lead_clientId_createdAt_idx" ON "Lead" ("clientId", "createdAt");
CREATE INDEX "LeadAttribute_leadId_idx" ON "LeadAttribute" ("leadId");
CREATE INDEX "Conversation_state_lastMessageAt_idx" ON "Conversation" ("state", "lastMessageAt");
CREATE INDEX "Message_conversationId_idx" ON "Message" ("conversationId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message" ("conversationId", "createdAt");
CREATE INDEX "Job_clientId_queue_status_idx" ON "Job" ("clientId", "queue", "status");
CREATE INDEX "Job_leadId_name_idx" ON "Job" ("leadId", "name");
CREATE INDEX "AuditLog_clientId_createdAt_idx" ON "AuditLog" ("clientId", "createdAt");
CREATE INDEX "AuditLog_entity_entityId_createdAt_idx" ON "AuditLog" ("entity", "entityId", "createdAt");
CREATE INDEX "CrmSync_clientId_leadId_status_idx" ON "CrmSync" ("clientId", "leadId", "status");
