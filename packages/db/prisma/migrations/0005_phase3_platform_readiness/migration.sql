CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "RoleName" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'AGENT', 'VIEWER');
CREATE TYPE "RefreshSessionStatus" AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE "AuditEventSeverity" AS ENUM ('info', 'warn', 'error');
CREATE TYPE "TenantUsageMetric" AS ENUM ('leads', 'api_requests', 'webhooks', 'queue_jobs');
CREATE TYPE "QuotaEventType" AS ENUM ('warning', 'exceeded', 'enforced');

ALTER TABLE "ApiKey"
  ADD COLUMN "prefix" VARCHAR(24),
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "usageCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix") WHERE "prefix" IS NOT NULL;
CREATE INDEX "ApiKey_clientId_prefix_idx" ON "ApiKey"("clientId", "prefix");
CREATE INDEX "ApiKey_clientId_expiresAt_idx" ON "ApiKey"("clientId", "expiresAt");

CREATE TABLE "User" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "email" VARCHAR(255) NOT NULL,
  "passwordHash" VARCHAR(255) NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_clientId_status_idx" ON "User"("clientId", "status");
CREATE INDEX "User_email_status_idx" ON "User"("email", "status");
ALTER TABLE "User" ADD CONSTRAINT "User_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Role" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" "RoleName" NOT NULL,
  "description" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

CREATE TABLE "Permission" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(120) NOT NULL,
  "description" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

CREATE TABLE "UserRole" (
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "roleId")
);

CREATE INDEX "UserRole_roleId_idx" ON "UserRole"("roleId");
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RolePermission" (
  "roleId" UUID NOT NULL,
  "permissionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RefreshSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "tokenHash" VARCHAR(128) NOT NULL,
  "status" "RefreshSessionStatus" NOT NULL DEFAULT 'active',
  "userAgent" VARCHAR(255),
  "ipAddress" VARCHAR(64),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");
CREATE INDEX "RefreshSession_userId_status_idx" ON "RefreshSession"("userId", "status");
CREATE INDEX "RefreshSession_expiresAt_idx" ON "RefreshSession"("expiresAt");
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "actorType" VARCHAR(40) NOT NULL,
  "actorId" VARCHAR(120),
  "action" VARCHAR(120) NOT NULL,
  "entity" VARCHAR(120) NOT NULL,
  "entityId" VARCHAR(120),
  "requestId" VARCHAR(128),
  "correlationId" VARCHAR(128),
  "ipAddress" VARCHAR(64),
  "userAgent" VARCHAR(255),
  "severity" "AuditEventSeverity" NOT NULL DEFAULT 'info',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEvent_clientId_createdAt_idx" ON "AuditEvent"("clientId", "createdAt");
CREATE INDEX "AuditEvent_clientId_action_createdAt_idx" ON "AuditEvent"("clientId", "action", "createdAt");
CREATE INDEX "AuditEvent_entity_entityId_createdAt_idx" ON "AuditEvent"("entity", "entityId", "createdAt");
CREATE INDEX "AuditEvent_requestId_correlationId_createdAt_idx" ON "AuditEvent"("requestId", "correlationId", "createdAt");
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BillingPeriod" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "planKey" VARCHAR(80) NOT NULL,
  "quotas" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingPeriod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPeriod_clientId_startsAt_endsAt_key" ON "BillingPeriod"("clientId", "startsAt", "endsAt");
CREATE INDEX "BillingPeriod_clientId_startsAt_endsAt_idx" ON "BillingPeriod"("clientId", "startsAt", "endsAt");
ALTER TABLE "BillingPeriod" ADD CONSTRAINT "BillingPeriod_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TenantUsage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "billingPeriodId" UUID NOT NULL,
  "metric" "TenantUsageMetric" NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  "limit" INTEGER NOT NULL,
  "warnedAt" TIMESTAMP(3),
  "exceededAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantUsage_clientId_billingPeriodId_metric_key" ON "TenantUsage"("clientId", "billingPeriodId", "metric");
CREATE INDEX "TenantUsage_clientId_metric_idx" ON "TenantUsage"("clientId", "metric");
ALTER TABLE "TenantUsage" ADD CONSTRAINT "TenantUsage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantUsage" ADD CONSTRAINT "TenantUsage_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "QuotaEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "billingPeriodId" UUID NOT NULL,
  "metric" "TenantUsageMetric" NOT NULL,
  "eventType" "QuotaEventType" NOT NULL,
  "usageValue" INTEGER NOT NULL,
  "limitValue" INTEGER NOT NULL,
  "requestId" VARCHAR(128),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuotaEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuotaEvent_clientId_metric_createdAt_idx" ON "QuotaEvent"("clientId", "metric", "createdAt");
CREATE INDEX "QuotaEvent_billingPeriodId_createdAt_idx" ON "QuotaEvent"("billingPeriodId", "createdAt");

CREATE TABLE "RateLimitBucket" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "subject" VARCHAR(180) NOT NULL,
  "windowKey" VARCHAR(80) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RateLimitBucket_subject_windowKey_key" ON "RateLimitBucket"("subject", "windowKey");
CREATE INDEX "RateLimitBucket_clientId_expiresAt_idx" ON "RateLimitBucket"("clientId", "expiresAt");
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");
ALTER TABLE "RateLimitBucket" ADD CONSTRAINT "RateLimitBucket_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkerHeartbeat" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "workerName" VARCHAR(120) NOT NULL,
  "queueName" VARCHAR(64) NOT NULL,
  "processId" INTEGER NOT NULL,
  "hostname" VARCHAR(120) NOT NULL,
  "status" VARCHAR(40) NOT NULL,
  "lastBeatAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerHeartbeat_workerName_queueName_processId_hostname_key" ON "WorkerHeartbeat"("workerName", "queueName", "processId", "hostname");
CREATE INDEX "WorkerHeartbeat_queueName_status_lastBeatAt_idx" ON "WorkerHeartbeat"("queueName", "status", "lastBeatAt");
CREATE INDEX "WorkerHeartbeat_clientId_lastBeatAt_idx" ON "WorkerHeartbeat"("clientId", "lastBeatAt");
ALTER TABLE "WorkerHeartbeat" ADD CONSTRAINT "WorkerHeartbeat_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Role" ("name", "description") VALUES
  ('SUPER_ADMIN', 'Full platform administration'),
  ('TENANT_ADMIN', 'Tenant administration'),
  ('AGENT', 'Lead and conversation operations'),
  ('VIEWER', 'Read-only dashboard access')
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "Permission" ("key", "description") VALUES
  ('admin:read', 'Read operational administration data'),
  ('admin:write', 'Execute operational administration actions'),
  ('api_keys:read', 'Read API key metadata'),
  ('api_keys:write', 'Create, rotate, and revoke API keys'),
  ('audit:read', 'Read audit events'),
  ('dashboard:read', 'Read dashboard data'),
  ('leads:write', 'Create and update leads'),
  ('usage:read', 'Read tenant usage')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE
  (r."name" = 'SUPER_ADMIN')
  OR (r."name" = 'TENANT_ADMIN' AND p."key" IN ('api_keys:read', 'api_keys:write', 'audit:read', 'dashboard:read', 'leads:write', 'usage:read'))
  OR (r."name" = 'AGENT' AND p."key" IN ('dashboard:read', 'leads:write'))
  OR (r."name" = 'VIEWER' AND p."key" IN ('dashboard:read'))
ON CONFLICT DO NOTHING;
