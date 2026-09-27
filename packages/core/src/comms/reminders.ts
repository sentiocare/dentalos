import type { PoolClient } from "pg";
import { addDays, localDateOf, zonedInstant } from "../time";
import { whenInWords } from "../i18n/when";
import { enqueueMessage } from "./outbox";

/**
 * Plans every appointment message (Build Prompt §5.9). Idempotent: run it every minute; each message has
 * a dedupe key that includes the appointment time, so a moved appointment gets fresh reminders and the old
 * ones are dropped at send time (see appointmentStillMatches).
 */
export interface ReminderSettings {
  enabled: boolean;
  /** Clinic-local time the day-before reminder goes out. */
  dayBeforeAt: string;
  sameDayHoursBefore: number;
}

export const DEFAULT_REMINDERS: ReminderSettings = {
  enabled: true,
  dayBeforeAt: "17:00",
  sameDayHoursBefore: 2,
};

interface Row {
  id: string;
  starts_at: Date;
  created_at: Date;
  status: string;
  source: string;
  notified_starts_at: Date | null;
  cancellation_notified_at: Date | null;
  patient_id: string;
  patient_name: string;
  phone: string | null;
  language_pref: string | null;
  doctor: string;
}

export async function planAppointmentMessages(
  client: PoolClient,
  now: Date = new Date(),
): Promise<{ queued: number; tasks: number }> {
  const clinic = (
    await client.query(
      "select name, timezone, default_language, address, maps_url, settings from clinics where id = app.current_clinic_id()",
    )
  ).rows[0];
  const settings: ReminderSettings = {
    ...DEFAULT_REMINDERS,
    ...(clinic.settings?.messaging?.reminders ?? {}),
  };
  if (!settings.enabled) return { queued: 0, tasks: 0 };
  const tz: string = clinic.timezone;

  const { rows } = await client.query<Row>(
    `select a.id, a.starts_at, a.created_at, a.status, a.source, a.notified_starts_at, a.cancellation_notified_at,
            p.id as patient_id, p.name as patient_name, p.phone, p.language_pref, d.name as doctor
     from appointments a join patients p on p.id = a.patient_id join doctors d on d.id = a.doctor_id
     where a.starts_at > $1 and a.starts_at < $1 + interval '60 days'
       and (
         (a.status in ('booked', 'confirmed') and (a.notified_starts_at is distinct from a.starts_at or a.starts_at < $1 + interval '48 hours'))
         or (a.status = 'cancelled' and a.notified_starts_at is not null and a.cancellation_notified_at is null)
       )`,
    [now],
  );

  let queued = 0;
  const tasks = 0;
  const q = async (
    row: Row,
    purpose: string,
    dedupeKey: string,
    params: string[],
    extra: { notBefore?: Date; buttons?: string[]; requireStatus?: "active" | "cancelled" } = {},
  ) => {
    if (!row.phone) return;
    const language = templateLanguage(row.language_pref, clinic.default_language);
    const id = await enqueueMessage(client, {
      to: row.phone,
      category: "transactional",
      purpose,
      patientId: row.patient_id,
      appointmentId: row.id,
      dedupeKey,
      notBefore: extra.notBefore,
      payload: {
        kind: "template",
        purpose: purpose as never,
        language,
        params,
        buttonPayloads: extra.buttons,
        meta: {
          appointmentStartsAt: row.starts_at.toISOString(),
          requireStatus: extra.requireStatus ?? "active",
        },
      } as never,
    });
    if (id) queued++;
  };

  for (const row of rows) {
    const language = templateLanguage(row.language_pref, clinic.default_language);
    const when = whenInWords(row.starts_at, tz, language);
    const key = `${row.id}:${row.starts_at.toISOString()}`;

    if (row.status === "cancelled") {
      await q(
        row,
        "appointment_cancelled",
        `appt:${row.id}:cancelled`,
        [row.patient_name, clinic.name, whenInWords(row.notified_starts_at!, tz, language)],
        { requireStatus: "cancelled" },
      );
      await client.query("update appointments set cancellation_notified_at = $2 where id = $1", [
        row.id,
        now,
      ]);
      continue;
    }

    if (row.notified_starts_at?.getTime() !== row.starts_at.getTime()) {
      // Bookings made in a WhatsApp or voice conversation were already confirmed there; imports are history.
      const silent = row.notified_starts_at === null && ["whatsapp", "voice", "import"].includes(row.source);
      if (!silent) {
        const purpose = row.notified_starts_at === null ? "booking_confirmation" : "appointment_rescheduled";
        await q(row, purpose, `appt:${key}:${purpose}`, [row.patient_name, clinic.name, when, row.doctor]);
      }
      await client.query("update appointments set notified_starts_at = starts_at where id = $1", [row.id]);
    }

    const startLocalDate = localDateOf(row.starts_at, tz);
    const [h, m] = settings.dayBeforeAt.split(":").map(Number) as [number, number];
    const dayBefore = zonedInstant(addDays(startLocalDate, -1), h * 60 + m, tz);
    if (row.created_at < dayBefore && now < row.starts_at) {
      await q(
        row,
        "reminder_day_before",
        `appt:${key}:reminder_day_before`,
        [row.patient_name, clinic.name, when, row.doctor],
        {
          notBefore: dayBefore,
          buttons: [`confirm:${row.id}`, `reschedule:${row.id}`],
        },
      );
    }
    const sameDay = new Date(row.starts_at.getTime() - settings.sameDayHoursBefore * 3600_000);
    if (row.created_at < sameDay) {
      const time = whenInWords(row.starts_at, tz, language).split(", ").at(-1)!;
      await q(
        row,
        "reminder_same_day",
        `appt:${key}:reminder_same_day`,
        [row.patient_name, clinic.name, time, clinic.maps_url ?? clinic.address ?? ""],
        {
          notBefore: sameDay,
        },
      );
    }
  }
  return { queued, tasks };
}

function templateLanguage(pref: string | null, clinicDefault: string): "en" | "hi" {
  if (pref === "en") return "en";
  if (pref === "hi" || pref === "hinglish") return "hi";
  return clinicDefault === "en" ? "en" : "hi";
}

/** Checked at send time: a reminder for an appointment that moved, was cancelled or is over is dropped. */
export async function appointmentStillMatches(
  client: PoolClient,
  appointmentId: string,
  meta: { appointmentStartsAt?: string; requireStatus?: "active" | "cancelled" } | undefined,
): Promise<boolean> {
  if (!meta?.appointmentStartsAt) return true;
  const { rows } = await client.query("select status, starts_at from appointments where id = $1", [
    appointmentId,
  ]);
  const a = rows[0];
  if (!a) return false;
  if (meta.requireStatus === "cancelled") return a.status === "cancelled";
  return ["booked", "confirmed"].includes(a.status) && a.starts_at.toISOString() === meta.appointmentStartsAt;
}
