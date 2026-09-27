import { decryptSecret, encryptSecret, normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { DomainError, pgErrorCode } from "../errors";

/**
 * The clinic's Facebook Page, for lead-form webhooks. The Page access token (long-lived, with
 * leads_retrieval) is stored encrypted; one Page belongs to one clinic.
 */
export async function connectMetaPage(
  client: PoolClient,
  key: Buffer,
  input: { pageId: string; pageName?: string | null; pageAccessToken: string },
) {
  if (!/^\d{5,25}$/.test(input.pageId))
    throw new DomainError("invalid", "The Page ID is a number (from Meta)");
  if (input.pageAccessToken.trim().length < 20)
    throw new DomainError("invalid", "Paste the Page access token");
  await client.query(
    "update clinic_channels set active = false where kind = 'meta_page' and external_id <> $1",
    [input.pageId],
  );
  try {
    await client.query(
      `insert into clinic_channels (clinic_id, kind, external_id, display_phone, credentials_encrypted, active)
       values (app.current_clinic_id(), 'meta_page', $1, $2, $3, true)
       on conflict (kind, external_id) do update
         set display_phone = excluded.display_phone, credentials_encrypted = excluded.credentials_encrypted, active = true`,
      [
        input.pageId,
        input.pageName?.slice(0, 100) || input.pageId,
        encryptSecret(key, JSON.stringify({ token: input.pageAccessToken.trim() })),
      ],
    );
  } catch (error) {
    if (pgErrorCode(error) === "42501")
      throw new DomainError("conflict", "This Page is connected to another clinic");
    throw error;
  }
}

export async function metaPageToken(client: PoolClient, key: Buffer | null): Promise<string | null> {
  const row = (
    await client.query(
      "select credentials_encrypted from clinic_channels where kind = 'meta_page' and active order by updated_at desc limit 1",
    )
  ).rows[0];
  if (!row?.credentials_encrypted || !key) return null;
  return (JSON.parse(decryptSecret(key, row.credentials_encrypted)) as { token: string }).token;
}

/** Lead settings for the dashboard: the connected Page, and who gets a WhatsApp alert for hot leads. */
export async function leadSettings(client: PoolClient) {
  const page = (
    await client.query(
      "select external_id, display_phone from clinic_channels where kind = 'meta_page' and active limit 1",
    )
  ).rows[0];
  const s = (await client.query("select settings from clinics where id = app.current_clinic_id()")).rows[0]
    .settings;
  return {
    page: page ? { pageId: page.external_id as string, name: page.display_phone as string } : null,
    alertPhone: (s?.leads?.alertPhone as string | undefined) ?? null,
  };
}

export async function saveLeadAlertPhone(client: PoolClient, phone: string | null) {
  const p = phone ? normalizePhone(phone) : null;
  if (phone && !p) throw new DomainError("invalid", "The phone number is not valid");
  await client.query(
    `update clinics set settings = jsonb_set(settings, '{leads}', coalesce(settings->'leads', '{}'::jsonb) || jsonb_build_object('alertPhone', $1::text))
     where id = app.current_clinic_id()`,
    [p],
  );
}
