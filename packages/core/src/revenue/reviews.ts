import type { PoolClient } from "pg";
import { DomainError } from "../errors";

/**
 * Google reviews. After a visit every patient is asked once how it went (never more than once in 6 months).
 * "Good" → thanks and the clinic's Google review link. "Could be better" → an apology, the doctor is told
 * (a high-priority task) and will call; the link is still shown, because Google's policy forbids asking only
 * happy customers for reviews ("review gating"), and a clinic caught doing it can lose its reviews.
 */
export const REVIEW_DEFAULTS = {
  /** Hours after the visit ends; visits with an after-care check-in wait two days instead. */
  afterHours: 2,
  afterCareHours: 48,
  /** A patient is asked at most once in this many days. */
  everyDays: 180,
};

export interface ReviewSettings {
  enabled: boolean;
  link: string | null;
}

export function reviewSettingsOf(
  settings: { reviews?: Partial<ReviewSettings> } | null | undefined,
): ReviewSettings {
  const r = settings?.reviews ?? {};
  return { enabled: r.enabled === true && Boolean(r.link), link: r.link ?? null };
}

export async function reviewSettings(client: PoolClient): Promise<ReviewSettings> {
  const s = (await client.query("select settings from clinics where id = app.current_clinic_id()")).rows[0]
    .settings;
  return reviewSettingsOf(s);
}

/** Only a Google link: the review page of the clinic's Business Profile (g.page, maps or search). */
export async function saveReviewSettings(
  client: PoolClient,
  input: { enabled: boolean; link: string | null },
) {
  const link = input.link?.trim() || null;
  if (link) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new DomainError("invalid", "Paste the full review link, starting with https://");
    }
    if (
      url.protocol !== "https:" ||
      !/(^|\.)(g\.page|google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/i.test(url.hostname)
    )
      throw new DomainError("invalid", "Use the review link from the clinic's Google Business Profile");
  }
  if (input.enabled && !link) throw new DomainError("invalid", "Add the Google review link first");
  await client.query(
    "update clinics set settings = jsonb_set(settings, '{reviews}', $1::jsonb) where id = app.current_clinic_id()",
    [JSON.stringify({ enabled: input.enabled, link })],
  );
  return reviewSettings(client);
}

/** The patient's answer to "how was your visit?" (a second tap replaces the first). */
export async function recordVisitFeedback(
  client: PoolClient,
  input: { appointmentId: string; patientId: string; rating: "good" | "bad" },
) {
  await client.query(
    `insert into visit_feedback (clinic_id, appointment_id, patient_id, rating)
     values (app.current_clinic_id(), $1, $2, $3)
     on conflict (clinic_id, appointment_id) do update set rating = excluded.rating`,
    [input.appointmentId, input.patientId, input.rating],
  );
}

/** For the owner's report: how many were asked, and how many said good or could be better. */
export async function reviewStats(client: PoolClient, input: { from: Date; to: Date }) {
  const asked = (
    await client.query(
      `select count(*)::int as n from followup_actions a join followup_runs r on r.id = a.run_id
       where r.kind = 'review' and a.action = 'whatsapp' and a.result = 'queued' and a.at >= $1 and a.at < $2`,
      [input.from, input.to],
    )
  ).rows[0].n as number;
  const f = (
    await client.query(
      `select count(*) filter (where rating = 'good')::int as good, count(*) filter (where rating = 'bad')::int as bad
       from visit_feedback where created_at >= $1 and created_at < $2`,
      [input.from, input.to],
    )
  ).rows[0];
  return { asked, good: f.good as number, bad: f.bad as number };
}
