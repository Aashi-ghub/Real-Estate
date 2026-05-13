CREATE TYPE "LeadPriority" AS ENUM ('HOT', 'WARM', 'COLD');
CREATE TYPE "FollowUpTrigger" AS ENUM ('no_reply', 'incomplete_qualification', 'warm_lead_reengagement', 'revisit_reminder');
CREATE TYPE "FollowUpStatus" AS ENUM ('scheduled', 'sent', 'cancelled', 'skipped', 'failed');

ALTER TYPE "LeadAttributeKey" ADD VALUE IF NOT EXISTS 'property_type';
ALTER TYPE "LeadAttributeKey" ADD VALUE IF NOT EXISTS 'financing_needed';

ALTER TABLE "Lead"
  ADD COLUMN "priority" "LeadPriority" NOT NULL DEFAULT 'COLD',
  ADD COLUMN "qualificationCompleteness" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "intentConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "crmSyncStatus" "CrmSyncStatus",
  ADD COLUMN "crmExternalId" VARCHAR(128),
  ADD COLUMN "crmLastSyncAt" TIMESTAMP(3),
  ADD COLUMN "crmErrorLogs" JSONB;

ALTER TABLE "LeadAttribute"
  ADD COLUMN "rawValue" TEXT,
  ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "source" VARCHAR(40) NOT NULL DEFAULT 'rule',
  ADD COLUMN "metadata" JSONB;

CREATE TABLE "LeadScore" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "leadId" UUID NOT NULL,
  "clientId" UUID NOT NULL,
  "total" INTEGER NOT NULL,
  "priority" "LeadPriority" NOT NULL,
  "breakdown" JSONB NOT NULL,
  "version" VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeadScore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrmSyncLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "crmSyncId" UUID,
  "idempotencyKey" VARCHAR(255) NOT NULL,
  "status" "CrmSyncStatus" NOT NULL,
  "provider" "CrmType" NOT NULL,
  "externalId" VARCHAR(128),
  "error" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CrmSyncLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FollowUp" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "trigger" "FollowUpTrigger" NOT NULL,
  "status" "FollowUpStatus" NOT NULL DEFAULT 'scheduled',
  "dedupeKey" VARCHAR(255) NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FollowUp_dedupeKey_key" ON "FollowUp"("dedupeKey");
CREATE INDEX "Lead_clientId_priority_score_idx" ON "Lead"("clientId", "priority", "score");
CREATE INDEX "Lead_clientId_crmSyncStatus_idx" ON "Lead"("clientId", "crmSyncStatus");
CREATE INDEX "Lead_clientId_qualificationCompleteness_idx" ON "Lead"("clientId", "qualificationCompleteness");
CREATE INDEX "LeadScore_clientId_total_idx" ON "LeadScore"("clientId", "total");
CREATE INDEX "LeadScore_leadId_createdAt_idx" ON "LeadScore"("leadId", "createdAt");
CREATE INDEX "CrmSyncLog_clientId_leadId_createdAt_idx" ON "CrmSyncLog"("clientId", "leadId", "createdAt");
CREATE INDEX "CrmSyncLog_idempotencyKey_idx" ON "CrmSyncLog"("idempotencyKey");
CREATE INDEX "FollowUp_clientId_status_scheduledAt_idx" ON "FollowUp"("clientId", "status", "scheduledAt");
CREATE INDEX "FollowUp_leadId_status_idx" ON "FollowUp"("leadId", "status");
CREATE INDEX "FollowUp_conversationId_trigger_idx" ON "FollowUp"("conversationId", "trigger");

ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CrmSyncLog" ADD CONSTRAINT "CrmSyncLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
