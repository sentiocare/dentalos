import { createHash } from "node:crypto";
import { normalizePhone } from "@dentalos/shared";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";

export interface AuthUser {
  userId: string;
  phone: string | null;
  email: string | null;
}

export interface AuthConfig {
  jwksUrl?: string;
  jwtSecret?: string;
  issuer?: string;
  audience: string;
}

/**
 * Verifies Supabase Auth access tokens. Accepts asymmetric keys (JWKS, current Supabase default) and the
 * legacy shared secret. Only the user id, phone and email are taken from the token; clinic and role come
 * from our own membership table, never from the token.
 */
export function createTokenVerifier(config: AuthConfig) {
  const jwks = config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl)) : null;
  const secret = config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : null;

  return async function verify(token: string): Promise<AuthUser> {
    const options = { audience: config.audience, ...(config.issuer ? { issuer: config.issuer } : {}) };
    let payload: JWTPayload | undefined;
    let lastError: unknown;
    for (const key of [jwks, secret]) {
      if (!key) continue;
      try {
        payload = (
          key instanceof Uint8Array
            ? await jwtVerify(token, key, options)
            : await jwtVerify(token, key, options)
        ).payload;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload) throw lastError ?? new Error("No token verification method configured");
    if (typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub))
      throw new Error("Token has no user id");
    // Supabase stores phones without the "+".
    const rawPhone = typeof payload.phone === "string" && payload.phone ? payload.phone : null;
    const phone = rawPhone ? normalizePhone(rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`) : null;
    const email = typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : null;
    return { userId: payload.sub, phone, email };
  };
}

/** Deterministic user id for dev login, so the same phone always maps to the same account. */
export function devUserId(phone: string): string {
  const h = createHash("sha256").update(`dev-login:${phone}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Issues a Supabase-shaped token signed with the shared secret. Development and tests only. */
export async function signDevToken(
  secret: string,
  audience: string,
  user: { userId: string; phone: string },
) {
  return new SignJWT({ phone: user.phone.replace(/^\+/, ""), role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode(secret));
}
