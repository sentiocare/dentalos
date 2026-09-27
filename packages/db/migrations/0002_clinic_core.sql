-- 0002: clinic core. Tenancy, users and roles, audit log, clinic configuration, patients, scheduling.
--
-- Conventions (PLAN §4):
--   * every tenant table has clinic_id and a row-level security policy for app_user;
--   * child rows reference parents by (clinic_id, id) so a row can never point into another clinic;
--   * money is bigint paise; times are timestamptz; weekday 0 = Sunday … 6 = Saturday (JS getDay()).

-- ---------------------------------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------------------------------

create or replace function app.current_staff_role() returns text
language sql stable
as $$ select nullif(current_setting('app.role', true), '') $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Tenancy and users
-- ---------------------------------------------------------------------------------------------------

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  legal_name text,
  gstin text,
  phone text,
  email text,
  address text,
  city text,
  state text,
  pincode text,
  maps_url text,
  timezone text not null default 'Asia/Kolkata',
  default_language text not null default 'hi',
  languages text[] not null default '{hi,en}',
  -- Scheduling defaults
  slot_step_min int not null default 15 check (slot_step_min in (5, 10, 15, 20, 30)),
  hold_minutes int not null default 3 check (hold_minutes between 1 and 15),
  min_booking_lead_min int not null default 30 check (min_booking_lead_min >= 0),
  booking_horizon_days int not null default 60 check (booking_horizon_days between 1 and 365),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  name text not null,
  address text,
  phone text,
  maps_url text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id)
);
create unique index branches_one_default on public.branches (clinic_id) where is_default;

-- Staff accounts. id is the Supabase Auth user id. Not tenant-scoped: one person may work at two clinics.
create table public.users (
  id uuid primary key,
  name text,
  phone text unique,
  email text unique,
  ui_language text not null default 'en' check (ui_language in ('en', 'hi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clinic_memberships (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  user_id uuid references public.users (id) on delete cascade,
  -- Staff are invited by phone number; the membership is claimed on their first OTP login.
  invited_phone text,
  display_name text not null,
  role text not null check (role in ('owner', 'doctor', 'receptionist', 'assistant')),
  -- Per-person overrides of the role's default permissions, e.g. {"reports.revenue": false}.
  permissions jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or invited_phone is not null),
  unique (clinic_id, user_id),
  unique (clinic_id, invited_phone)
);

-- ---------------------------------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  clinic_id uuid not null,
  at timestamptz not null default now(),
  actor text not null,
  user_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb
);
create index audit_log_clinic_at on public.audit_log (clinic_id, at desc);
create index audit_log_entity on public.audit_log (clinic_id, entity, entity_id);
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function app.forbid_mutation();

-- Records every change to audited tables with who made it (app.actor / app.user_id from withClinic).
-- SECURITY DEFINER so app_user cannot write audit rows directly. TG_ARGV[0] names the clinic column.
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app
as $$
declare
  clinic_col text := coalesce(tg_argv[0], 'clinic_id');
  before_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  after_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  row_data jsonb := coalesce(after_row, before_row);
begin
  if tg_op = 'UPDATE' and (before_row - 'updated_at') = (after_row - 'updated_at') then
    return new;
  end if;
  insert into public.audit_log (clinic_id, actor, user_id, action, entity, entity_id, before, after)
  values (
    (row_data ->> clinic_col)::uuid,
    app.current_actor(),
    app.current_user_id(),
    lower(tg_op),
    tg_table_name,
    (row_data ->> 'id')::uuid,
    before_row,
    after_row
  );
  return coalesce(new, old);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Clinic configuration
-- ---------------------------------------------------------------------------------------------------

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  user_id uuid references public.users (id) on delete set null,
  name text not null check (length(trim(name)) > 0),
  speciality text,
  kind text not null default 'permanent' check (kind in ('permanent', 'visiting', 'on_call')),
  phone text,
  -- Emergency escalation order (Build Prompt §6.6). Null = not an emergency contact.
  emergency_order int check (emergency_order > 0),
  color text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id)
);

-- Visiting consultants are only bookable inside these windows.
create table public.doctor_visiting_schedules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  doctor_id uuid not null,
  branch_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null check (end_time > start_time),
  valid_from date,
  valid_to date check (valid_to is null or valid_from is null or valid_to >= valid_from),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete cascade,
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade
);

create table public.chairs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  name text not null,
  equipment text[] not null default '{}',
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade
);

create table public.procedure_types (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  name_hi text,
  -- Words patients use ("nas ka ilaaj", "RCT"), for matching speech and chat to a procedure.
  synonyms text[] not null default '{}',
  category text,
  default_duration_min int not null check (default_duration_min between 5 and 480),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 120),
  required_equipment text[] not null default '{}',
  -- Empty means any permanent doctor. Visiting consultants must be listed explicitly.
  allowed_doctor_ids uuid[] not null default '{}',
  price_min_paise bigint check (price_min_paise >= 0),
  price_max_paise bigint check (price_max_paise >= 0),
  -- Only public prices may be quoted by the assistant (Build Prompt §6.4).
  price_public boolean not null default true,
  gst_mode text not null default 'exempt' check (gst_mode in ('exempt', 'taxable')),
  gst_rate_bps int not null default 0 check (gst_rate_bps between 0 and 2800),
  sac_code text,
  is_consultation boolean not null default false,
  requires_lab_received boolean not null default false,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, code),
  check (price_min_paise is null or price_max_paise is null or price_min_paise <= price_max_paise),
  check (gst_mode = 'taxable' or gst_rate_bps = 0)
);

-- Opening hours. doctor_id null = the branch's hours (used for permanent doctors without their own).
-- Several rows on one weekday express split shifts, e.g. 10:00–14:00 and 17:00–21:00.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  doctor_id uuid,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null check (end_time > start_time),
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade,
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete cascade
);

create table public.breaks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  doctor_id uuid,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null check (end_time > start_time),
  label text,
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade,
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete cascade
);

-- Whole-day closures. branch_id null = every branch.
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  branch_id uuid,
  date date not null,
  name text not null,
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade
);
create unique index holidays_unique on public.holidays (clinic_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), date);

create table public.leaves (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  doctor_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  reason text,
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete cascade
);

-- Reserved emergency capacity on a chair, materialised ahead of time as occupancy rows.
create table public.emergency_slots (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  chair_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  duration_min int not null check (duration_min between 10 and 240),
  active boolean not null default true,
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id) on delete cascade,
  foreign key (clinic_id, chair_id) references public.chairs (clinic_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------------
-- Patients
-- ---------------------------------------------------------------------------------------------------

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- E.164. Not unique: family members often share one phone.
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  alt_phone text check (alt_phone is null or alt_phone ~ '^\+[1-9][0-9]{6,14}$'),
  dob date,
  -- When only an age is known ("umar 45"), store the birth year so the age stays correct over time.
  approx_birth_year int check (approx_birth_year between 1900 and 2100),
  gender text not null default 'unknown' check (gender in ('female', 'male', 'other', 'unknown')),
  language_pref text,
  source text,
  referred_by_patient_id uuid,
  address text,
  city text,
  notes text,
  file_number text,
  last_visit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (clinic_id, id),
  foreign key (clinic_id, referred_by_patient_id) references public.patients (clinic_id, id) on delete set null (referred_by_patient_id)
);
create index patients_phone on public.patients (clinic_id, phone) where deleted_at is null;
create index patients_alt_phone on public.patients (clinic_id, alt_phone) where deleted_at is null and alt_phone is not null;
create index patients_name_trgm on public.patients using gin (lower(name) gin_trgm_ops);
create index patients_file_number on public.patients (clinic_id, file_number) where file_number is not null;

create table public.patient_family_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  related_patient_id uuid not null,
  -- How related_patient is related to patient, e.g. 'mother', 'son', 'spouse'.
  relationship text not null,
  is_primary_contact boolean not null default false,
  created_at timestamptz not null default now(),
  check (patient_id <> related_patient_id),
  unique (patient_id, related_patient_id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete cascade,
  foreign key (clinic_id, related_patient_id) references public.patients (clinic_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------------------------------

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  chair_id uuid not null,
  procedure_type_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  -- Copied from the procedure at booking time; the chair and doctor stay blocked for this long after.
  buffer_min int not null default 0 check (buffer_min between 0 and 120),
  status text not null default 'booked'
    check (status in ('booked', 'confirmed', 'checked_in', 'in_chair', 'completed', 'cancelled', 'no_show')),
  source text not null default 'staff' check (source in ('staff', 'voice', 'whatsapp', 'import', 'walk_in')),
  notes text,
  cancel_reason text,
  booked_by_user_id uuid,
  -- Retried requests (flaky network, duplicate webhooks) with the same key never create a second booking.
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, idempotency_key),
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  foreign key (clinic_id, chair_id) references public.chairs (clinic_id, id),
  foreign key (clinic_id, procedure_type_id) references public.procedure_types (clinic_id, id)
);
create index appointments_day on public.appointments (clinic_id, starts_at);
create index appointments_patient on public.appointments (clinic_id, patient_id, starts_at desc);

-- A short reservation while a caller or chat user decides (Build Prompt §5.3).
create table public.slot_holds (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  branch_id uuid not null,
  doctor_id uuid not null,
  chair_id uuid not null,
  procedure_type_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  buffer_min int not null default 0,
  expires_at timestamptz not null,
  holder text not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  unique (clinic_id, id),
  foreign key (clinic_id, branch_id) references public.branches (clinic_id, id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  foreign key (clinic_id, chair_id) references public.chairs (clinic_id, id),
  foreign key (clinic_id, procedure_type_id) references public.procedure_types (clinic_id, id)
);
create index slot_holds_expiry on public.slot_holds (expires_at);

-- The single table that makes double booking impossible. Maintained only by triggers below;
-- app_user can read it but never write it.
create table public.resource_occupancy (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  resource_kind text not null check (resource_kind in ('doctor', 'chair')),
  resource_id uuid not null,
  occupied tstzrange not null check (not isempty(occupied)),
  source_kind text not null check (source_kind in ('appointment', 'hold', 'emergency_reserve')),
  source_id uuid not null,
  expires_at timestamptz,
  constraint no_double_booking exclude using gist (resource_id with =, occupied with &&),
  unique (source_id, resource_id, occupied)
);
create index resource_occupancy_source on public.resource_occupancy (source_id);
create index resource_occupancy_clinic_range on public.resource_occupancy using gist (clinic_id, occupied);

-- Removes expired holds that overlap a range on the given resources, so a stale hold never blocks a
-- booking even if the sweeper job has not run yet. Occupancy rows are the source of truth for blocking,
-- so expired hold occupancy is removed directly as well as the hold rows.
create or replace function app.purge_expired_holds(p_doctor uuid, p_chair uuid, p_range tstzrange)
returns void
language sql security definer set search_path = public, app
as $$
  delete from public.resource_occupancy o
  where o.source_kind = 'hold'
    and o.expires_at <= now()
    and o.resource_id in (p_doctor, p_chair)
    and o.occupied && p_range;
  delete from public.slot_holds h
  where h.expires_at <= now()
    and (h.doctor_id = p_doctor or h.chair_id = p_chair)
    and tstzrange(h.starts_at, h.ends_at + make_interval(mins => h.buffer_min)) && p_range;
$$;

create or replace function app.write_occupancy(
  p_clinic uuid, p_doctor uuid, p_chair uuid, p_range tstzrange, p_kind text, p_source uuid, p_expires timestamptz
) returns void
language plpgsql security definer set search_path = public, app
as $$
begin
  -- Lock the two resources in a fixed order. Without this, two bookings that each wait on the other's
  -- doctor/chair deadlock instead of one cleanly winning and the other getting "slot taken".
  perform pg_advisory_xact_lock(hashtextextended(least(p_doctor, p_chair)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(p_doctor, p_chair)::text, 0));
  perform app.purge_expired_holds(p_doctor, p_chair, p_range);
  insert into public.resource_occupancy (clinic_id, resource_kind, resource_id, occupied, source_kind, source_id, expires_at)
  values (p_clinic, 'doctor', p_doctor, p_range, p_kind, p_source, p_expires),
         (p_clinic, 'chair', p_chair, p_range, p_kind, p_source, p_expires);
end
$$;

create or replace function app.sync_appointment_occupancy() returns trigger
language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op = 'UPDATE'
     and new.starts_at = old.starts_at and new.ends_at = old.ends_at and new.buffer_min = old.buffer_min
     and new.doctor_id = old.doctor_id and new.chair_id = old.chair_id
     and (new.status in ('cancelled', 'no_show')) = (old.status in ('cancelled', 'no_show')) then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.resource_occupancy where source_id = old.id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.status not in ('cancelled', 'no_show') then
    perform app.write_occupancy(
      new.clinic_id, new.doctor_id, new.chair_id,
      tstzrange(new.starts_at, new.ends_at + make_interval(mins => new.buffer_min)),
      'appointment', new.id, null
    );
  end if;
  return coalesce(new, old);
end
$$;

create trigger appointments_occupancy after insert or update or delete on public.appointments
  for each row execute function app.sync_appointment_occupancy();

create or replace function app.sync_hold_occupancy() returns trigger
language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.resource_occupancy where source_id = old.id;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'slot holds cannot be modified; release and create a new hold';
  end if;
  perform app.write_occupancy(
    new.clinic_id, new.doctor_id, new.chair_id,
    tstzrange(new.starts_at, new.ends_at + make_interval(mins => new.buffer_min)),
    'hold', new.id, new.expires_at
  );
  return new;
end
$$;

create trigger slot_holds_occupancy after insert or update or delete on public.slot_holds
  for each row execute function app.sync_hold_occupancy();

-- Emergency reserves (Build Prompt §5.3): only staff or emergency routing may release them.
create or replace function app.materialize_emergency_reserve(
  p_clinic uuid, p_slot uuid, p_chair uuid, p_range tstzrange
) returns boolean
language plpgsql security definer set search_path = public, app
as $$
begin
  insert into public.resource_occupancy (clinic_id, resource_kind, resource_id, occupied, source_kind, source_id)
  values (p_clinic, 'chair', p_chair, p_range, 'emergency_reserve', p_slot)
  on conflict do nothing;
  return found;
exception when exclusion_violation then
  -- Already booked by staff; nothing to reserve.
  return false;
end
$$;

create or replace function app.release_emergency_reserve(p_chair uuid, p_range tstzrange) returns int
language plpgsql security definer set search_path = public, app
as $$
declare
  released int;
begin
  if coalesce(app.current_staff_role(), '') not in ('owner', 'doctor', 'receptionist', 'assistant', 'emergency') then
    raise exception 'only staff or emergency routing can release emergency slots' using errcode = '42501';
  end if;
  delete from public.resource_occupancy
  where clinic_id = app.current_clinic_id()
    and resource_id = p_chair
    and source_kind = 'emergency_reserve'
    and occupied && p_range;
  get diagnostics released = row_count;
  return released;
end
$$;

create or replace function app.sweep_expired_holds() returns int
language plpgsql security definer set search_path = public, app
as $$
declare
  n int;
begin
  delete from public.slot_holds where expires_at <= now();
  get diagnostics n = row_count;
  -- Past emergency reserves are no longer useful.
  delete from public.resource_occupancy where source_kind = 'emergency_reserve' and upper(occupied) < now();
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Login and membership lookup (runs before a clinic is chosen, so it cannot rely on clinic RLS)
-- ---------------------------------------------------------------------------------------------------

-- Creates the user row on first login and claims memberships the owner created for this phone number.
create or replace function app.ensure_user(p_phone text, p_email text, p_name text) returns void
language plpgsql security definer set search_path = public, app
as $$
declare
  uid uuid := app.current_user_id();
begin
  if uid is null then
    raise exception 'app.user_id is not set';
  end if;
  insert into public.users (id, phone, email, name)
  values (uid, p_phone, p_email, p_name)
  on conflict (id) do update
    set phone = coalesce(excluded.phone, public.users.phone),
        email = coalesce(excluded.email, public.users.email);
  if p_phone is not null then
    update public.clinic_memberships
    set user_id = uid
    where invited_phone = p_phone and user_id is null;
  end if;
end
$$;

create or replace function app.my_memberships()
returns table (clinic_id uuid, clinic_name text, role text, permissions jsonb, display_name text)
language sql stable security definer set search_path = public, app
as $$
  select m.clinic_id, c.name, m.role, m.permissions, m.display_name
  from public.clinic_memberships m
  join public.clinics c on c.id = m.clinic_id
  where m.user_id = app.current_user_id() and m.active
  order by c.name;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Row-level security, grants, audit and updated_at triggers
-- ---------------------------------------------------------------------------------------------------

do $$
declare
  t text;
  tenant_tables text[] := array[
    'branches', 'clinic_memberships', 'doctors', 'doctor_visiting_schedules', 'chairs', 'procedure_types',
    'working_hours', 'breaks', 'holidays', 'leaves', 'emergency_slots', 'patients', 'patient_family_links',
    'appointments', 'slot_holds'
  ];
  audited text[] := array[
    'branches', 'clinic_memberships', 'doctors', 'doctor_visiting_schedules', 'chairs', 'procedure_types',
    'working_hours', 'breaks', 'holidays', 'leaves', 'emergency_slots', 'patients', 'patient_family_links',
    'appointments'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update, delete on public.%I to app_user', t);
  end loop;

  foreach t in array audited loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I
         for each row execute function app.audit_row()', t);
  end loop;

  foreach t in array array['clinics', 'branches', 'users', 'clinic_memberships', 'doctors', 'chairs',
                           'procedure_types', 'patients', 'appointments'] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end
$$;

-- clinics: a clinic sees only itself. Creating clinics is a Sentio admin action (not app_user).
alter table public.clinics enable row level security;
create policy tenant_isolation on public.clinics to app_user
  using (id = app.current_clinic_id()) with check (id = app.current_clinic_id());
grant select, update on public.clinics to app_user;
create trigger audit after update on public.clinics
  for each row execute function app.audit_row('id');

-- users: yourself, and colleagues in the current clinic.
alter table public.users enable row level security;
create policy self_and_colleagues on public.users to app_user
  using (
    id = app.current_user_id()
    or id in (select user_id from public.clinic_memberships where clinic_id = app.current_clinic_id())
  )
  with check (id = app.current_user_id());
grant select, update on public.users to app_user;

-- audit_log: readable per clinic, written only by the audit trigger.
alter table public.audit_log enable row level security;
create policy tenant_isolation on public.audit_log to app_user using (clinic_id = app.current_clinic_id());
grant select on public.audit_log to app_user;

-- resource_occupancy: readable per clinic (for availability), written only by triggers.
alter table public.resource_occupancy enable row level security;
create policy tenant_isolation on public.resource_occupancy to app_user using (clinic_id = app.current_clinic_id());
grant select on public.resource_occupancy to app_user;

grant execute on function app.current_staff_role() to app_user;
grant execute on function app.ensure_user(text, text, text) to app_user;
grant execute on function app.my_memberships() to app_user;
grant execute on function app.release_emergency_reserve(uuid, tstzrange) to app_user;

-- Internal functions are not callable by the app directly.
revoke execute on function app.purge_expired_holds(uuid, uuid, tstzrange) from public;
revoke execute on function app.write_occupancy(uuid, uuid, uuid, tstzrange, text, uuid, timestamptz) from public;
revoke execute on function app.materialize_emergency_reserve(uuid, uuid, uuid, tstzrange) from public;
revoke execute on function app.sweep_expired_holds() from public;
revoke execute on function app.audit_row() from public;

-- Supabase exposes the public schema through its REST API to the anon and authenticated roles and grants
-- them table access by default. Our data is only reached through our API, so remove that path entirely.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end
$$;
