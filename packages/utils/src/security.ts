import crypto from "node:crypto";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashApiKey(apiKey: string, encryptionKeyHex: string): string {
  return crypto.createHmac("sha256", Buffer.from(encryptionKeyHex, "hex")).update(apiKey).digest("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function buildTenantIdempotencyKey(clientId: string, key: string): string {
  return `${clientId}:${key.trim()}`;
}

export function buildJobDedupeKey(parts: string[]): string {
  return sha256Hex(parts.join(":"));
}

export function encryptSecret(plainText: string, encryptionKeyHex: string): string {
  const key = Buffer.from(encryptionKeyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(encryptedValue: string, encryptionKeyHex: string): string {
  const [ivHex, tagHex, ciphertextHex] = encryptedValue.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) {
    throw new Error("Encrypted secret format is invalid");
  }

  const key = Buffer.from(encryptionKeyHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

export function verifyGenericWebhookHmac(rawBody: string, receivedSignature: string, secret: string): boolean {
  const normalizedSignature = receivedSignature.replace(/^sha256=/i, "");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(expected, normalizedSignature);
}
