CREATE TYPE "AiExecutionStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'timed_out', 'fallback');
CREATE TYPE "AiTaskType" AS ENUM ('semantic_understanding', 'behavioral_intelligence', 'buyer_intent_prediction', 'conversational_memory', 'multilingual_reasoning', 'engagement_prediction', 'conversation_summary', 'followup_optimization', 'sales_assist', 'analytics_intelligence');
CREATE TYPE "AiProvider" AS ENUM ('deterministic', 'openai');
CREATE TYPE "AiRecommendationStatus" AS ENUM ('proposed', 'accepted', 'rejected', 'expired');

CREATE TABLE "PromptVersion" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "taskType" "AiTaskType" NOT NULL,
  "version" VARCHAR(40) NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "systemPrompt" TEXT NOT NULL,
  "outputSchema" JSONB NOT NULL,
  "checksum" VARCHAR(128) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiExecution" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID,
  "conversationId" UUID,
  "taskType" "AiTaskType" NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "promptVersionId" UUID,
  "status" "AiExecutionStatus" NOT NULL DEFAULT 'queued',
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "inputHash" VARCHAR(128) NOT NULL,
  "output" JSONB,
  "reasoning" JSONB NOT NULL DEFAULT '{}',
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "safety" JSONB NOT NULL DEFAULT '{}',
  "tokenUsage" JSONB NOT NULL DEFAULT '{}',
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "latencyMs" INTEGER,
  "requestId" VARCHAR(128),
  "correlationId" VARCHAR(128),
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BehavioralSignal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "signalType" VARCHAR(80) NOT NULL,
  "value" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "source" VARCHAR(40) NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BehavioralSignal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmotionalProfile" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "state" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "trend" JSONB NOT NULL DEFAULT '{}',
  "frictionIndicators" JSONB NOT NULL DEFAULT '[]',
  "salesResistanceMarkers" JSONB NOT NULL DEFAULT '[]',
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "source" VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmotionalProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntentPrediction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "modelVersion" VARCHAR(80) NOT NULL,
  "predictions" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "featureContributions" JSONB NOT NULL DEFAULT '{}',
  "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntentPrediction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationalMemory" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "memoryType" VARCHAR(80) NOT NULL,
  "content" JSONB NOT NULL,
  "rawUtterance" TEXT,
  "relevanceScore" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source" VARCHAR(40) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationalMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiSummary" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "conversationId" UUID,
  "summaryType" VARCHAR(80) NOT NULL,
  "version" VARCHAR(40) NOT NULL,
  "content" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "promptVersionId" UUID,
  "model" VARCHAR(120) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiSummary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiRecommendation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "recommendationType" VARCHAR(80) NOT NULL,
  "status" "AiRecommendationStatus" NOT NULL DEFAULT 'proposed',
  "suggestion" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "safety" JSONB NOT NULL DEFAULT '{}',
  "promptVersionId" UUID,
  "acceptedAt" TIMESTAMP(3),
  "effectiveness" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SemanticEmbedding" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "entityType" VARCHAR(80) NOT NULL,
  "entityId" VARCHAR(120) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "vector" JSONB NOT NULL,
  "contentHash" VARCHAR(128) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SemanticEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EngagementPrediction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "bestFollowupAt" TIMESTAMP(3),
  "bestChannel" VARCHAR(40),
  "escalationRiskScore" DOUBLE PRECISION NOT NULL,
  "inactivityRisk" DOUBLE PRECISION NOT NULL,
  "churnRisk" DOUBLE PRECISION NOT NULL,
  "timingConfidence" DOUBLE PRECISION NOT NULL,
  "strategy" JSONB NOT NULL,
  "explanation" JSONB NOT NULL DEFAULT '{}',
  "thresholds" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngagementPrediction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiCostMetric" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientId" UUID NOT NULL,
  "taskType" "AiTaskType" NOT NULL,
  "provider" "AiProvider" NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
  "latencyMs" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiCostMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromptVersion_taskType_version_key" ON "PromptVersion"("taskType", "version");
CREATE INDEX "PromptVersion_taskType_isActive_idx" ON "PromptVersion"("taskType", "isActive");
CREATE INDEX "AiExecution_clientId_taskType_createdAt_idx" ON "AiExecution"("clientId", "taskType", "createdAt");
CREATE INDEX "AiExecution_leadId_taskType_createdAt_idx" ON "AiExecution"("leadId", "taskType", "createdAt");
CREATE INDEX "AiExecution_requestId_correlationId_idx" ON "AiExecution"("requestId", "correlationId");
CREATE INDEX "BehavioralSignal_clientId_signalType_observedAt_idx" ON "BehavioralSignal"("clientId", "signalType", "observedAt");
CREATE INDEX "BehavioralSignal_leadId_observedAt_idx" ON "BehavioralSignal"("leadId", "observedAt");
CREATE INDEX "EmotionalProfile_clientId_createdAt_idx" ON "EmotionalProfile"("clientId", "createdAt");
CREATE INDEX "EmotionalProfile_leadId_createdAt_idx" ON "EmotionalProfile"("leadId", "createdAt");
CREATE INDEX "IntentPrediction_clientId_createdAt_idx" ON "IntentPrediction"("clientId", "createdAt");
CREATE INDEX "IntentPrediction_leadId_createdAt_idx" ON "IntentPrediction"("leadId", "createdAt");
CREATE INDEX "ConversationalMemory_clientId_memoryType_relevanceScore_idx" ON "ConversationalMemory"("clientId", "memoryType", "relevanceScore");
CREATE INDEX "ConversationalMemory_leadId_memoryType_updatedAt_idx" ON "ConversationalMemory"("leadId", "memoryType", "updatedAt");
CREATE INDEX "AiSummary_clientId_summaryType_createdAt_idx" ON "AiSummary"("clientId", "summaryType", "createdAt");
CREATE INDEX "AiSummary_leadId_summaryType_createdAt_idx" ON "AiSummary"("leadId", "summaryType", "createdAt");
CREATE INDEX "AiRecommendation_clientId_status_createdAt_idx" ON "AiRecommendation"("clientId", "status", "createdAt");
CREATE INDEX "AiRecommendation_leadId_recommendationType_createdAt_idx" ON "AiRecommendation"("leadId", "recommendationType", "createdAt");
CREATE UNIQUE INDEX "SemanticEmbedding_clientId_entityType_entityId_model_contentHash_key" ON "SemanticEmbedding"("clientId", "entityType", "entityId", "model", "contentHash");
CREATE INDEX "SemanticEmbedding_leadId_entityType_idx" ON "SemanticEmbedding"("leadId", "entityType");
CREATE INDEX "EngagementPrediction_clientId_createdAt_idx" ON "EngagementPrediction"("clientId", "createdAt");
CREATE INDEX "EngagementPrediction_leadId_createdAt_idx" ON "EngagementPrediction"("leadId", "createdAt");
CREATE INDEX "AiCostMetric_clientId_taskType_createdAt_idx" ON "AiCostMetric"("clientId", "taskType", "createdAt");
CREATE INDEX "AiCostMetric_provider_model_createdAt_idx" ON "AiCostMetric"("provider", "model", "createdAt");

ALTER TABLE "AiExecution" ADD CONSTRAINT "AiExecution_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiExecution" ADD CONSTRAINT "AiExecution_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BehavioralSignal" ADD CONSTRAINT "BehavioralSignal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BehavioralSignal" ADD CONSTRAINT "BehavioralSignal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmotionalProfile" ADD CONSTRAINT "EmotionalProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmotionalProfile" ADD CONSTRAINT "EmotionalProfile_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntentPrediction" ADD CONSTRAINT "IntentPrediction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntentPrediction" ADD CONSTRAINT "IntentPrediction_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationalMemory" ADD CONSTRAINT "ConversationalMemory_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationalMemory" ADD CONSTRAINT "ConversationalMemory_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSummary" ADD CONSTRAINT "AiSummary_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSummary" ADD CONSTRAINT "AiSummary_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSummary" ADD CONSTRAINT "AiSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiSummary" ADD CONSTRAINT "AiSummary_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SemanticEmbedding" ADD CONSTRAINT "SemanticEmbedding_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SemanticEmbedding" ADD CONSTRAINT "SemanticEmbedding_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementPrediction" ADD CONSTRAINT "EngagementPrediction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementPrediction" ADD CONSTRAINT "EngagementPrediction_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
