import { localDateOf, localMinutesOf, weekdayOf } from "@dentalos/core";
import { withAppRole, withClinic, type Pool } from "@dentalos/db";

/**
 * What to do with an incoming call, decided when the telephony provider first asks (Build Prompt §5.1):
 * answer with the assistant, or ring the clinic's own phone. The clinic's phone is the fallback for
 * anything unusual, so a patient's call is never lost:
 * - the assistant is switched off for the clinic;
 * - "after hours only" mode while the clinic is open;
 * - the voice service has not reported healthy in the last minute.
 */
export type CallRoute = "assistant" | "forwarded_hours" | "forwarded_disabled" | "forwarded_unhealthy";

export interface VoiceSettings {
  enabled: boolean;
  /** "all": the assistant answers every call that reaches it (use with operator forwarding on
   *  no-answer/busy for "after N rings"); "after_hours": only outside working hours. */
  answerMode: "all" | "after_hours";
  /** Numbers staff transfers ring, in order; the clinic phone is always tried last. */
  staffPhones: string[];
}

export function voiceSettings(settings: Record<string, unknown> | null | undefined): VoiceSettings {
  const v = (settings?.voice ?? {}) as Partial<VoiceSettings>;
  return {
    enabled: v.enabled ?? true,
    answerMode: v.answerMode === "after_hours" ? "after_hours" : "all",
    staffPhones: Array.isArray(v.staffPhones) ? v.staffPhones.filter((x) => typeof x === "string") : [],
  };
}

export const VOICE_HEARTBEAT_MAX_AGE_SEC = 60;

export async function voiceServiceHealthy(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    "select extract(epoch from now() - beat_at)::float8 as age from service_heartbeats where service = 'voice'",
  );
  return rows[0] !== undefined && rows[0].age < VOICE_HEARTBEAT_MAX_AGE_SEC;
}

export interface InboundCall {
  provider: string;
  providerCallId: string;
  from: string | null;
  /** The clinic's virtual number the patient dialled (or that the call was forwarded to). */
  to: string | null;
}

export interface RoutedCall {
  clinicId: string;
  callId: string;
  route: CallRoute;
  forwardTo: string | null;
}

/** Finds the clinic, records the call (once, even if the provider asks twice) and decides the route. */
export async function routeInboundCall(
  pool: Pool,
  call: InboundCall,
  options: { voiceHealthy: boolean; now?: Date },
): Promise<RoutedCall | null> {
  if (!call.providerCallId) return null;
  // Calls we placed ourselves (confirmations) are already recorded; otherwise find the clinic by number.
  const clinicId = await withAppRole(pool, async (c) => {
    const known = (
      await c.query("select app.clinic_for_call($1, $2) as id", [call.provider, call.providerCallId])
    ).rows[0].id as string | null;
    if (known || !call.to) return known;
    return (await c.query("select app.clinic_for_channel('voice', $1) as id", [call.to])).rows[0].id as
      string | null;
  });
  if (!clinicId) return null;
  const now = options.now ?? new Date();

  return withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    const clinic = (await c.query("select timezone, phone, settings from clinics where id = $1", [clinicId]))
      .rows[0];
    const settings = voiceSettings(clinic.settings);
    let route: CallRoute = "assistant";
    if (!settings.enabled) route = "forwarded_disabled";
    else if (!options.voiceHealthy) route = "forwarded_unhealthy";
    else if (settings.answerMode === "after_hours" && (await clinicOpen(c, clinic.timezone, now)))
      route = "forwarded_hours";

    const inserted = await c.query(
      `insert into calls (clinic_id, provider, provider_call_id, direction, from_phone, to_phone, route, outcome, patient_id)
       values (app.current_clinic_id(), $1, $2, 'inbound', $3, $4, $5, $6,
               (select id from patients where phone = $3 and deleted_at is null order by created_at limit 1))
       on conflict (provider, provider_call_id) do nothing
       returning id, route`,
      [
        call.provider,
        call.providerCallId,
        call.from,
        call.to,
        route,
        route === "assistant" ? null : "forwarded",
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await c.query("select id, route from calls where provider = $1 and provider_call_id = $2", [
          call.provider,
          call.providerCallId,
        ])
      ).rows[0];
    return {
      clinicId,
      callId: row.id,
      route: row.route as CallRoute,
      forwardTo: clinic.phone ?? settings.staffPhones[0] ?? null,
    };
  });
}

async function clinicOpen(c: import("pg").PoolClient, timezone: string, now: Date): Promise<boolean> {
  const date = localDateOf(now, timezone);
  const minutes = localMinutesOf(now, timezone);
  const holiday = await c.query("select 1 from holidays where date = $1", [date]);
  if (holiday.rowCount) return false;
  const { rows } = await c.query(
    `select 1 from working_hours where doctor_id is null and weekday = $1
       and extract(hour from start_time) * 60 + extract(minute from start_time) <= $2
       and extract(hour from end_time) * 60 + extract(minute from end_time) > $2`,
    [weekdayOf(date), minutes],
  );
  return rows.length > 0;
}

/** Which numbers to ring when the assistant hands a call over, and the clinic, for the provider's flow. */
export async function transferTargets(
  pool: Pool,
  provider: string,
  providerCallId: string,
): Promise<{
  clinicId: string;
  callId: string;
  kind: "staff" | "emergency" | null;
  numbers: string[];
  callerId: string | null;
} | null> {
  const clinicId = await withAppRole(
    pool,
    async (c) =>
      (await c.query("select app.clinic_for_call($1, $2) as id", [provider, providerCallId])).rows[0].id as
        string | null,
  );
  if (!clinicId) return null;
  return withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    const row = (
      await c.query(
        `select k.id, k.transfer_kind, k.transfer_numbers, k.route, k.to_phone, cl.phone, cl.settings
         from calls k join clinics cl on cl.id = k.clinic_id where k.provider = $1 and k.provider_call_id = $2`,
        [provider, providerCallId],
      )
    ).rows[0];
    if (!row) return null;
    // Forwarded calls ring the clinic's own phone (and then staff phones).
    const numbers: string[] = row.transfer_numbers?.length
      ? row.transfer_numbers
      : [...new Set([row.phone, ...voiceSettings(row.settings).staffPhones].filter(Boolean))];
    return { clinicId, callId: row.id, kind: row.transfer_kind, numbers, callerId: row.to_phone };
  });
}
