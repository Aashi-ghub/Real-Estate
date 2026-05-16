CREATE TYPE "SloTargetType" AS ENUM ('api_latency', 'webhook_latency', 'ai_latency', 'queue_throughput', 'retrieval_latency');
CREATE TYPE "SloIncidentStatus" AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE "ChaosScenarioStatus" AS ENUM ('running', 'passed', 'failed', 'degraded', 'quarantined');

CREATE TABLE "EvaluationReproducibilityManifest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "manifestVersion" VARCHAR(40) NOT NULL,
  "inputChecksum" VARCHAR(128) NOT NULL,
  "semanticChecksum" VARCHAR(128) NOT NULL,
  "datasetChecksum" VARCHAR(128) NOT NULL,
  "deterministic" BOOLEAN NOT NULL DEFAULT true,
  "excludedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "replayOfRunId" UUID,
  "replayMatches" BOOLEAN,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationReproducibilityManifest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BehavioralEvaluationMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "runId" UUID,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "stabilityScore" DOUBLE PRECISION NOT NULL,
  "hesitationConsistency" DOUBLE PRECISION NOT NULL,
  "urgencyEscalation" DOUBLE PRECISION NOT NULL,
  "trustRecoveryScore" DOUBLE PRECISION NOT NULL,
  "ghostingRiskStability" DOUBLE PRECISION NOT NULL,
  "confidenceDrift" DOUBLE PRECISION NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BehavioralEvaluationMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SloDefinition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "targetType" "SloTargetType" NOT NULL,
  "target" DOUBLE PRECISION NOT NULL,
  "windowMinutes" INTEGER NOT NULL,
  "threshold" JSONB NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SloDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SloIncident" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "sloDefinitionId" UUID NOT NULL,
  "status" "SloIncidentStatus" NOT NULL DEFAULT 'open',
  "severity" "BenchmarkSeverity" NOT NULL DEFAULT 'warn',
  "burnRate" DOUBLE PRECISION NOT NULL,
  "compliance" DOUBLE PRECISION NOT NULL,
  "errorBudgetRemaining" DOUBLE PRECISION NOT NULL,
  "degradation" VARCHAR(40) NOT NULL,
  "correlation" JSONB NOT NULL DEFAULT '{}',
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SloIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QueueFairnessMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "queueName" VARCHAR(64) NOT NULL,
  "partitionKey" VARCHAR(120) NOT NULL,
  "waitingJobs" INTEGER NOT NULL,
  "activeJobs" INTEGER NOT NULL,
  "throughputPerMinute" DOUBLE PRECISION NOT NULL,
  "fairnessScore" DOUBLE PRECISION NOT NULL,
  "throttleApplied" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QueueFairnessMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChaosExecutionLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "scenarioType" VARCHAR(80) NOT NULL,
  "status" "ChaosScenarioStatus" NOT NULL,
  "inputChecksum" VARCHAR(128) NOT NULL,
  "recoveryAction" VARCHAR(120),
  "operationalImpact" JSONB NOT NULL DEFAULT '{}',
  "fallbackActivated" BOOLEAN NOT NULL DEFAULT false,
  "quarantineReason" VARCHAR(160),
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChaosExecutionLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsRollup" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "rollupType" VARCHAR(80) NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "checksum" VARCHAR(128) NOT NULL,
  "metrics" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalyticsRollup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EvaluationReproducibilityManifest_clientId_createdAt_idx" ON "EvaluationReproducibilityManifest"("clientId", "createdAt");
CREATE INDEX "EvaluationReproducibilityManifest_runId_createdAt_idx" ON "EvaluationReproducibilityManifest"("runId", "createdAt");
CREATE INDEX "EvaluationReproducibilityManifest_semanticChecksum_idx" ON "EvaluationReproducibilityManifest"("semanticChecksum");
CREATE INDEX "BehavioralEvaluationMetric_clientId_windowStart_windowEnd_idx" ON "BehavioralEvaluationMetric"("clientId", "windowStart", "windowEnd");
CREATE INDEX "BehavioralEvaluationMetric_leadId_createdAt_idx" ON "BehavioralEvaluationMetric"("leadId", "createdAt");
CREATE INDEX "BehavioralEvaluationMetric_runId_createdAt_idx" ON "BehavioralEvaluationMetric"("runId", "createdAt");
CREATE UNIQUE INDEX "SloDefinition_clientId_name_key" ON "SloDefinition"("clientId", "name");
CREATE INDEX "SloDefinition_clientId_targetType_isActive_idx" ON "SloDefinition"("clientId", "targetType", "isActive");
CREATE INDEX "SloIncident_clientId_status_openedAt_idx" ON "SloIncident"("clientId", "status", "openedAt");
CREATE INDEX "SloIncident_sloDefinitionId_openedAt_idx" ON "SloIncident"("sloDefinitionId", "openedAt");
CREATE INDEX "QueueFairnessMetric_queueName_observedAt_idx" ON "QueueFairnessMetric"("queueName", "observedAt");
CREATE INDEX "QueueFairnessMetric_clientId_observedAt_idx" ON "QueueFairnessMetric"("clientId", "observedAt");
CREATE INDEX "QueueFairnessMetric_partitionKey_observedAt_idx" ON "QueueFairnessMetric"("partitionKey", "observedAt");
CREATE INDEX "ChaosExecutionLog_clientId_scenarioType_createdAt_idx" ON "ChaosExecutionLog"("clientId", "scenarioType", "createdAt");
CREATE INDEX "ChaosExecutionLog_status_createdAt_idx" ON "ChaosExecutionLog"("status", "createdAt");
CREATE UNIQUE INDEX "AnalyticsRollup_clientId_rollupType_windowStart_windowEnd_key" ON "AnalyticsRollup"("clientId", "rollupType", "windowStart", "windowEnd");
CREATE INDEX "AnalyticsRollup_clientId_rollupType_updatedAt_idx" ON "AnalyticsRollup"("clientId", "rollupType", "updatedAt");

ALTER TABLE "EvaluationReproducibilityManifest" ADD CONSTRAINT "EvaluationReproducibilityManifest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvaluationReproducibilityManifest" ADD CONSTRAINT "EvaluationReproducibilityManifest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BehavioralEvaluationMetric" ADD CONSTRAINT "BehavioralEvaluationMetric_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BehavioralEvaluationMetric" ADD CONSTRAINT "BehavioralEvaluationMetric_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SloDefinition" ADD CONSTRAINT "SloDefinition_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SloIncident" ADD CONSTRAINT "SloIncident_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SloIncident" ADD CONSTRAINT "SloIncident_sloDefinitionId_fkey" FOREIGN KEY ("sloDefinitionId") REFERENCES "SloDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QueueFairnessMetric" ADD CONSTRAINT "QueueFairnessMetric_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChaosExecutionLog" ADD CONSTRAINT "ChaosExecutionLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalyticsRollup" ADD CONSTRAINT "AnalyticsRollup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
