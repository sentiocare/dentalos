-- 0010: the doctor's side of a visit. Case notes, the tooth chart and prescriptions, so the clinic keeps
-- one record instead of software at the desk and paper in the surgery. Written only by staff; the
-- assistant never reads or writes any of it.

-- Printed on every prescription (Indian Medical/Dental Council rules: name, qualification, registration).
alter table public.doctors add column registration_no text;
alter table public.doctors add column qualification text;

-- Case notes, one per visit (or without a visit, e.g. a phone consultation). Changes are kept in the
-- audit log, so an edited note always shows what it said before and who changed it.
create table public.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  patient_id uuid not null,
  appointment_id uuid,
  doctor_id uuid,
  complaint text,      -- what the patient came with, in their words
  findings text,       -- examination
  diagnosis text,
  treatment text,      -- what was done today
  advice text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, appointment_id),
  check (coalesce(complaint, findings, diagnosis, treatment, advice) is not null),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete set null (doctor_id)
);
create index clinical_notes_patient on public.clinical_notes (clinic_id, patient_id, created_at desc);

-- The tooth chart: what was found on each tooth (FDI numbers: 11–48 adult, 51–85 milk teeth). The chart
-- shows each tooth's latest finding; older ones stay as its history.
create table public.tooth_findings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  patient_id uuid not null,
  tooth smallint not null check (
    tooth between 11 and 18 or tooth between 21 and 28 or tooth between 31 and 38 or tooth between 41 and 48
    or tooth between 51 and 55 or tooth between 61 and 65 or tooth between 71 and 75 or tooth between 81 and 85),
  condition text not null check (condition in (
    'healthy', 'caries', 'filled', 'rct', 'crown', 'missing', 'implant', 'bridge', 'mobile', 'fractured',
    'impacted', 'to_extract', 'other')),
  surfaces text,       -- M, O, D, B, L when it matters (a filling, a cavity)
  note text,
  appointment_id uuid,
  recorded_by uuid references public.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id)
);
create index tooth_findings_patient on public.tooth_findings (clinic_id, patient_id, tooth, recorded_at desc);

-- Prescriptions are numbered like receipts: RX/2026-27/0001.
alter table public.doc_sequences drop constraint doc_sequences_kind_check;
alter table public.doc_sequences add constraint doc_sequences_kind_check
  check (kind in ('receipt', 'invoice', 'prescription'));

-- A doctor's usual prescriptions (after an extraction, after RCT…), so writing one is two taps.
create table public.prescription_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  doctor_id uuid,      -- null: for every doctor in the clinic
  name text not null check (length(trim(name)) > 0),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  advice text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete cascade
);

-- A prescription is a medical record: once written it is not changed. A mistake is corrected by writing a
-- new one and cancelling the old (it stays on file, marked cancelled).
create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  number text not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  appointment_id uuid,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  advice text,
  review_on date,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancel_reason text,
  pdf_key text,
  unique (clinic_id, id),
  unique (clinic_id, number),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id)
);
create index prescriptions_patient on public.prescriptions (clinic_id, patient_id, created_at desc);

create or replace function app.prescription_unchanged() returns trigger
language plpgsql
as $$
begin
  if new.items is distinct from old.items or new.advice is distinct from old.advice
     or new.doctor_id is distinct from old.doctor_id or new.patient_id is distinct from old.patient_id
     or new.number is distinct from old.number or new.created_at is distinct from old.created_at
     or new.review_on is distinct from old.review_on
     or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at) then
    raise exception 'A prescription cannot be changed; cancel it and write a new one' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger prescriptions_unchanged before update on public.prescriptions
  for each row execute function app.prescription_unchanged();
create trigger prescriptions_not_deleted before delete on public.prescriptions
  for each row execute function app.forbid_mutation();

do $$
declare
  t text;
begin
  foreach t in array array['clinical_notes', 'tooth_findings', 'prescription_templates', 'prescriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update on public.%I to app_user', t);
    execute format('create trigger audit after insert or update or delete on public.%I
                      for each row execute function app.audit_row()', t);
  end loop;
  foreach t in array array['clinical_notes', 'prescription_templates'] loop
    execute format('create trigger touch_updated_at before update on public.%I
                      for each row execute function app.touch_updated_at()', t);
  end loop;
end
$$;
grant delete on public.prescription_templates to app_user;

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
