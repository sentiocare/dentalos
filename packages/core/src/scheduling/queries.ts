import type { PoolClient } from "pg";

export interface CalendarAppointment {
  id: string;
  branchId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMin: number;
  status: string;
  source: string;
  notes: string | null;
  patient: { id: string; name: string; phone: string | null };
  doctor: { id: string; name: string; color: string | null };
  chair: { id: string; name: string };
  procedure: { id: string; name: string; nameHi: string | null } | null;
}

/** Appointments overlapping a window, with the names the calendar and Today screen show. */
export async function listAppointments(
  client: PoolClient,
  window: { from: Date; to: Date; branchId?: string; includeCancelled?: boolean },
): Promise<CalendarAppointment[]> {
  const { rows } = await client.query(
    `select a.id, a.branch_id, a.starts_at, a.ends_at, a.buffer_min, a.status, a.source, a.notes,
            p.id as patient_id, p.name as patient_name, p.phone as patient_phone,
            d.id as doctor_id, d.name as doctor_name, d.color as doctor_color,
            c.id as chair_id, c.name as chair_name,
            pt.id as procedure_id, pt.name as procedure_name, pt.name_hi as procedure_name_hi
     from appointments a
     join patients p on p.id = a.patient_id
     join doctors d on d.id = a.doctor_id
     join chairs c on c.id = a.chair_id
     left join procedure_types pt on pt.id = a.procedure_type_id
     where a.starts_at < $2 and a.ends_at > $1
       and ($3::uuid is null or a.branch_id = $3)
       and ($4 or a.status not in ('cancelled'))
     order by a.starts_at, d.name`,
    [window.from, window.to, window.branchId ?? null, window.includeCancelled ?? false],
  );
  return rows.map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    bufferMin: r.buffer_min,
    status: r.status,
    source: r.source,
    notes: r.notes,
    patient: { id: r.patient_id, name: r.patient_name, phone: r.patient_phone },
    doctor: { id: r.doctor_id, name: r.doctor_name, color: r.doctor_color },
    chair: { id: r.chair_id, name: r.chair_name },
    procedure: r.procedure_id
      ? { id: r.procedure_id, name: r.procedure_name, nameHi: r.procedure_name_hi }
      : null,
  }));
}

export async function listPatientAppointments(client: PoolClient, patientId: string, limit = 50) {
  const { rows } = await client.query(
    `select a.id, a.starts_at, a.ends_at, a.status, a.doctor_id, d.name as doctor_name, pt.name as procedure_name
     from appointments a join doctors d on d.id = a.doctor_id left join procedure_types pt on pt.id = a.procedure_type_id
     where a.patient_id = $1 order by a.starts_at desc limit $2`,
    [patientId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    status: r.status as string,
    doctorId: r.doctor_id as string,
    doctorName: r.doctor_name as string,
    procedureName: r.procedure_name as string | null,
  }));
}
