import { blockedByTestMode, canUse, leadCalledByAssistant, localMinutesOf } from "@dentalos/core";
import { withClinic, type Pool } from "@dentalos/db";
import { voiceSettings } from "./routing";

/**
 * Outbound AI calls (Build Prompt §6.9): transactional only (here: confirming an existing appointment),
 * only to patients who have not asked us to stop calling, only between 09:00 and 20:00 clinic time, only
 * from the clinic's registered number, and never when the appointment has changed since the call was asked for.
 */
export type OutboundCheck =
  | { ok: true; phone: string; callerId: string; flowId: string; patientId: string }
  | {
      ok: false;
      reason:
        | "not_booked"
        | "test_mode"
        | "too_late"
        | "no_phone"
        | "opted_out"
        | "outside_hours"
        | "no_number"
        | "no_flow"
        | "calls_off"
        | "wallet_paused";
    };

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

export async function checkConfirmationCall(
  pool: Pool,
  clinicId: string,
  appointmentId: string,
  now: Date = new Date(),
): Promise<OutboundCheck> {
  return withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    const a = (
      await c.query(
        `select a.status, a.starts_at, p.id as patient_id, p.phone, cl.timezone, cl.settings
         from appointments a join patients p on p.id = a.patient_id join clinics cl on cl.id = a.clinic_id where a.id = $1`,
        [appointmentId],
      )
    ).rows[0];
    if (!a || a.status !== "booked") return { ok: false, reason: "not_booked" };
    if (a.starts_at.getTime() - now.getTime() < 60 * 60_000) return { ok: false, reason: "too_late" };
    if (!a.phone) return { ok: false, reason: "no_phone" };
    const raw = (a.settings?.voice ?? {}) as {
      outboundCalls?: boolean;
      outboundHours?: [string, string];
      outboundFlowId?: string;
    };
    if (!voiceSettings(a.settings).enabled || raw.outboundCalls === false)
      return { ok: false, reason: "calls_off" };
    if (!(await canUse(c, "ai_outbound_call", now))) return { ok: false, reason: "wallet_paused" };
    const opted = await c.query(
      "select 1 from opt_outs where phone = $1 and revoked_at is null and channel in ('voice', 'all') and category in ('transactional', 'all')",
      [a.phone],
    );
    if (opted.rowCount) return { ok: false, reason: "opted_out" };
    if (await blockedByTestMode(c, a.phone, a.settings)) return { ok: false, reason: "test_mode" };
    const [from, to] = raw.outboundHours ?? ["09:00", "20:00"];
    const minutes = localMinutesOf(now, a.timezone);
    if (minutes < toMin(from) || minutes >= toMin(to)) return { ok: false, reason: "outside_hours" };
    const number = (
      await c.query("select external_id from clinic_channels where kind = 'voice' and active limit 1")
    ).rows[0];
    if (!number) return { ok: false, reason: "no_number" };
    if (!raw.outboundFlowId) return { ok: false, reason: "no_flow" };
    return {
      ok: true,
      phone: a.phone,
      callerId: number.external_id,
      flowId: raw.outboundFlowId,
      patientId: a.patient_id,
    };
  });
}

/**
 * An AI call to a new lead (they asked the clinic to contact them through an ad or form). Checked again just
 * before dialling: the lead may have booked, replied on WhatsApp, said STOP or asked not to be called.
 */
export type LeadCallCheck =
  | { ok: true; phone: string; callerId: string; flowId: string; patientId: string | null }
  | {
      ok: false;
      reason:
        | "not_open"
        | "chatting"
        | "test_mode"
        | "opted_out"
        | "outside_hours"
        | "no_number"
        | "no_flow"
        | "calls_off"
        | "wallet_paused";
    };

export async function checkLeadCall(
  pool: Pool,
  clinicId: string,
  leadId: string,
  now: Date = new Date(),
): Promise<LeadCallCheck> {
  return withClinic(pool, { clinicId, actor: "system", role: "system" }, async (c) => {
    const l = (
      await c.query(
        `select l.stage, l.phone, l.first_reply_at, l.patient_id, cl.timezone, cl.settings
         from leads l join clinics cl on cl.id = l.clinic_id where l.id = $1`,
        [leadId],
      )
    ).rows[0];
    if (!l || !["new", "contacted", "engaged", "qualified"].includes(l.stage))
      return { ok: false, reason: "not_open" };
    if (l.first_reply_at) return { ok: false, reason: "chatting" };
    const v = voiceSettings(l.settings);
    if (!v.enabled || !v.outboundCalls || !v.leadCalls) return { ok: false, reason: "calls_off" };
    if (!(await canUse(c, "ai_outbound_call", now))) return { ok: false, reason: "wallet_paused" };
    const opted = await c.query(
      "select 1 from opt_outs where phone = $1 and revoked_at is null and channel in ('voice', 'all')",
      [l.phone],
    );
    if (opted.rowCount) return { ok: false, reason: "opted_out" };
    if (await blockedByTestMode(c, l.phone, l.settings)) return { ok: false, reason: "test_mode" };
    const [from, to] = (l.settings?.voice?.outboundHours as [string, string] | undefined) ?? [
      "09:00",
      "20:00",
    ];
    const minutes = localMinutesOf(now, l.timezone);
    if (minutes < toMin(from) || minutes >= toMin(to)) return { ok: false, reason: "outside_hours" };
    const number = (
      await c.query("select external_id from clinic_channels where kind = 'voice' and active limit 1")
    ).rows[0];
    if (!number) return { ok: false, reason: "no_number" };
    if (!v.outboundFlowId) return { ok: false, reason: "no_flow" };
    return {
      ok: true,
      phone: l.phone,
      callerId: number.external_id,
      flowId: v.outboundFlowId,
      patientId: l.patient_id ?? null,
    };
  });
}

/** Records a call we placed, so the call flow and media stream recognise it when the patient answers. */
export async function recordOutboundCall(
  pool: Pool,
  input: {
    clinicId: string;
    provider: string;
    providerCallId: string;
    purpose?: "confirm_appointment" | "lead_call";
    /** The appointment (confirmation calls) or the lead (lead calls) the call is about. */
    subjectId: string;
    phone: string;
    callerId: string;
    patientId: string | null;
  },
): Promise<string> {
  return withClinic(pool, { clinicId: input.clinicId, actor: "system", role: "system" }, async (c) => {
    const { rows } = await c.query(
      `insert into calls (clinic_id, provider, provider_call_id, direction, from_phone, to_phone, patient_id, route, purpose, subject_id)
       values (app.current_clinic_id(), $1, $2, 'outbound', $3, $4, $5, 'assistant', $7, $6)
       on conflict (provider, provider_call_id) do update set purpose = excluded.purpose returning id`,
      [
        input.provider,
        input.providerCallId,
        input.phone,
        input.callerId,
        input.patientId,
        input.subjectId,
        input.purpose ?? "confirm_appointment",
      ],
    );
    // The lead has been phoned: speed to lead counts it, and its timeline shows it.
    if (input.purpose === "lead_call" && input.subjectId)
      await leadCalledByAssistant(c, input.subjectId, new Date());
    return rows[0].id;
  });
}
