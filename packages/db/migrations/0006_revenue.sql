-- 0006: the revenue engine (Phase 4): treatment plans and sittings, estimates, one follow-up engine for
-- every "chase" (continuity, estimates, no-shows, unconfirmed, recall, after-care), reactivation campaigns.

-- ---------------------------------------------------------------------------------------------------
-- Procedure settings used by follow-ups
-- ---------------------------------------------------------------------------------------------------

alter table public.procedure_types
  -- Months after this procedure to remind the patient to come back (null = no recall).
  add column recall_months int check (recall_months between 1 and 36),
  -- After-care instructions sent after the visit, written by the doctor: {"en": "...", "hi": "..."}.
  add column aftercare jsonb,
  -- Send a next-day "how are you feeling?" check-in after this procedure.
  add column checkin boolean not null default false,
  -- Optional advance payment asked for when a patient books this online (0/null = none).
  add column deposit_paise bigint check (deposit_paise >= 0);

-- ---------------------------------------------------------------------------------------------------
-- Treatment templates, plans and steps (sittings)
-- ---------------------------------------------------------------------------------------------------

create table public.treatment_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  name_hi text,
  -- [{procedure_code, gap_min_days, gap_max_days, requires_lab}] — gaps are from the previous sitting.
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 40),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, code),
  unique (clinic_id, id)
);

create table public.treatment_plans (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid,
  template_id uuid,
  title text not null,
  -- FDI tooth numbers ("36", "46").
  teeth text[] not null default '{}',
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'in_progress', 'completed', 'abandoned')),
  notes text,
  accepted_at timestamptz,
  completed_at timestamptz,
  abandoned_at timestamptz,
  abandon_reason text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  foreign key (clinic_id, template_id) references public.treatment_templates (clinic_id, id)
);
create index treatment_plans_patient on public.treatment_plans (clinic_id, patient_id);
create index treatment_plans_open on public.treatment_plans (clinic_id, status) where status in ('accepted', 'in_progress');

create table public.treatment_steps (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  plan_id uuid not null,
  seq int not null check (seq >= 1),
  procedure_type_id uuid not null,
  tooth text,
  -- Gap from the previous sitting, kept so the window can be recalculated when a sitting happens.
  gap_min_days int not null default 0 check (gap_min_days >= 0),
  gap_max_days int not null default 0 check (gap_max_days >= gap_min_days),
  expected_from date,
  expected_to date,
  requires_lab boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'done', 'missed', 'skipped')),
  appointment_id uuid,
  value_paise bigint not null default 0 check (value_paise >= 0),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, seq),
  unique (clinic_id, id),
  foreign key (clinic_id, plan_id) references public.treatment_plans (clinic_id, id) on delete cascade,
  foreign key (clinic_id, procedure_type_id) references public.procedure_types (clinic_id, id)
);
create index treatment_steps_due on public.treatment_steps (clinic_id, status, expected_from);

alter table public.appointments add column treatment_step_id uuid;
alter table public.appointments
  add constraint appointments_treatment_step_fk foreign key (clinic_id, treatment_step_id)
  references public.treatment_steps (clinic_id, id) on delete set null (treatment_step_id);
alter table public.treatment_steps
  add constraint treatment_steps_appointment_fk foreign key (clinic_id, appointment_id)
  references public.appointments (clinic_id, id) on delete set null (appointment_id);

-- Keeps plans in step with appointments, whoever changes them (staff, WhatsApp, phone, import):
-- booked → sitting scheduled; completed → sitting done, later windows move with it; cancelled/no-show →
-- the sitting is pending again (and the follow-up engine picks it up).
create or replace function app.sync_treatment_step() returns trigger
language plpgsql
as $$
declare
  s record;
  anchor date;
  next_step record;
  open_steps int;
begin
  if new.treatment_step_id is null then
    return new;
  end if;
  select * into s from public.treatment_steps where id = new.treatment_step_id for update;
  if not found then
    return new;
  end if;

  if new.status in ('booked', 'confirmed', 'checked_in', 'in_chair') then
    if s.status <> 'done' then
      update public.treatment_steps set status = 'scheduled', appointment_id = new.id where id = s.id;
    end if;
    update public.treatment_plans set status = 'in_progress', accepted_at = coalesce(accepted_at, now())
      where id = s.plan_id and status in ('proposed', 'accepted');
  elsif new.status = 'completed' then
    update public.treatment_steps set status = 'done', appointment_id = new.id, done_at = coalesce(done_at, new.ends_at)
      where id = s.id;
    -- Move the windows of the sittings still to come, counting from this one.
    anchor := (new.ends_at at time zone (select timezone from public.clinics where id = new.clinic_id))::date;
    for next_step in
      select id, gap_min_days, gap_max_days from public.treatment_steps
      where plan_id = s.plan_id and seq > s.seq and status in ('pending', 'missed') order by seq
    loop
      update public.treatment_steps
        set expected_from = anchor + next_step.gap_min_days, expected_to = anchor + next_step.gap_max_days
        where id = next_step.id;
      anchor := anchor + next_step.gap_min_days;
    end loop;
    select count(*) into open_steps from public.treatment_steps
      where plan_id = s.plan_id and status not in ('done', 'skipped');
    update public.treatment_plans
      set status = case when open_steps = 0 then 'completed' else 'in_progress' end,
          completed_at = case when open_steps = 0 then now() else null end,
          accepted_at = coalesce(accepted_at, now())
      where id = s.plan_id and status <> 'abandoned';
  elsif new.status in ('cancelled', 'no_show') then
    update public.treatment_steps set status = 'pending', appointment_id = null
      where id = s.id and appointment_id = new.id and status = 'scheduled';
  end if;
  return new;
end
$$;

create trigger sync_treatment_step after insert or update of status, treatment_step_id on public.appointments
  for each row execute function app.sync_treatment_step();

-- ---------------------------------------------------------------------------------------------------
-- Estimates
-- ---------------------------------------------------------------------------------------------------

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  plan_id uuid,
  -- [{label, procedure_type_id?, tooth?, qty, amount_paise}]
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  total_paise bigint not null check (total_paise >= 0),
  emi_note text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),
  valid_until date not null,
  document_key text,
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, plan_id) references public.treatment_plans (clinic_id, id) on delete set null (plan_id)
);
create index estimates_open on public.estimates (clinic_id, status) where status = 'sent';

-- Deposits (optional, per procedure). Collected through a payment link; Phase 5 marks them paid.
alter table public.appointments
  add column deposit_paise bigint,
  add column deposit_status text check (deposit_status in ('requested', 'paid', 'waived')),
  add column deposit_link text;

-- ---------------------------------------------------------------------------------------------------
-- Follow-up engine (PLAN §5.3): ladders, runs, and the actions each run took
-- ---------------------------------------------------------------------------------------------------

create table public.followup_ladders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in ('treatment_continuity', 'estimate', 'no_show', 'unconfirmed', 'recall', 'aftercare_checkin')),
  -- [{after_hours, action: whatsapp|ai_call|staff_task, template?}]
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 10),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, kind)
);

create table public.followup_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  kind text not null,
  -- What is being chased: a treatment step, estimate or appointment.
  subject_type text not null check (subject_type in ('treatment_step', 'estimate', 'appointment')),
  subject_id uuid not null,
  patient_id uuid not null,
  phone text,
  -- Index of the next ladder step to run.
  step int not null default 0,
  next_at timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'stopped_success', 'stopped_optout', 'stopped_staff', 'stopped_obsolete', 'exhausted')),
  stop_reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Each subject is chased once per kind, however often the planner runs.
  unique (clinic_id, kind, subject_id),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete cascade
);
create index followup_runs_due on public.followup_runs (next_at) where status = 'active';

create table public.followup_actions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  run_id uuid not null,
  step int not null,
  action text not null check (action in ('whatsapp', 'ai_call', 'staff_task')),
  -- queued, skipped_hours, skipped_no_phone, skipped_optout, created
  result text not null,
  outbox_id uuid,
  task_id uuid,
  call_request jsonb,
  at timestamptz not null default now(),
  unique (run_id, step),
  foreign key (clinic_id, run_id) references public.followup_runs (clinic_id, id) on delete cascade
);

-- Outbound calls: why the call was placed (e.g. confirming an appointment).
alter table public.calls
  add column purpose text check (purpose in ('confirm_appointment')),
  add column subject_id uuid;

-- ---------------------------------------------------------------------------------------------------
-- Reactivation campaigns (promotional: owner approval + marketing consent, Build Prompt §7.7)
-- ---------------------------------------------------------------------------------------------------

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  name text not null,
  kind text not null default 'reactivation' check (kind in ('reactivation')),
  -- {"inactiveMonths": 12}
  audience jsonb not null default '{}'::jsonb,
  offer_text text,
  status text not null default 'draft'
    check (status in ('draft', 'awaiting_owner', 'approved', 'running', 'done', 'cancelled')),
  owner_approved_by uuid references public.users (id) on delete set null,
  owner_approved_at timestamptz,
  created_by uuid references public.users (id) on delete set null,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id)
);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  campaign_id uuid not null,
  patient_id uuid not null,
  phone text not null,
  outbox_id uuid,
  status text not null default 'queued' check (status in ('queued', 'skipped_no_consent', 'skipped_optout')),
  created_at timestamptz not null default now(),
  unique (campaign_id, patient_id),
  foreign key (clinic_id, campaign_id) references public.campaigns (clinic_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------------
-- Row-level security, grants, audit, timestamps
-- ---------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['treatment_templates', 'treatment_plans', 'treatment_steps', 'estimates', 'followup_ladders',
                           'followup_runs', 'followup_actions', 'campaigns', 'campaign_recipients'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update, delete on public.%I to app_user', t);
  end loop;
  foreach t in array array['treatment_templates', 'treatment_plans', 'treatment_steps', 'estimates', 'followup_ladders', 'campaigns'] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I
         for each row execute function app.audit_row()', t);
  end loop;
  foreach t in array array['treatment_templates', 'treatment_plans', 'treatment_steps', 'estimates', 'followup_ladders',
                           'followup_runs', 'campaigns'] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end
$$;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
    end if;
  end loop;
end
$$;
