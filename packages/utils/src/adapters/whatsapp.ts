import crypto from "node:crypto";

import { z } from "zod";

import type {
  ClientRuntimeConfig,
  JsonObject,
  JsonValue,
  NormalizedInboundMessage,
  SendMessageResult,
  TwilioWhatsAppConfig,
  WhatsAppConfig,
  WhatsAppProvider
} from "@real-estate/types";

import { ExternalServiceError } from "../errors";
import { decryptSecret, timingSafeEqual, verifyGenericWebhookHmac } from "../security";
import { normalizePhoneE164, sanitizeFreeText, sanitizeJsonValue } from "../sanitization";

const twilioConfigSchema = z.object({
  accountSid: z.string().optional(),
  authTokenEncrypted: z.string().optional(),
  fromNumber: z.string().min(1),
  webhookAuthTokenEncrypted: z.string().optional(),
  agentNotificationPhone: z.string().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  statusCallbackUrl: z.string().url().optional()
});

const metaConfigSchema = z.object({
  accessTokenEncrypted: z.string(),
  phoneNumberId: z.string(),
  fromNumber: z.string().min(1),
  webhookSecretEncrypted: z.string(),
  agentNotificationPhone: z.string().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  apiVersion: z.string().optional()
});

function prefixWhatsApp(phone: string): string {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}

export function parseWhatsAppConfig(provider: WhatsAppProvider, rawConfig: JsonValue): WhatsAppConfig {
  if (provider === "twilio") {
    return twilioConfigSchema.parse(rawConfig) as TwilioWhatsAppConfig;
  }

  return metaConfigSchema.parse(rawConfig);
}

export async function sendMessage(args: {
  client: ClientRuntimeConfig;
  to: string;
  text: string;
  encryptionKey: string;
  dryRun?: boolean;
  fallbackTwilioAccountSid?: string;
  fallbackTwilioAuthToken?: string;
  fallbackTwilioFrom?: string;
}): Promise<SendMessageResult> {
  if (args.dryRun) {
    const digest = crypto
      .createHash("sha256")
      .update(`${args.client.id}:${args.to}:${args.text}`)
      .digest("hex")
      .slice(0, 32);
    return { providerMessageId: `dryrun_${digest}` };
  }

  if (args.client.whatsappProvider === "twilio") {
    return sendTwilioMessage(args);
  }

  return sendMetaMessage(args);
}

async function sendTwilioMessage(args: {
  client: ClientRuntimeConfig;
  to: string;
  text: string;
  encryptionKey: string;
  fallbackTwilioAccountSid?: string;
  fallbackTwilioAuthToken?: string;
  fallbackTwilioFrom?: string;
}): Promise<SendMessageResult> {
  const config = twilioConfigSchema.parse(args.client.whatsappConfig);
  const accountSid = config.accountSid ?? args.fallbackTwilioAccountSid;
  const authToken = config.authTokenEncrypted
    ? decryptSecret(config.authTokenEncrypted, args.encryptionKey)
    : args.fallbackTwilioAuthToken;
  const fromNumber = config.fromNumber || args.fallbackTwilioFrom;

  if (!accountSid || !authToken || !fromNumber) {
    throw new ExternalServiceError(`Twilio config is incomplete for client ${args.client.id}`, {
      retryable: false
    });
  }

  const body = new URLSearchParams({
    To: prefixWhatsApp(normalizePhoneE164(args.to)),
    From: prefixWhatsApp(fromNumber.replace(/^whatsapp:/i, "")),
    Body: sanitizeFreeText(args.text, 1_600)
  });

  if (config.statusCallbackUrl) {
    body.set("StatusCallback", config.statusCallbackUrl);
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5_000)
  });

  const json = (await response.json().catch(() => null)) as JsonObject | null;
  if (!response.ok) {
    throw new ExternalServiceError("Twilio message send failed", {
      retryable: response.status >= 500 || response.status === 429,
      statusCode: response.status,
      responseBody: json
    });
  }

  const sid = typeof json?.sid === "string" ? json.sid : null;
  if (!sid) {
    throw new ExternalServiceError("Twilio response missing sid", {
      retryable: true,
      statusCode: response.status,
      responseBody: json
    });
  }

  return { providerMessageId: sid };
}

async function sendMetaMessage(args: {
  client: ClientRuntimeConfig;
  to: string;
  text: string;
  encryptionKey: string;
}): Promise<SendMessageResult> {
  const config = metaConfigSchema.parse(args.client.whatsappConfig);
  const accessToken = decryptSecret(config.accessTokenEncrypted, args.encryptionKey);
  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion ?? "v22.0"}/${config.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: normalizePhoneE164(args.to).replace(/^\+/, ""),
        type: "text",
        text: {
          body: sanitizeFreeText(args.text, 1_600)
        }
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5_000)
    }
  );

  const json = (await response.json().catch(() => null)) as JsonObject | null;
  if (!response.ok) {
    throw new ExternalServiceError("Meta WhatsApp message send failed", {
      retryable: response.status >= 500 || response.status === 429,
      statusCode: response.status,
      responseBody: json
    });
  }

  const messageId = Array.isArray(json?.messages) ? json.messages[0] : null;
  if (!messageId || typeof (messageId as JsonObject).id !== "string") {
    throw new ExternalServiceError("Meta response missing message id", {
      retryable: true,
      statusCode: response.status,
      responseBody: json
    });
  }

  return { providerMessageId: (messageId as JsonObject).id as string };
}

function computeTwilioSignature(url: string, body: Record<string, unknown>, authToken: string): string {
  const payload = Object.keys(body)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${String(body[key] ?? "")}`, url);

  return crypto.createHmac("sha1", authToken).update(payload).digest("base64");
}

export function verifyWebhookSignature(args: {
  provider: WhatsAppProvider;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  requestUrl: string;
  parsedBody: Record<string, unknown>;
  config: WhatsAppConfig;
  encryptionKey: string;
  fallbackTwilioAuthToken?: string;
}): boolean {
  if (args.provider === "twilio") {
    const signature = typeof args.headers["x-twilio-signature"] === "string"
      ? args.headers["x-twilio-signature"]
      : "";
    const twilioConfig = twilioConfigSchema.parse(args.config);
    const authToken = twilioConfig.webhookAuthTokenEncrypted
      ? decryptSecret(twilioConfig.webhookAuthTokenEncrypted, args.encryptionKey)
      : twilioConfig.authTokenEncrypted
        ? decryptSecret(twilioConfig.authTokenEncrypted, args.encryptionKey)
        : args.fallbackTwilioAuthToken;

    if (!signature || !authToken) {
      return false;
    }

    const expected = computeTwilioSignature(args.requestUrl, args.parsedBody, authToken);
    return timingSafeEqual(expected, signature);
  }

  const signature = typeof args.headers["x-hub-signature-256"] === "string"
    ? args.headers["x-hub-signature-256"]
    : "";
  const metaConfig = metaConfigSchema.parse(args.config);
  const secret = decryptSecret(metaConfig.webhookSecretEncrypted, args.encryptionKey);
  return signature ? verifyGenericWebhookHmac(args.rawBody, signature, secret) : false;
}

export function normalizeInboundMessage(args: {
  provider: WhatsAppProvider;
  body: Record<string, unknown>;
}): NormalizedInboundMessage {
  if (args.provider === "twilio") {
    const providerMessageId = sanitizeFreeText(String(args.body.MessageSid ?? ""), 120);
    const from = normalizePhoneE164(String(args.body.From ?? "").replace(/^whatsapp:/i, ""));
    const to = normalizePhoneE164(String(args.body.To ?? "").replace(/^whatsapp:/i, ""));
    const text = sanitizeFreeText(args.body.Body, 1_600);

    if (!providerMessageId || !text) {
      throw new Error("Twilio payload is missing MessageSid or Body");
    }

    return {
      provider: "twilio",
      providerMessageId,
      from,
      to,
      text,
      rawPayload: sanitizeJsonValue(args.body),
      ...(typeof args.body.client_id === "string"
        ? { clientId: sanitizeFreeText(args.body.client_id, 64) }
        : {})
    };
  }

  const entry = Array.isArray(args.body.entry) ? args.body.entry[0] : undefined;
  const changes = entry && typeof entry === "object" && Array.isArray((entry as JsonObject).changes)
    ? ((entry as JsonObject).changes as unknown[])
    : [];
  const value = (changes[0] as JsonObject | undefined);
  const valuePayload = value?.value as JsonObject | undefined;
  const messages = Array.isArray(valuePayload?.messages) ? (valuePayload.messages as unknown[]) : [];
  const contacts = Array.isArray(valuePayload?.contacts) ? (valuePayload.contacts as unknown[]) : [];
  const message = messages[0] as JsonObject | undefined;
  const metadata = (value?.value as JsonObject | undefined)?.metadata as JsonObject | undefined;
  const contact = contacts[0] as JsonObject | undefined;
  const providerMessageId = sanitizeFreeText(String(message?.id ?? ""), 120);
  const from = normalizePhoneE164(`+${String(message?.from ?? "")}`);
  const to = normalizePhoneE164(`+${String(metadata?.display_phone_number ?? "").replace(/\D/g, "")}`);
  const text = sanitizeFreeText(String((message?.text as JsonObject | undefined)?.body ?? ""), 1_600);

  if (!providerMessageId || !text) {
    throw new Error("Meta payload is missing message id or text body");
  }

  return {
    provider: "meta",
    providerMessageId,
    from,
    to,
    text,
    rawPayload: sanitizeJsonValue({
      ...args.body,
      contact_name: contact?.profile && typeof (contact.profile as JsonObject).name === "string"
        ? (contact.profile as JsonObject).name
        : null
    }),
    ...(typeof (args.body.client_id as string | undefined) === "string"
      ? { clientId: sanitizeFreeText(args.body.client_id, 64) }
      : {})
  };
}
