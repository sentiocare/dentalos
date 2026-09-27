import { ensureTreatmentTemplates } from "../revenue/treatments";
import { normalizePhone } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { DomainError } from "../errors";
import { DEFAULT_PROCEDURES } from "./defaults";

export interface NewClinic {
  name: string;
  city?: string;
  phone?: string;
  owner: { name: string; phone: string };
  /** Mon–Sat 10:00–14:00 and 17:00–21:00 unless given. */
  hours?: { weekday: number; start: string; end: string }[];
}

const DEFAULT_HOURS = [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, start: "10:00", end: "14:00" },
  { weekday, start: "17:00", end: "21:00" },
]);

/**
 * Sentio admin action (not available to clinic staff): creates a clinic with its default branch, opening
 * hours, starter procedure list and the owner's invitation. The owner signs in with their phone number
 * and the membership is claimed automatically. Must run with the privileged role, in one transaction.
 */
export async function createClinic(
  client: PoolClient,
  input: NewClinic,
): Promise<{ clinicId: string; branchId: string }> {
  const ownerPhone = normalizePhone(input.owner.phone);
  if (!ownerPhone) throw new DomainError("invalid", "Owner phone number is not valid");
  const clinicPhone = input.phone ? normalizePhone(input.phone) : null;

  const clinic = await client.query(
    "insert into clinics (name, city, phone) values ($1, $2, $3) returning id",
    [input.name.trim(), input.city ?? null, clinicPhone],
  );
  const clinicId: string = clinic.rows[0].id;
  const branch = await client.query(
    "insert into branches (clinic_id, name, is_default, phone) values ($1, 'Main', true, $2) returning id",
    [clinicId, clinicPhone],
  );
  const branchId: string = branch.rows[0].id;

  for (const h of input.hours ?? DEFAULT_HOURS) {
    await client.query(
      "insert into working_hours (clinic_id, branch_id, weekday, start_time, end_time) values ($1, $2, $3, $4, $5)",
      [clinicId, branchId, h.weekday, h.start, h.end],
    );
  }
  await client.query(
    `insert into chairs (clinic_id, branch_id, name, sort_order) values ($1, $2, 'Chair 1', 1)`,
    [clinicId, branchId],
  );

  for (const [i, p] of DEFAULT_PROCEDURES.entries()) {
    await client.query(
      `insert into procedure_types (clinic_id, code, name, name_hi, category, default_duration_min, buffer_after_min,
                                    synonyms, is_consultation, requires_lab_received, price_public, sort_order,
                                    recall_months, checkin, aftercare)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13, $14)`,
      [
        clinicId,
        p.code,
        p.name,
        p.nameHi,
        p.category,
        p.durationMin,
        p.bufferMin,
        p.synonyms,
        p.isConsultation ?? false,
        p.requiresLab ?? false,
        i,
        p.recallMonths ?? null,
        p.checkin ?? false,
        p.aftercare ? JSON.stringify({ ...p.aftercare, approved: false }) : null,
      ],
    );
  }

  await ensureTreatmentTemplates(client, clinicId);

  await client.query(
    `insert into clinic_memberships (clinic_id, invited_phone, display_name, role) values ($1, $2, $3, 'owner')`,
    [clinicId, ownerPhone, input.owner.name.trim()],
  );
  return { clinicId, branchId };
}
