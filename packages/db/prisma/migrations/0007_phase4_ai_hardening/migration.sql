CREATE TABLE "EmotionalTimeline" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "executionId" UUID,
  "state" JSONB NOT NULL,
  "drift" JSONB NOT NULL DEFAULT '{}',
  "stabilityScore" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmotionalTimeline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SemanticNormalization" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "rawText" TEXT NOT NULL,
  "normalized" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "conflicts" JSONB NOT NULL DEFAULT '[]',
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SemanticNormalization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemoryRetrievalLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "query" JSONB NOT NULL,
  "resultIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relevanceScores" JSONB NOT NULL DEFAULT '{}',
  "staleFiltered" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryRetrievalLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiSafetyViolation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "executionId" UUID,
  "violationType" VARCHAR(80) NOT NULL,
  "severity" VARCHAR(40) NOT NULL,
  "blockedText" TEXT,
  "score" DOUBLE PRECISION NOT NULL,
  "reasons" JSONB NOT NULL DEFAULT '[]',
  "quarantined" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiSafetyViolation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PredictionDrift" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "modelVersion" VARCHAR(80) NOT NULL,
  "previousVector" JSONB,
  "currentVector" JSONB NOT NULL,
  "driftScore" DOUBLE PRECISION NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PredictionDrift_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiExecutionRecovery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "executionId" UUID,
  "recoveryType" VARCHAR(80) NOT NULL,
  "status" VARCHAR(40) NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiExecutionRecovery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MultilingualNormalization" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "rawText" TEXT NOT NULL,
  "detectedLanguage" VARCHAR(40) NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "mappings" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MultilingualNormalization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiCostAllocation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "executionId" UUID,
  "taskType" "AiTaskType" NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "allocatedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "allocatedOutputTokens" INTEGER NOT NULL DEFAULT 0,
  "allocatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "allocationRatio" DOUBLE PRECISION NOT NULL,
  "retryAttempt" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiCostAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmotionalTimeline_clientId_observedAt_idx" ON "EmotionalTimeline"("clientId", "observedAt");
CREATE INDEX "EmotionalTimeline_leadId_observedAt_idx" ON "EmotionalTimeline"("leadId", "observedAt");
CREATE INDEX "SemanticNormalization_clientId_createdAt_idx" ON "SemanticNormalization"("clientId", "createdAt");
CREATE INDEX "SemanticNormalization_leadId_createdAt_idx" ON "SemanticNormalization"("leadId", "createdAt");
CREATE INDEX "MemoryRetrievalLog_clientId_createdAt_idx" ON "MemoryRetrievalLog"("clientId", "createdAt");
CREATE INDEX "MemoryRetrievalLog_leadId_createdAt_idx" ON "MemoryRetrievalLog"("leadId", "createdAt");
CREATE INDEX "AiSafetyViolation_clientId_violationType_createdAt_idx" ON "AiSafetyViolation"("clientId", "violationType", "createdAt");
CREATE INDEX "AiSafetyViolation_leadId_createdAt_idx" ON "AiSafetyViolation"("leadId", "createdAt");
CREATE INDEX "PredictionDrift_clientId_createdAt_idx" ON "PredictionDrift"("clientId", "createdAt");
CREATE INDEX "PredictionDrift_leadId_createdAt_idx" ON "PredictionDrift"("leadId", "createdAt");
CREATE INDEX "AiExecutionRecovery_clientId_status_createdAt_idx" ON "AiExecutionRecovery"("clientId", "status", "createdAt");
CREATE INDEX "AiExecutionRecovery_executionId_idx" ON "AiExecutionRecovery"("executionId");
CREATE INDEX "MultilingualNormalization_clientId_detectedLanguage_createdAt_idx" ON "MultilingualNormalization"("clientId", "detectedLanguage", "createdAt");
CREATE INDEX "MultilingualNormalization_leadId_createdAt_idx" ON "MultilingualNormalization"("leadId", "createdAt");
CREATE INDEX "AiCostAllocation_clientId_taskType_createdAt_idx" ON "AiCostAllocation"("clientId", "taskType", "createdAt");
CREATE INDEX "AiCostAllocation_executionId_idx" ON "AiCostAllocation"("executionId");

ALTER TABLE "EmotionalTimeline" ADD CONSTRAINT "EmotionalTimeline_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmotionalTimeline" ADD CONSTRAINT "EmotionalTimeline_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SemanticNormalization" ADD CONSTRAINT "SemanticNormalization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SemanticNormalization" ADD CONSTRAINT "SemanticNormalization_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryRetrievalLog" ADD CONSTRAINT "MemoryRetrievalLog_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryRetrievalLog" ADD CONSTRAINT "MemoryRetrievalLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSafetyViolation" ADD CONSTRAINT "AiSafetyViolation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSafetyViolation" ADD CONSTRAINT "AiSafetyViolation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PredictionDrift" ADD CONSTRAINT "PredictionDrift_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PredictionDrift" ADD CONSTRAINT "PredictionDrift_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiExecutionRecovery" ADD CONSTRAINT "AiExecutionRecovery_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiExecutionRecovery" ADD CONSTRAINT "AiExecutionRecovery_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiExecutionRecovery" ADD CONSTRAINT "AiExecutionRecovery_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "AiExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MultilingualNormalization" ADD CONSTRAINT "MultilingualNormalization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MultilingualNormalization" ADD CONSTRAINT "MultilingualNormalization_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiCostAllocation" ADD CONSTRAINT "AiCostAllocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiCostAllocation" ADD CONSTRAINT "AiCostAllocation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiCostAllocation" ADD CONSTRAINT "AiCostAllocation_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "AiExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
