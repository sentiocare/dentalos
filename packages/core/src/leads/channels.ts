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
  // Re-saving the same Page's token keeps its dataset connection.
  const prev = await pageCredentials(client, key);
  const credentials: PageCredentials =
    prev?.pageId === input.pageId && prev.datasetId
      ? { token: input.pageAccessToken.trim(), datasetId: prev.datasetId, datasetToken: prev.datasetToken }
      : { token: input.pageAccessToken.trim() };
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
        encryptSecret(key, JSON.stringify(credentials)),
      ],
    );
  } catch (error) {
    if (pgErrorCode(error) === "42501")
      throw new DomainError("conflict", "This Page is connected to another clinic");
    throw error;
  }
}

interface PageCredentials {
  token: string;
  /** Meta dataset (pixel) and its Conversions API token: lead outcomes are sent there. */
  datasetId?: string;
  datasetToken?: string;
}

async function pageCredentials(
  client: PoolClient,
  key: Buffer | null,
): Promise<(PageCredentials & { pageId: string }) | null> {
  const row = (
    await client.query(
      "select external_id, credentials_encrypted from clinic_channels where kind = 'meta_page' and active order by updated_at desc limit 1",
    )
  ).rows[0];
  if (!row?.credentials_encrypted || !key) return null;
  return {
    ...(JSON.parse(decryptSecret(key, row.credentials_encrypted)) as PageCredentials),
    pageId: row.external_id,
  };
}

export async function metaPageToken(client: PoolClient, key: Buffer | null): Promise<string | null> {
  return (await pageCredentials(client, key))?.token ?? null;
}

/** Where lead outcomes go (Conversions API), or null when the clinic hasn't connected a dataset. */
export async function metaDataset(client: PoolClient, key: Buffer | null) {
  const c = await pageCredentials(client, key);
  return c?.datasetId && c.datasetToken
    ? { pageId: c.pageId, datasetId: c.datasetId, accessToken: c.datasetToken }
    : null;
}

/**
 * Connects the clinic's Meta dataset (Events Manager → the dataset → Settings → Conversions API → generate an
 * access token). Needs the Page connected first; null removes it.
 */
export async function connectMetaDataset(
  client: PoolClient,
  key: Buffer,
  input: { datasetId: string; accessToken: string } | null,
) {
  const c = await pageCredentials(client, key);
  if (!c) throw new DomainError("invalid", "Connect the Facebook Page first");
  if (input && !/^\d{5,25}$/.test(input.datasetId))
    throw new DomainError("invalid", "The dataset ID is a number (from Meta Events Manager)");
  if (input && input.accessToken.trim().length < 20)
    throw new DomainError("invalid", "Paste the Conversions API access token");
  const next: PageCredentials = input
    ? { token: c.token, datasetId: input.datasetId, datasetToken: input.accessToken.trim() }
    : { token: c.token };
  await client.query(
    "update clinic_channels set credentials_encrypted = $2 where kind = 'meta_page' and external_id = $1 and active",
    [c.pageId, encryptSecret(key, JSON.stringify(next))],
  );
  // A new token gets another try at what failed with the old one (events up to 7 days old).
  if (input) await client.query("update lead_meta_events set attempts = 0 where status = 'failed'");
}

/**
 * Lead settings for the dashboard: the connected Page and dataset (never the tokens), who gets a WhatsApp
 * alert for hot leads, and how sending lead outcomes to Meta is going.
 */
export async function leadSettings(client: PoolClient, key: Buffer | null = null) {
  const page = (
    await client.query(
      "select external_id, display_phone from clinic_channels where kind = 'meta_page' and active limit 1",
    )
  ).rows[0];
  const s = (await client.query("select settings from clinics where id = app.current_clinic_id()")).rows[0]
    .settings;
  const signals = (
    await client.query(
      `select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
              max(sent_at) as last_sent_at, (array_agg(error order by created_at desc) filter (where status = 'failed'))[1] as last_error
       from lead_meta_events`,
    )
  ).rows[0];
  return {
    page: page ? { pageId: page.external_id as string, name: page.display_phone as string } : null,
    datasetId: (await metaDataset(client, key))?.datasetId ?? null,
    signals: {
      sent: signals.sent as number,
      failed: signals.failed as number,
      lastSentAt: (signals.last_sent_at as Date | null) ?? null,
      lastError: (signals.last_error as string | null) ?? null,
    },
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
