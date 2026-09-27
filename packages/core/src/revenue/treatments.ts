import type { PoolClient } from "pg";
import { DomainError } from "../errors";
import { addDays, localDateOf, type LocalDate } from "../time";

/**
 * Treatment plans (Build Prompt §5.4): a sequence of sittings made from a template (RCT + crown, implant
 * stages, braces…), each with an expected window and a rupee value. Appointments linked to a sitting update
 * the plan through a database trigger (0006), so the plan is right whoever books or completes the visit.
 */
export interface TemplateStep {
  procedure_code: string;
  /** Days after the previous sitting (0 for the first). */
  gap_min_days: number;
  gap_max_days: number;
  requires_lab?: boolean;
}

export interface TreatmentTemplateDefinition {
  code: string;
  name: string;
  nameHi: string;
  steps: TemplateStep[];
}

const step = (
  procedure_code: string,
  gap_min_days = 0,
  gap_max_days = gap_min_days,
  requires_lab = false,
): TemplateStep => ({
  procedure_code,
  gap_min_days,
  gap_max_days,
  requires_lab,
});

/** Seeded for every clinic; editable. Gaps follow common Indian practice and can be changed per clinic. */
export const DEFAULT_TREATMENT_TEMPLATES: TreatmentTemplateDefinition[] = [
  {
    code: "rct_crown",
    name: "Root canal + crown",
    nameHi: "रूट कैनाल + कैप",
    steps: [
      step("rct_sitting"),
      step("rct_sitting", 3, 7),
      step("rct_sitting", 3, 7),
      step("crown_prep", 7, 14),
      step("crown_fitting", 7, 10, true),
    ],
  },
  {
    code: "rct",
    name: "Root canal",
    nameHi: "रूट कैनाल",
    steps: [step("rct_sitting"), step("rct_sitting", 3, 7), step("rct_sitting", 3, 7)],
  },
  {
    code: "implant",
    name: "Implant",
    nameHi: "इम्प्लांट",
    steps: [
      step("implant_surgery"),
      step("implant_followup", 7, 10),
      step("crown_prep", 90, 120),
      step("crown_fitting", 7, 14, true),
    ],
  },
  {
    code: "braces",
    name: "Braces (monthly adjustments)",
    nameHi: "ब्रेसेस (हर महीने)",
    steps: [
      step("ortho_consultation"),
      ...Array.from({ length: 12 }, () => step("ortho_adjustment", 28, 35)),
    ],
  },
  {
    code: "aligners",
    name: "Aligners",
    nameHi: "अलाइनर",
    steps: [step("ortho_consultation"), ...Array.from({ length: 6 }, () => step("ortho_adjustment", 42, 56))],
  },
  {
    code: "dentures",
    name: "Dentures",
    nameHi: "नकली दाँत (डेंचर)",
    steps: [
      step("denture_impression"),
      step("denture_trial", 7, 10, true),
      step("denture_delivery", 7, 10, true),
    ],
  },
  {
    code: "extraction",
    name: "Extraction + check",
    nameHi: "दाँत निकालना + जाँच",
    steps: [step("extraction"), step("followup", 7, 10)],
  },
  {
    code: "surgical_extraction",
    name: "Surgical extraction + check",
    nameHi: "सर्जिकल एक्सट्रैक्शन + जाँच",
    steps: [step("surgical_extraction"), step("followup", 7, 7)],
  },
  {
    code: "crown_bridge",
    name: "Crown / bridge",
    nameHi: "कैप / ब्रिज",
    steps: [step("crown_prep"), step("crown_fitting", 7, 10, true)],
  },
  { code: "filling", name: "Filling", nameHi: "फ़िलिंग", steps: [step("filling")] },
  { code: "scaling", name: "Cleaning", nameHi: "सफ़ाई", steps: [step("scaling")] },
  {
    code: "paediatric",
    name: "Children's treatment",
    nameHi: "बच्चों का इलाज",
    steps: [step("pediatric"), step("pediatric", 7, 14)],
  },
];

/** Adds the standard templates a clinic doesn't have yet (keeps the clinic's own edits). */
export async function ensureTreatmentTemplates(client: PoolClient, clinicId?: string): Promise<void> {
  const { rows } = await client.query(
    "select code from procedure_types where active and clinic_id = coalesce($1, app.current_clinic_id())",
    [clinicId ?? null],
  );
  const available = new Set(rows.map((r) => r.code as string));
  for (const [i, t] of DEFAULT_TREATMENT_TEMPLATES.entries()) {
    if (!t.steps.every((s) => available.has(s.procedure_code))) continue;
    await client.query(
      `insert into treatment_templates (clinic_id, code, name, name_hi, steps, sort_order)
       values (coalesce($6, app.current_clinic_id()), $1, $2, $3, $4, $5) on conflict (clinic_id, code) do nothing`,
      [t.code, t.name, t.nameHi, JSON.stringify(t.steps), i, clinicId ?? null],
    );
  }
}

/** A typical value for one sitting: the middle of the clinic's price range. */
function defaultValue(min: number | null, max: number | null): number {
  if (min !== null && max !== null) return Math.round((Number(min) + Number(max)) / 2);
  return Number(min ?? max ?? 0);
}

export interface NewPlan {
  patientId: string;
  doctorId?: string | null;
  templateId?: string;
  /** Either a template or explicit steps. */
  steps?: {
    procedureTypeId: string;
    gapMinDays?: number;
    gapMaxDays?: number;
    valuePaise?: number;
    tooth?: string;
  }[];
  title?: string;
  teeth?: string[];
  /** When the first sitting is expected (defaults to today). */
  startDate?: LocalDate;
  /** Staff may set the value of each sitting (same order as the steps). */
  values?: number[];
  status?: "proposed" | "accepted";
  notes?: string;
  createdBy?: string | null;
  now?: Date;
}

export async function createTreatmentPlan(client: PoolClient, input: NewPlan): Promise<{ id: string }> {
  const clinic = (await client.query("select timezone from clinics where id = app.current_clinic_id()"))
    .rows[0];
  const today = localDateOf(input.now ?? new Date(), clinic.timezone);
  const procs = new Map(
    (
      await client.query(
        "select id, code, name, price_min_paise, price_max_paise from procedure_types where active",
      )
    ).rows.map((p) => [p.code as string, p]),
  );
  const byId = new Map([...procs.values()].map((p) => [p.id as string, p]));

  let title = input.title;
  let steps: {
    procedureTypeId: string;
    gapMin: number;
    gapMax: number;
    requiresLab: boolean;
    value: number;
    tooth: string | null;
  }[];
  if (input.templateId) {
    const t = (
      await client.query("select name, steps from treatment_templates where id = $1 and active", [
        input.templateId,
      ])
    ).rows[0];
    if (!t) throw new DomainError("not_found", "Treatment template not found");
    title ??= t.name;
    steps = (t.steps as TemplateStep[]).map((s) => {
      const p = procs.get(s.procedure_code);
      if (!p)
        throw new DomainError(
          "invalid",
          `The template needs the treatment "${s.procedure_code}", which is not active`,
        );
      return {
        procedureTypeId: p.id,
        gapMin: s.gap_min_days,
        gapMax: s.gap_max_days,
        requiresLab: !!s.requires_lab,
        value: defaultValue(p.price_min_paise, p.price_max_paise),
        tooth: null,
      };
    });
  } else if (input.steps?.length) {
    steps = input.steps.map((s) => {
      const p = byId.get(s.procedureTypeId);
      if (!p) throw new DomainError("invalid", "Unknown treatment");
      return {
        procedureTypeId: p.id,
        gapMin: s.gapMinDays ?? 0,
        gapMax: s.gapMaxDays ?? s.gapMinDays ?? 0,
        requiresLab: false,
        value: s.valuePaise ?? defaultValue(p.price_min_paise, p.price_max_paise),
        tooth: s.tooth ?? null,
      };
    });
    title ??= byId.get(steps[0]!.procedureTypeId)!.name;
  } else {
    throw new DomainError("invalid", "Choose a template or add at least one sitting");
  }
  input.values?.forEach((v, i) => {
    if (steps[i] && Number.isFinite(v) && v >= 0) steps[i]!.value = Math.round(v);
  });

  const status = input.status ?? "proposed";
  const plan = (
    await client.query(
      `insert into treatment_plans (clinic_id, patient_id, doctor_id, template_id, title, teeth, status, notes, accepted_at, created_by)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, case when $6 = 'accepted' then now() end, $8)
       returning id`,
      [
        input.patientId,
        input.doctorId ?? null,
        input.templateId ?? null,
        title,
        input.teeth ?? [],
        status,
        input.notes ?? null,
        input.createdBy ?? null,
      ],
    )
  ).rows[0];

  let anchor = input.startDate ?? today;
  for (const [i, s] of steps.entries()) {
    const from = i === 0 ? anchor : addDays(anchor, s.gapMin);
    const to = i === 0 ? addDays(anchor, 7) : addDays(anchor, s.gapMax);
    if (i > 0) anchor = from;
    await client.query(
      `insert into treatment_steps (clinic_id, plan_id, seq, procedure_type_id, tooth, gap_min_days, gap_max_days,
                                    expected_from, expected_to, requires_lab, value_paise)
       values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        plan.id,
        i + 1,
        s.procedureTypeId,
        s.tooth ?? input.teeth?.[0] ?? null,
        s.gapMin,
        s.gapMax,
        from,
        to,
        s.requiresLab,
        s.value,
      ],
    );
  }
  return { id: plan.id };
}

export async function setPlanStatus(
  client: PoolClient,
  planId: string,
  action: "accept" | "abandon",
  reason?: string,
): Promise<void> {
  const { rowCount } =
    action === "accept"
      ? await client.query(
          "update treatment_plans set status = 'accepted', accepted_at = now() where id = $1 and status = 'proposed'",
          [planId],
        )
      : await client.query(
          `update treatment_plans set status = 'abandoned', abandoned_at = now(), abandon_reason = $2
           where id = $1 and status in ('proposed', 'accepted', 'in_progress')`,
          [planId, reason ?? null],
        );
  if (!rowCount) throw new DomainError("invalid", "The plan cannot be changed in its current state");
}

export async function updateStep(
  client: PoolClient,
  stepId: string,
  change: { valuePaise?: number; skip?: boolean },
): Promise<void> {
  if (change.valuePaise !== undefined)
    await client.query("update treatment_steps set value_paise = $2 where id = $1", [
      stepId,
      Math.round(change.valuePaise),
    ]);
  if (change.skip) {
    await client.query(
      "update treatment_steps set status = 'skipped' where id = $1 and status in ('pending', 'missed')",
      [stepId],
    );
    // A plan whose last open sitting was skipped is complete.
    await client.query(
      `update treatment_plans p set status = 'completed', completed_at = now()
       where p.id = (select plan_id from treatment_steps where id = $1) and p.status in ('accepted', 'in_progress')
         and not exists (select 1 from treatment_steps s where s.plan_id = p.id and s.status not in ('done', 'skipped'))`,
      [stepId],
    );
  }
}

export interface PlanView {
  id: string;
  title: string;
  status: string;
  teeth: string[];
  doctorId: string | null;
  createdAt: Date;
  totalPaise: number;
  donePaise: number;
  steps: {
    id: string;
    seq: number;
    procedureTypeId: string;
    procedure: string;
    tooth: string | null;
    status: string;
    expectedFrom: string | null;
    expectedTo: string | null;
    valuePaise: number;
    appointmentId: string | null;
    appointmentStartsAt: Date | null;
    requiresLab: boolean;
  }[];
}

export async function patientPlans(client: PoolClient, patientId: string): Promise<PlanView[]> {
  const plans = (
    await client.query(
      "select id, title, status, teeth, doctor_id, created_at from treatment_plans where patient_id = $1 order by created_at desc",
      [patientId],
    )
  ).rows;
  if (plans.length === 0) return [];
  const steps = (
    await client.query(
      `select s.id, s.plan_id, s.seq, s.procedure_type_id, pt.name as procedure, s.tooth, s.status, s.expected_from::text,
              s.expected_to::text, s.value_paise, s.appointment_id, a.starts_at, s.requires_lab
       from treatment_steps s join procedure_types pt on pt.id = s.procedure_type_id
       left join appointments a on a.id = s.appointment_id
       where s.plan_id = any($1) order by s.plan_id, s.seq`,
      [plans.map((p) => p.id)],
    )
  ).rows;
  return plans.map((p) => {
    const own = steps.filter((s) => s.plan_id === p.id);
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      teeth: p.teeth,
      doctorId: p.doctor_id,
      createdAt: p.created_at,
      totalPaise: own.reduce((n, s) => n + Number(s.value_paise), 0),
      donePaise: own.filter((s) => s.status === "done").reduce((n, s) => n + Number(s.value_paise), 0),
      steps: own.map((s) => ({
        id: s.id,
        seq: s.seq,
        procedureTypeId: s.procedure_type_id,
        procedure: s.procedure,
        tooth: s.tooth,
        status: s.status,
        expectedFrom: s.expected_from,
        expectedTo: s.expected_to,
        valuePaise: Number(s.value_paise),
        appointmentId: s.appointment_id,
        appointmentStartsAt: s.starts_at,
        requiresLab: s.requires_lab,
      })),
    };
  });
}

/** The next sitting to book for a plan, with the window it should fall in. */
export async function nextSitting(client: PoolClient, planId: string) {
  const { rows } = await client.query(
    `select s.id, s.seq, s.procedure_type_id, pt.name as procedure, s.expected_from::text, s.expected_to::text, s.requires_lab,
            p.patient_id, p.doctor_id
     from treatment_steps s join treatment_plans p on p.id = s.plan_id join procedure_types pt on pt.id = s.procedure_type_id
     where s.plan_id = $1 and s.status in ('pending', 'missed') and p.status in ('proposed', 'accepted', 'in_progress')
     order by s.seq limit 1`,
    [planId],
  );
  return rows[0] ?? null;
}

export interface IncompleteTreatment {
  planId: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  title: string;
  doctorId: string | null;
  sittingsLeft: number;
  remainingPaise: number;
  nextStepId: string | null;
  nextProcedure: string | null;
  nextExpectedFrom: string | null;
  nextExpectedTo: string | null;
  /** Days past the end of the next sitting's window (0 if not overdue). */
  overdueDays: number;
  nextBooked: boolean;
}

/**
 * Accepted or started plans with sittings still to do, and what they are worth (Build Prompt §5.4: the
 * "Incomplete treatments" view). Overdue = the next sitting's window has passed and nothing is booked.
 */
export async function incompleteTreatments(
  client: PoolClient,
  now: Date = new Date(),
): Promise<{
  rows: IncompleteTreatment[];
  totals: { plans: number; remainingPaise: number; overduePlans: number; overduePaise: number };
}> {
  const tz = (await client.query("select timezone from clinics where id = app.current_clinic_id()")).rows[0]
    .timezone;
  const today = localDateOf(now, tz);
  const { rows } = await client.query(
    `select p.id as plan_id, p.patient_id, pa.name as patient_name, pa.phone, p.title, p.doctor_id,
            count(s.id) filter (where s.status not in ('done', 'skipped'))::int as sittings_left,
            coalesce(sum(s.value_paise) filter (where s.status not in ('done', 'skipped')), 0)::bigint as remaining,
            (array_agg(s.id order by s.seq) filter (where s.status not in ('done', 'skipped')))[1] as next_step_id
     from treatment_plans p join patients pa on pa.id = p.patient_id join treatment_steps s on s.plan_id = p.id
     where p.status in ('accepted', 'in_progress') and pa.deleted_at is null
     group by p.id, pa.id
     having count(s.id) filter (where s.status not in ('done', 'skipped')) > 0`,
  );
  const nextIds = rows.map((r) => r.next_step_id).filter(Boolean);
  const next = new Map(
    (
      await client.query(
        `select s.id, pt.name, s.expected_from::text, s.expected_to::text, s.status from treatment_steps s
         join procedure_types pt on pt.id = s.procedure_type_id where s.id = any($1)`,
        [nextIds],
      )
    ).rows.map((r) => [r.id as string, r]),
  );
  const out: IncompleteTreatment[] = rows.map((r) => {
    const n = next.get(r.next_step_id);
    const booked = n?.status === "scheduled";
    const overdueDays =
      n && !booked && n.expected_to && n.expected_to < today
        ? Math.round((Date.parse(today) - Date.parse(n.expected_to)) / 86_400_000)
        : 0;
    return {
      planId: r.plan_id,
      patientId: r.patient_id,
      patientName: r.patient_name,
      phone: r.phone,
      title: r.title,
      doctorId: r.doctor_id,
      sittingsLeft: r.sittings_left,
      remainingPaise: Number(r.remaining),
      nextStepId: r.next_step_id ?? null,
      nextProcedure: n?.name ?? null,
      nextExpectedFrom: n?.expected_from ?? null,
      nextExpectedTo: n?.expected_to ?? null,
      overdueDays,
      nextBooked: booked,
    };
  });
  out.sort((a, b) => b.overdueDays - a.overdueDays || b.remainingPaise - a.remainingPaise);
  const overdue = out.filter((r) => r.overdueDays > 0);
  return {
    rows: out,
    totals: {
      plans: out.length,
      remainingPaise: out.reduce((n, r) => n + r.remainingPaise, 0),
      overduePlans: overdue.length,
      overduePaise: overdue.reduce((n, r) => n + r.remainingPaise, 0),
    },
  };
}
