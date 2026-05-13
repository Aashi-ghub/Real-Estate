export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TraceContext {
  requestId: string;
  correlationId: string;
}

export interface JobTrace extends TraceContext {
  source: "api" | "webhook" | "worker";
  enqueuedAt: string;
  parentQueue?: QueueName;
  parentJobId?: string;
}

export const clientStatuses = ["active", "paused"] as const;
export type ClientStatus = (typeof clientStatuses)[number];

export const whatsappProviders = ["twilio", "meta"] as const;
export type WhatsAppProvider = (typeof whatsappProviders)[number];

export const crmTypes = ["zoho", "hubspot", "custom"] as const;
export type CrmType = (typeof crmTypes)[number];

export const leadStatuses = [
  "new",
  "contacted",
  "qualified",
  "visit_booked",
  "closed",
  "lost"
] as const;
export type LeadStatus = (typeof leadStatuses)[number];

export const leadAttributeKeys = [
  "budget",
  "location",
  "timeline",
  "property_type",
  "purpose"
  ,
  "financing_needed"
] as const;
export type LeadAttributeKey = (typeof leadAttributeKeys)[number];

export const leadPriorities = ["HOT", "WARM", "COLD"] as const;
export type LeadPriority = (typeof leadPriorities)[number];

export const followUpTriggers = [
  "no_reply",
  "incomplete_qualification",
  "warm_lead_reengagement",
  "revisit_reminder"
] as const;
export type FollowUpTrigger = (typeof followUpTriggers)[number];

export const followUpStatuses = ["scheduled", "sent", "cancelled", "skipped", "failed"] as const;
export type FollowUpStatus = (typeof followUpStatuses)[number];

export const conversationChannels = ["whatsapp"] as const;
export type ConversationChannel = (typeof conversationChannels)[number];

export const conversationStates = [
  "INIT",
  "ASK_BUDGET",
  "ASK_LOCATION",
  "ASK_TIMELINE",
  "ASK_PURPOSE",
  "QUALIFIED"
] as const;
export type ConversationState = (typeof conversationStates)[number];

export const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];

export const messageStatuses = ["queued", "sent", "delivered", "failed"] as const;
export type MessageStatus = (typeof messageStatuses)[number];

export const jobStatuses = ["queued", "processing", "completed", "failed", "dead_letter"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const crmSyncStatuses = ["pending", "processing", "success", "failed"] as const;
export type CrmSyncStatus = (typeof crmSyncStatuses)[number];

export interface TwilioWhatsAppConfig {
  accountSid?: string;
  authTokenEncrypted?: string;
  fromNumber: string;
  webhookAuthTokenEncrypted?: string;
  agentNotificationPhone?: string;
  requestTimeoutMs?: number;
  statusCallbackUrl?: string;
}

export interface MetaWhatsAppConfig {
  accessTokenEncrypted: string;
  phoneNumberId: string;
  fromNumber: string;
  webhookSecretEncrypted: string;
  agentNotificationPhone?: string;
  requestTimeoutMs?: number;
  apiVersion?: string;
}

export type WhatsAppConfig = TwilioWhatsAppConfig | MetaWhatsAppConfig;

export interface GenericCrmConfig {
  endpoint: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  authType?: "none" | "bearer" | "api-key";
  apiKeyEncrypted?: string;
  apiKeyHeader?: string;
  fieldMap: Record<string, string>;
  timeoutMs?: number;
  externalIdPath?: string;
}

export interface ProviderCrmConfig extends Partial<GenericCrmConfig> {
  endpoint?: string;
  accessTokenEncrypted?: string;
  apiKeyEncrypted?: string;
  portalId?: string;
  module?: string;
  fieldMap: Record<string, string>;
  timeoutMs?: number;
  externalIdPath?: string;
}

export interface ClientRuntimeConfig {
  id: string;
  name: string;
  timezone: string;
  status: ClientStatus;
  whatsappProvider: WhatsAppProvider;
  whatsappConfig: WhatsAppConfig;
  crmType: CrmType;
  crmConfig: GenericCrmConfig;
}

export interface ConversationContext {
  [key: string]: JsonValue | undefined;
  introSentAt?: string;
  lastPromptState?: ConversationState;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  lastResponseLatencyMs?: number;
  responseCount?: number;
  qualifiedAt?: string;
  completionPercentage?: number;
  intentConfidence?: number;
  escalationReason?: string;
  timedOutAt?: string;
}

export interface ConversationSnapshot {
  id: string;
  leadId: string;
  state: ConversationState;
  context: ConversationContext | null;
  lastMessageAt: Date | null;
}

export interface LeadAttributeUpsert {
  key: LeadAttributeKey;
  value: JsonValue;
  rawValue?: string;
  confidence?: number;
  source?: string;
  metadata?: JsonObject;
}

export interface ParsedBudget {
  [key: string]: JsonValue | undefined;
  raw: string;
  min?: number;
  max?: number;
  currency?: string;
}

export interface ParsedTimeline {
  [key: string]: JsonValue | undefined;
  raw: string;
  days?: number;
  unit?: "day" | "week" | "month" | "year";
}

export interface ParsedAnswers {
  budget?: ParsedBudget;
  location?: string;
  timeline?: ParsedTimeline;
  property_type?: string;
  purpose?: string;
  financing_needed?: boolean;
}

export interface ExtractedLeadField {
  key: LeadAttributeKey;
  value: JsonValue;
  rawValue: string;
  confidence: number;
  source: "rule";
  metadata?: JsonObject;
}

export interface QualificationExtractionResult {
  fields: ExtractedLeadField[];
  parsedAnswers: ParsedAnswers;
  completenessPercentage: number;
  intentConfidence: number;
}

export interface AdvanceStateResult {
  nextState: ConversationState;
  attributesToUpsert: LeadAttributeUpsert[];
  outboundMessage: string | null;
  parsedAnswers: ParsedAnswers;
  completenessPercentage: number;
  intentConfidence: number;
  escalationReason?: string;
}

export const queueNames = {
  messages: "messages",
  followups: "followups",
  crm: "crm",
  messagesDlq: "messages-dlq",
  followupsDlq: "followups-dlq",
  crmDlq: "crm-dlq"
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export interface SendMessageJobData {
  clientId: string;
  leadId: string;
  conversationId: string;
  to: string;
  text: string;
  dedupeKey: string;
  reason: "intro" | "prompt" | "followup" | "qualification_ack" | "agent_notification";
  transitionAfterSend?: ConversationState;
  metadata?: JsonObject;
  trace?: JobTrace;
}

export interface FollowupNoReplyJobData {
  clientId: string;
  leadId: string;
  conversationId: string;
  to: string;
  dedupeKey: string;
  expectedState: Exclude<ConversationState, "INIT" | "QUALIFIED">;
  lastOutboundAt: string;
  trace?: JobTrace;
}

export interface CrmPushJobData {
  clientId: string;
  leadId: string;
  conversationId: string;
  dedupeKey: string;
  qualifiedAt: string;
  trace?: JobTrace;
}

export interface DeadLetterJobData {
  queue: QueueName;
  workerName: string;
  jobId: string;
  jobName: string;
  clientId?: string;
  leadId?: string;
  dedupeKey?: string;
  payload: JsonValue;
  error: {
    message: string;
    failedAt: string;
    attemptsMade: number;
    maxAttempts: number;
    willRetry: boolean;
    nextRetryDelayMs: number;
  };
  trace?: JobTrace;
}

export interface AuthenticatedApiKey {
  id: string;
  clientId: string;
  clientStatus: ClientStatus;
}

export interface NormalizedInboundMessage {
  clientId?: string;
  provider: WhatsAppProvider;
  providerMessageId: string;
  from: string;
  to: string;
  text: string;
  rawPayload: JsonValue;
}

export interface SendMessageResult {
  providerMessageId: string;
}

export interface CrmPushResult {
  externalId?: string;
  statusCode: number;
  responseBody?: JsonValue;
}
