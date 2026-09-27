import { enqueueMessage, meterCall } from "@dentalos/core";
import { withAppRole, withClinic, type Pool } from "@dentalos/db";
import { isIndianMobile, type E164 } from "@dentalos/shared";

/**
 * What happens around the assistant in the telephony provider's call flow: whether to connect the caller to
 * a person after the assistant, what to do when nobody picks up, and the final call status.
 */
async function clinicForCall(pool: Pool, provider: string, providerCallId: string) {
  return withAppRole(
    pool,
    async (c) =>
      (await c.query("select app.clinic_for_call($1, $2) as id", [provider, providerCallId])).rows[0].id as
        string | null,
  );
}

const system = (clinicId: string) => ({ clinicId, actor: "system" as const, role: "system" as const });

/**
 * Nobody answered a transfer (or a forwarded call): a call-back task for staff, and a WhatsApp message to
 * the caller so they are not left wondering (Build Prompt §5.1, §11). Emergencies become critical tasks.
 */
export async function handleUnansweredCall(
  pool: Pool,
  provider: string,
  providerCallId: string,
  dialStatus: string | null,
): Promise<{ clinicId: string; outboxId: string | null } | null> {
  const clinicId = await clinicForCall(pool, provider, providerCallId);
  if (!clinicId) return null;
  return withClinic(pool, system(clinicId), async (c) => {
    const call = (
      await c.query(
        `select k.id, k.from_phone, k.patient_id, k.transfer_kind, k.route, k.summary, cl.name as clinic, cl.default_language
         from calls k join clinics cl on cl.id = k.clinic_id where k.provider = $1 and k.provider_call_id = $2`,
        [provider, providerCallId],
      )
    ).rows[0];
    if (!call) return null;
    const emergency = call.transfer_kind === "emergency";
    await c.query(
      `update calls set transfer_status = $2, status = 'ended', ended_at = coalesce(ended_at, now()),
              outcome = case when outcome in ('emergency') then outcome
                             when route <> 'assistant' then 'forwarded'
                             else 'transfer_failed' end
       where id = $1`,
      [call.id, dialStatus ?? "no-answer"],
    );
    const who = call.patient_id
      ? (await c.query("select name from patients where id = $1", [call.patient_id])).rows[0]?.name
      : null;
    await c.query(
      `insert into tasks (clinic_id, kind, priority, title, detail, call_id, patient_id, created_by, dedupe_key)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, 'voice', $7)
       on conflict (clinic_id, dedupe_key) do nothing`,
      [
        emergency ? "emergency" : "callback",
        emergency ? "critical" : "high",
        `${emergency ? "EMERGENCY - call back now" : "Missed call - call back"}: ${who ?? call.from_phone ?? "unknown number"}`,
        call.summary ??
          (call.route === "assistant"
            ? "Transfer was not answered."
            : "Call to the clinic was not answered."),
        call.id,
        call.patient_id,
        `missed:${call.id}`,
      ],
    );
    let outboxId: string | null = null;
    if (call.from_phone && isIndianMobile(call.from_phone as E164)) {
      outboxId = await enqueueMessage(c, {
        to: call.from_phone,
        category: emergency ? "critical" : "transactional",
        purpose: "missed_call",
        payload: {
          kind: "template",
          purpose: "missed_call",
          language: call.default_language === "en" ? "en" : "hi",
          params: [call.clinic],
        },
        dedupeKey: `missed:${call.id}`,
        patientId: call.patient_id,
      });
    }
    return { clinicId, outboxId };
  });
}

export interface CallStatus {
  providerCallId: string;
  status: "completed" | "no_answer" | "busy" | "failed" | "canceled";
  durationSec: number | null;
  recordingUrl: string | null;
  at: Date;
}

/** The provider's end-of-call report: duration and recording. Returns what follow-up is needed. */
export async function recordCallStatus(
  pool: Pool,
  provider: string,
  event: CallStatus,
): Promise<{ clinicId: string; callId: string; fetchRecording: boolean; unanswered: boolean } | null> {
  const clinicId = await clinicForCall(pool, provider, event.providerCallId);
  if (!clinicId) return null;
  return withClinic(pool, system(clinicId), async (c) => {
    const { rows } = await c.query(
      `update calls set duration_sec = coalesce($2, duration_sec), recording_url = coalesce($3, recording_url),
              ended_at = coalesce(ended_at, $4), status = 'ended'
       where provider = $1 and provider_call_id = $5
       returning id, route, outcome, transfer_status`,
      [provider, event.durationSec, event.recordingUrl, event.at, event.providerCallId],
    );
    const row = rows[0];
    if (!row) return null;
    await meterCall(c, row.id, event.at);
    // A forwarded call nobody picked up is a missed call, even if the flow had no "missed" step.
    const unanswered =
      row.route !== "assistant" && row.transfer_status === null && event.status !== "completed";
    return { clinicId, callId: row.id, fetchRecording: !!event.recordingUrl, unanswered };
  });
}
