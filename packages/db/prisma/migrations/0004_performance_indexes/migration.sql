CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "Job"
  ADD COLUMN IF NOT EXISTS "requestId" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "correlationId" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "AuditLog"
  ADD COLUMN IF NOT EXISTS "requestId" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "correlationId" VARCHAR(128);

CREATE INDEX IF NOT EXISTS "Job_requestId_correlationId_idx"
  ON "Job" ("requestId", "correlationId");

CREATE INDEX IF NOT EXISTS "AuditLog_requestId_correlationId_createdAt_idx"
  ON "AuditLog" ("requestId", "correlationId", "createdAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_status_createdAt_idx"
  ON "Lead" ("clientId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_status_updatedAt_idx"
  ON "Lead" ("clientId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_priority_createdAt_idx"
  ON "Lead" ("clientId", "priority", "createdAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_qualificationCompleteness_createdAt_idx"
  ON "Lead" ("clientId", "qualificationCompleteness", "createdAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_updatedAt_idx"
  ON "Lead" ("clientId", "updatedAt");

CREATE INDEX IF NOT EXISTS "Lead_clientId_score_idx"
  ON "Lead" ("clientId", "score");

CREATE INDEX IF NOT EXISTS "Lead_clientId_source_createdAt_idx"
  ON "Lead" ("clientId", "source", "createdAt");

CREATE INDEX IF NOT EXISTS "Lead_name_trgm_idx"
  ON "Lead" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Lead_email_trgm_idx"
  ON "Lead" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Lead_phone_trgm_idx"
  ON "Lead" USING gin ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Message_conversationId_direction_createdAt_idx"
  ON "Message" ("conversationId", "direction", "createdAt");

CREATE INDEX IF NOT EXISTS "FollowUp_clientId_scheduledAt_idx"
  ON "FollowUp" ("clientId", "scheduledAt");
