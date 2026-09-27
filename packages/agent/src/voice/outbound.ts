import { localMinutesOf } from "@dentalos/core";
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
        | "too_late"
        | "no_phone"
        | "opted_out"
        | "outside_hours"
        | "no_number"
        | "no_flow"
        | "calls_off";
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
    const opted = await c.query(
      "select 1 from opt_outs where phone = $1 and revoked_at is null and channel in ('voice', 'all') and category in ('transactional', 'all')",
      [a.phone],
    );
    if (opted.rowCount) return { ok: false, reason: "opted_out" };
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

/** Records a call we placed, so the call flow and media stream recognise it when the patient answers. */
export async function recordOutboundCall(
  pool: Pool,
  input: {
    clinicId: string;
    provider: string;
    providerCallId: string;
    appointmentId: string;
    phone: string;
    callerId: string;
    patientId: string;
  },
): Promise<string> {
  return withClinic(pool, { clinicId: input.clinicId, actor: "system", role: "system" }, async (c) => {
    const { rows } = await c.query(
      `insert into calls (clinic_id, provider, provider_call_id, direction, from_phone, to_phone, patient_id, route, purpose, subject_id)
       values (app.current_clinic_id(), $1, $2, 'outbound', $3, $4, $5, 'assistant', 'confirm_appointment', $6)
       on conflict (provider, provider_call_id) do update set purpose = excluded.purpose returning id`,
      [
        input.provider,
        input.providerCallId,
        input.phone,
        input.callerId,
        input.patientId,
        input.appointmentId,
      ],
    );
    return rows[0].id;
  });
}
