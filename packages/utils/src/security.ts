import crypto from "node:crypto";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hashApiKey(apiKey: string, encryptionKeyHex: string): string {
  return crypto.createHmac("sha256", Buffer.from(encryptionKeyHex, "hex")).update(apiKey).digest("hex");
}

export function generateApiKey(): { plaintext: string; prefix: string } {
  const prefix = `rea_${crypto.randomBytes(6).toString("base64url")}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  return {
    prefix,
    plaintext: `${prefix}.${secret}`
  };
}

export function getApiKeyPrefix(apiKey: string): string | null {
  const [prefix, secret] = apiKey.trim().split(".");
  if (!prefix || !secret || !prefix.startsWith("rea_")) {
    return null;
  }

  return prefix;
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

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export interface JwtPayload {
  sub: string;
  clientId?: string | null;
  roles: string[];
  permissions: string[];
  sessionId?: string;
  iat?: number;
  exp?: number;
}

export function signJwt(payload: JwtPayload, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1_000);
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds
  };
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${encodedPayload}`)
    .digest("base64url");

  return `${header}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error("Invalid token");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");

  if (!timingSafeEqual(expected, signature)) {
    throw new Error("Invalid token signature");
  }

  const decoded = JSON.parse(base64UrlDecode(payload).toString("utf8")) as JwtPayload;
  if (!decoded.exp || decoded.exp <= Math.floor(Date.now() / 1_000)) {
    throw new Error("Token expired");
  }

  return decoded;
}

export function hashRefreshToken(token: string, encryptionKeyHex: string): string {
  return crypto.createHmac("sha256", Buffer.from(encryptionKeyHex, "hex")).update(`refresh:${token}`).digest("hex");
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

function pbkdf2Async(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, "sha256", (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string, encryptionKeyHex: string, salt = crypto.randomBytes(16).toString("hex")): Promise<string> {
  const pepper = Buffer.from(encryptionKeyHex, "hex");
  const derived = await pbkdf2Async(password, Buffer.concat([Buffer.from(salt, "hex"), pepper]), 120_000);
  return `pbkdf2_sha256$120000$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string, encryptionKeyHex: string): Promise<boolean> {
  const [algorithm, iterations, salt, digest] = storedHash.split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterations || !salt || !digest) {
    return false;
  }

  const pepper = Buffer.from(encryptionKeyHex, "hex");
  const derived = await pbkdf2Async(password, Buffer.concat([Buffer.from(salt, "hex"), pepper]), Number(iterations));
  return timingSafeEqual(derived.toString("hex"), digest);
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
