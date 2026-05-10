ALTER TABLE "Job"
ADD COLUMN "requestId" VARCHAR(128),
ADD COLUMN "correlationId" VARCHAR(128),
ADD COLUMN "metadata" JSONB;

ALTER TABLE "AuditLog"
ADD COLUMN "requestId" VARCHAR(128),
ADD COLUMN "correlationId" VARCHAR(128);

CREATE INDEX "Job_requestId_correlationId_idx" ON "Job"("requestId", "correlationId");
CREATE INDEX "AuditLog_requestId_correlationId_createdAt_idx" ON "AuditLog"("requestId", "correlationId", "createdAt");
