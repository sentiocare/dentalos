-- 0008: leads from ads and other sources, qualified by the assistant and converted with staff (Phase 6).

-- A clinic's Facebook Page, for lead-form webhooks (token stored encrypted, like the WhatsApp token).
alter table public.clinic_channels drop constraint clinic_channels_kind_check;
alter table public.clinic_channels add constraint clinic_channels_kind_check
  check (kind in ('whatsapp', 'voice', 'payments', 'meta_page'));

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  -- Where it came from: a Meta lead form, a Click-to-WhatsApp ad, or entered by staff.
  source text not null check (source in ('meta_form', 'ctwa', 'website', 'practo', 'justdial', 'walk_in', 'phone', 'referral', 'other')),
  external_id text,                          -- Meta leadgen id, or ctwa click id
  campaign text,
  ad text,
  name text,
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email text,
  -- What they want, in our words: pain, implant, braces, rct, cleaning, cosmetic, other.
  need text,
  -- When they want to come: now, week, month, exploring.
  timing text check (timing in ('now', 'week', 'month', 'exploring')),
  answers jsonb not null default '{}'::jsonb,   -- the form's own questions and answers, as asked
  score text not null default 'warm' check (score in ('hot', 'warm', 'cold')),
  stage text not null default 'new' check (stage in (
    'new', 'contacted', 'engaged', 'qualified', 'booked', 'visited', 'won', 'lost', 'unresponsive')),
  lost_reason text,
  assigned_to uuid references public.users (id) on delete set null,
  patient_id uuid,
  appointment_id uuid,
  won_value_paise bigint,
  first_contact_at timestamptz,      -- our first message or call (speed to lead)
  first_reply_at timestamptz,
  first_call_at timestamptz,         -- a person reached out by phone
  next_call_at timestamptz,          -- staff chose "call back later"
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, source, external_id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete set null (patient_id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id)
);
create index leads_open on public.leads (clinic_id, stage, created_at desc);
create index leads_phone on public.leads (clinic_id, phone);

-- What happened, in order: for the lead's timeline and for measuring response times.
create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  lead_id uuid not null,
  kind text not null check (kind in (
    'created', 'message', 'replied', 'qualified', 'call_task', 'called', 'booked', 'visited', 'won', 'lost', 'note', 'reopened')),
  detail jsonb not null default '{}'::jsonb,
  actor text not null default app.current_actor(),
  at timestamptz not null default now(),
  -- Keeps the order of things that happen in the same instant.
  seq bigserial,
  foreign key (clinic_id, lead_id) references public.leads (clinic_id, id) on delete cascade
);
create index lead_activities_lead on public.lead_activities (clinic_id, lead_id, at);

-- Page webhooks arrive for a Page id; this finds the clinic.
create or replace function app.clinic_for_page(p_page_id text) returns uuid
language sql stable security definer set search_path = public
as $$ select clinic_id from public.clinic_channels where kind = 'meta_page' and external_id = p_page_id and active limit 1 $$;
revoke all on function app.clinic_for_page(text) from public;
grant execute on function app.clinic_for_page(text) to app_user;

-- Leads are followed up by the same engine as everything else.
alter table public.followup_ladders drop constraint followup_ladders_kind_check;
alter table public.followup_ladders add constraint followup_ladders_kind_check
  check (kind in ('treatment_continuity', 'estimate', 'no_show', 'unconfirmed', 'recall', 'aftercare_checkin', 'dues', 'lead'));
alter table public.followup_runs drop constraint followup_runs_subject_type_check;
alter table public.followup_runs add constraint followup_runs_subject_type_check
  check (subject_type in ('treatment_step', 'estimate', 'appointment', 'ledger_entry', 'lead'));

do $$
declare
  t text;
begin
  foreach t in array array['leads', 'lead_activities'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update on public.%I to app_user', t);
  end loop;
end
$$;
grant usage on sequence public.lead_activities_seq_seq to app_user;
create trigger audit after insert or update or delete on public.leads for each row execute function app.audit_row();
create trigger touch_updated_at before update on public.leads for each row execute function app.touch_updated_at();

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

-- A lead is chased before there is any patient record.
alter table public.followup_runs alter column patient_id drop not null;

-- "Call this lead" tasks for staff, linked to the lead.
alter table public.tasks drop constraint tasks_kind_check;
alter table public.tasks add constraint tasks_kind_check
  check (kind in ('callback', 'followup', 'escalation', 'emergency', 'complaint', 'unconfirmed', 'data_request', 'lead'));
alter table public.tasks add column lead_id uuid;
alter table public.tasks add constraint tasks_lead_fk foreign key (clinic_id, lead_id)
  references public.leads (clinic_id, id) on delete set null (lead_id);
