import type { MessagingChannel } from "@dentalos/adapters";
import { decryptSecret, encryptSecret, normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { DomainError, pgErrorCode } from "../errors";

/** Connects (or replaces) the clinic's WhatsApp Business number. The token is stored encrypted. */
export async function connectWhatsApp(
  client: PoolClient,
  key: Buffer,
  input: { phoneNumberId: string; displayPhone: string; accessToken: string },
): Promise<string> {
  const display = normalizePhone(input.displayPhone);
  if (!display) throw new DomainError("invalid", "WhatsApp number is not valid");
  if (!/^\d{6,20}$/.test(input.phoneNumberId))
    throw new DomainError("invalid", "Phone number ID should be digits (from Meta)");
  await client.query(
    "update clinic_channels set active = false where kind = 'whatsapp' and external_id <> $1",
    [input.phoneNumberId],
  );
  try {
    const { rows } = await client.query(
      `insert into clinic_channels (clinic_id, kind, external_id, display_phone, credentials_encrypted, active)
       values (app.current_clinic_id(), 'whatsapp', $1, $2, $3, true)
       on conflict (kind, external_id) do update
         set display_phone = excluded.display_phone, credentials_encrypted = excluded.credentials_encrypted, active = true
       returning id`,
      [input.phoneNumberId, display, encryptSecret(key, JSON.stringify({ accessToken: input.accessToken }))],
    );
    if (!rows[0]) throw new DomainError("conflict", "This WhatsApp number is connected to another clinic");
    return rows[0].id;
  } catch (error) {
    // The upsert's row belongs to another clinic: RLS turns the update into a violation.
    if (pgErrorCode(error) === "42501")
      throw new DomainError("conflict", "This WhatsApp number is connected to another clinic");
    throw error;
  }
}

export async function getWhatsAppChannel(client: PoolClient, key: Buffer): Promise<MessagingChannel | null> {
  const { rows } = await client.query(
    "select external_id, credentials_encrypted from clinic_channels where kind = 'whatsapp' and active order by updated_at desc limit 1",
  );
  const row = rows[0];
  if (!row?.credentials_encrypted) return null;
  const { accessToken } = JSON.parse(decryptSecret(key, row.credentials_encrypted)) as {
    accessToken: string;
  };
  return { channelId: row.external_id, accessToken };
}

export async function whatsAppStatus(client: PoolClient) {
  const { rows } = await client.query(
    "select external_id, display_phone, active, updated_at from clinic_channels where kind = 'whatsapp' and active limit 1",
  );
  return rows[0]
    ? { connected: true, phoneNumberId: rows[0].external_id, displayPhone: rows[0].display_phone }
    : { connected: false };
}
