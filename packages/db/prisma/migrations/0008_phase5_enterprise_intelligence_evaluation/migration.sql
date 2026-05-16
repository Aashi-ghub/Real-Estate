CREATE TYPE "EvaluationRunStatus" AS ENUM ('queued', 'running', 'completed', 'failed');
CREATE TYPE "EvaluationDatasetType" AS ENUM ('semantic_extraction', 'emotional_inference', 'intent_prediction', 'multilingual_understanding', 'memory_retrieval', 'summarization', 'recommendation', 'behavioral_accuracy', 'hallucination_safety', 'retrieval_quality');
CREATE TYPE "FeedbackEventType" AS ENUM ('recommendation_accepted', 'recommendation_rejected', 'summary_corrected', 'prediction_corrected', 'extraction_corrected');
CREATE TYPE "BenchmarkSeverity" AS ENUM ('info', 'warn', 'critical');

CREATE TABLE "EvaluationDataset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "datasetType" "EvaluationDatasetType" NOT NULL,
  "version" VARCHAR(40) NOT NULL,
  "checksum" VARCHAR(128) NOT NULL,
  "examples" JSONB NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" VARCHAR(120),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationDataset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvaluationRun" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "datasetId" UUID,
  "runType" "EvaluationDatasetType" NOT NULL,
  "status" "EvaluationRunStatus" NOT NULL DEFAULT 'queued',
  "modelVersion" VARCHAR(120) NOT NULL,
  "promptVersion" VARCHAR(80),
  "baselineRunId" UUID,
  "inputChecksum" VARCHAR(128) NOT NULL,
  "resultChecksum" VARCHAR(128),
  "aggregateMetrics" JSONB NOT NULL DEFAULT '{}',
  "regressionSummary" JSONB NOT NULL DEFAULT '{}',
  "concurrencyLimit" INTEGER NOT NULL DEFAULT 1,
  "isolatedQueue" VARCHAR(64) NOT NULL DEFAULT 'evaluation',
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvaluationResult" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "datasetExampleId" VARCHAR(120) NOT NULL,
  "taskType" VARCHAR(80) NOT NULL,
  "expected" JSONB NOT NULL,
  "actual" JSONB NOT NULL,
  "scores" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "latencyMs" INTEGER NOT NULL DEFAULT 0,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RetrievalBenchmark" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "datasetId" UUID,
  "query" JSONB NOT NULL,
  "expectedMemoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "retrievedMemoryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relevanceScores" JSONB NOT NULL DEFAULT '{}',
  "rankingMetrics" JSONB NOT NULL DEFAULT '{}',
  "explainability" JSONB NOT NULL DEFAULT '{}',
  "confidence" DOUBLE PRECISION NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "staleFiltered" INTEGER NOT NULL DEFAULT 0,
  "model" VARCHAR(120) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetrievalBenchmark_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "actorId" VARCHAR(120),
  "eventType" "FeedbackEventType" NOT NULL,
  "targetType" VARCHAR(80) NOT NULL,
  "targetId" VARCHAR(120) NOT NULL,
  "originalValue" JSONB NOT NULL,
  "correctedValue" JSONB,
  "acceptanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "auditMetadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedbackEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DriftMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "metricType" VARCHAR(80) NOT NULL,
  "baselineVersion" VARCHAR(120) NOT NULL,
  "currentVersion" VARCHAR(120) NOT NULL,
  "baselineValue" JSONB NOT NULL,
  "currentValue" JSONB NOT NULL,
  "driftScore" DOUBLE PRECISION NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "anomaly" BOOLEAN NOT NULL DEFAULT false,
  "trend" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriftMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HallucinationScore" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "runId" UUID,
  "outputHash" VARCHAR(128) NOT NULL,
  "factualityScore" DOUBLE PRECISION NOT NULL,
  "hallucinationRate" DOUBLE PRECISION NOT NULL,
  "unsupportedClaims" JSONB NOT NULL DEFAULT '[]',
  "evidenceCoverage" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HallucinationScore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SafetyBenchmark" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "suiteName" VARCHAR(120) NOT NULL,
  "promptHash" VARCHAR(128) NOT NULL,
  "attackType" VARCHAR(80) NOT NULL,
  "blocked" BOOLEAN NOT NULL,
  "falseBlock" BOOLEAN NOT NULL DEFAULT false,
  "safetyScore" DOUBLE PRECISION NOT NULL,
  "severity" "BenchmarkSeverity" NOT NULL DEFAULT 'info',
  "reasons" JSONB NOT NULL DEFAULT '[]',
  "moderationVersion" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SafetyBenchmark_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CostForecast" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "forecastTokens" INTEGER NOT NULL,
  "forecastCostUsd" DECIMAL(12,6) NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "anomalyScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "recommendations" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostForecast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkerSaturationMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID,
  "queueName" VARCHAR(64) NOT NULL,
  "workerPool" VARCHAR(80) NOT NULL,
  "activeJobs" INTEGER NOT NULL,
  "waitingJobs" INTEGER NOT NULL,
  "delayedJobs" INTEGER NOT NULL,
  "failedJobs" INTEGER NOT NULL,
  "concurrency" INTEGER NOT NULL,
  "saturationScore" DOUBLE PRECISION NOT NULL,
  "starvationRisk" DOUBLE PRECISION NOT NULL,
  "adaptiveConcurrency" JSONB NOT NULL DEFAULT '{}',
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerSaturationMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntelligenceRegression" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "runId" UUID,
  "metricName" VARCHAR(120) NOT NULL,
  "baselineValue" DOUBLE PRECISION NOT NULL,
  "currentValue" DOUBLE PRECISION NOT NULL,
  "delta" DOUBLE PRECISION NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "severity" "BenchmarkSeverity" NOT NULL DEFAULT 'warn',
  "details" JSONB NOT NULL DEFAULT '{}',
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntelligenceRegression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvaluationDataset_clientId_datasetType_version_key" ON "EvaluationDataset"("clientId", "datasetType", "version");
CREATE UNIQUE INDEX "EvaluationResult_runId_datasetExampleId_taskType_key" ON "EvaluationResult"("runId", "datasetExampleId", "taskType");
CREATE INDEX "EvaluationDataset_clientId_datasetType_isActive_idx" ON "EvaluationDataset"("clientId", "datasetType", "isActive");
CREATE INDEX "EvaluationDataset_clientId_createdAt_idx" ON "EvaluationDataset"("clientId", "createdAt");
CREATE INDEX "EvaluationRun_clientId_runType_createdAt_idx" ON "EvaluationRun"("clientId", "runType", "createdAt");
CREATE INDEX "EvaluationRun_clientId_status_createdAt_idx" ON "EvaluationRun"("clientId", "status", "createdAt");
CREATE INDEX "EvaluationRun_datasetId_createdAt_idx" ON "EvaluationRun"("datasetId", "createdAt");
CREATE INDEX "EvaluationResult_clientId_taskType_createdAt_idx" ON "EvaluationResult"("clientId", "taskType", "createdAt");
CREATE INDEX "EvaluationResult_runId_passed_idx" ON "EvaluationResult"("runId", "passed");
CREATE INDEX "RetrievalBenchmark_clientId_createdAt_idx" ON "RetrievalBenchmark"("clientId", "createdAt");
CREATE INDEX "RetrievalBenchmark_leadId_createdAt_idx" ON "RetrievalBenchmark"("leadId", "createdAt");
CREATE INDEX "RetrievalBenchmark_datasetId_createdAt_idx" ON "RetrievalBenchmark"("datasetId", "createdAt");
CREATE INDEX "FeedbackEvent_clientId_eventType_createdAt_idx" ON "FeedbackEvent"("clientId", "eventType", "createdAt");
CREATE INDEX "FeedbackEvent_targetType_targetId_createdAt_idx" ON "FeedbackEvent"("targetType", "targetId", "createdAt");
CREATE INDEX "FeedbackEvent_leadId_createdAt_idx" ON "FeedbackEvent"("leadId", "createdAt");
CREATE INDEX "DriftMetric_clientId_metricType_createdAt_idx" ON "DriftMetric"("clientId", "metricType", "createdAt");
CREATE INDEX "DriftMetric_clientId_anomaly_createdAt_idx" ON "DriftMetric"("clientId", "anomaly", "createdAt");
CREATE INDEX "DriftMetric_leadId_createdAt_idx" ON "DriftMetric"("leadId", "createdAt");
CREATE INDEX "HallucinationScore_clientId_createdAt_idx" ON "HallucinationScore"("clientId", "createdAt");
CREATE INDEX "HallucinationScore_runId_createdAt_idx" ON "HallucinationScore"("runId", "createdAt");
CREATE INDEX "SafetyBenchmark_clientId_suiteName_createdAt_idx" ON "SafetyBenchmark"("clientId", "suiteName", "createdAt");
CREATE INDEX "SafetyBenchmark_clientId_attackType_createdAt_idx" ON "SafetyBenchmark"("clientId", "attackType", "createdAt");
CREATE INDEX "CostForecast_clientId_periodStart_periodEnd_idx" ON "CostForecast"("clientId", "periodStart", "periodEnd");
CREATE INDEX "CostForecast_clientId_provider_model_createdAt_idx" ON "CostForecast"("clientId", "provider", "model", "createdAt");
CREATE INDEX "WorkerSaturationMetric_queueName_observedAt_idx" ON "WorkerSaturationMetric"("queueName", "observedAt");
CREATE INDEX "WorkerSaturationMetric_clientId_observedAt_idx" ON "WorkerSaturationMetric"("clientId", "observedAt");
CREATE INDEX "IntelligenceRegression_clientId_metricName_createdAt_idx" ON "IntelligenceRegression"("clientId", "metricName", "createdAt");
CREATE INDEX "IntelligenceRegression_runId_createdAt_idx" ON "IntelligenceRegression"("runId", "createdAt");

ALTER TABLE "EvaluationDataset" ADD CONSTRAINT "EvaluationDataset_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvaluationDataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetrievalBenchmark" ADD CONSTRAINT "RetrievalBenchmark_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RetrievalBenchmark" ADD CONSTRAINT "RetrievalBenchmark_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FeedbackEvent" ADD CONSTRAINT "FeedbackEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FeedbackEvent" ADD CONSTRAINT "FeedbackEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DriftMetric" ADD CONSTRAINT "DriftMetric_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriftMetric" ADD CONSTRAINT "DriftMetric_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HallucinationScore" ADD CONSTRAINT "HallucinationScore_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HallucinationScore" ADD CONSTRAINT "HallucinationScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SafetyBenchmark" ADD CONSTRAINT "SafetyBenchmark_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SafetyBenchmark" ADD CONSTRAINT "SafetyBenchmark_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CostForecast" ADD CONSTRAINT "CostForecast_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkerSaturationMetric" ADD CONSTRAINT "WorkerSaturationMetric_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntelligenceRegression" ADD CONSTRAINT "IntelligenceRegression_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntelligenceRegression" ADD CONSTRAINT "IntelligenceRegression_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
