import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts provider credentials (e.g. a clinic's WhatsApp access token) before they are stored in the
 * database. AES-256-GCM with a 32-byte key from the environment (CHANNEL_SECRET_KEY, base64).
 * Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 */
export function parseSecretKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32)
    throw new Error("CHANNEL_SECRET_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(
    ":",
  );
}

export function decryptSecret(key: Buffer, stored: string): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
