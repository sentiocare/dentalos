import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseSecretKey } from "./secrets";

describe("secret encryption", () => {
  const key = parseSecretKey(randomBytes(32).toString("base64"));

  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret(key, '{"accessToken":"EAAG"}');
    const b = encryptSecret(key, '{"accessToken":"EAAG"}');
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe('{"accessToken":"EAAG"}');
  });

  it("detects tampering and wrong keys", () => {
    const stored = encryptSecret(key, "secret");
    const parts = stored.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(key, parts.join(":"))).toThrow();
    expect(() => decryptSecret(parseSecretKey(randomBytes(32).toString("base64")), stored)).toThrow();
  });

  it("rejects short keys", () => {
    expect(() => parseSecretKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
