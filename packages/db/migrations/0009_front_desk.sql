-- 0009: the front desk's day. Everyone who arrives gets a token, walk-ins and booked patients alike, and
-- waits in one queue until the doctor sees them.

create table public.queue_entries (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  -- The clinic's local date; tokens start again from 1 each day.
  day date not null,
  token int not null check (token > 0),
  patient_id uuid not null,
  -- Set for booked patients from check-in, and for walk-ins once they are sent in to the doctor.
  appointment_id uuid,
  -- A walk-in's preferred doctor (null: whoever is free) and what they came for.
  doctor_id uuid,
  procedure_type_id uuid,
  note text,
  status text not null default 'waiting' check (status in ('waiting', 'with_doctor', 'done', 'left')),
  arrived_at timestamptz not null default now(),
  called_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, day, token),
  unique (clinic_id, appointment_id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id),
  foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id) on delete set null (doctor_id),
  foreign key (clinic_id, procedure_type_id) references public.procedure_types (clinic_id, id) on delete set null (procedure_type_id)
);
create index queue_entries_day on public.queue_entries (clinic_id, day, status);

-- The next token for a clinic's day. The advisory lock makes two desks adding at once get 7 and 8, not 7 twice.
create or replace function app.next_token(p_clinic uuid, p_day date) returns int
language plpgsql
as $$
declare
  n int;
begin
  perform pg_advisory_xact_lock(hashtext('token:' || p_clinic::text || ':' || p_day::text));
  select coalesce(max(token), 0) + 1 into n from public.queue_entries where clinic_id = p_clinic and day = p_day;
  return n;
end
$$;

-- The queue follows the appointment, whoever changes it (desk, doctor, calendar): arrived → waiting with a
-- token; in chair → with the doctor; done → done; no-show or cancelled → left.
create or replace function app.queue_follows_appointment() returns trigger
language plpgsql
as $$
declare
  v_day date;
  v_status text;
begin
  if new.status = old.status then
    return new;
  end if;
  v_status := case new.status
    when 'checked_in' then 'waiting'
    when 'in_chair' then 'with_doctor'
    when 'completed' then 'done'
    when 'no_show' then 'left'
    when 'cancelled' then 'left'
    else null end;
  if v_status is null then
    return new;
  end if;
  update public.queue_entries set
    status = v_status,
    called_at = case when v_status = 'with_doctor' then coalesce(called_at, now()) else called_at end,
    finished_at = case when v_status in ('done', 'left') then now() else null end
  where clinic_id = new.clinic_id and appointment_id = new.id;
  if not found and new.status in ('checked_in', 'in_chair') then
    select (now() at time zone c.timezone)::date into v_day from public.clinics c where c.id = new.clinic_id;
    insert into public.queue_entries (clinic_id, day, token, patient_id, appointment_id, doctor_id,
                                      procedure_type_id, status, called_at)
    values (new.clinic_id, v_day, app.next_token(new.clinic_id, v_day), new.patient_id, new.id, new.doctor_id,
            new.procedure_type_id, v_status, case when v_status = 'with_doctor' then now() end);
  end if;
  return new;
end
$$;
create trigger queue_follows_appointment after update of status on public.appointments
  for each row execute function app.queue_follows_appointment();

alter table public.queue_entries enable row level security;
create policy tenant_isolation on public.queue_entries to app_user
  using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id());
grant select, insert, update on public.queue_entries to app_user;
grant execute on function app.next_token(uuid, date) to app_user;
create trigger audit after insert or update or delete on public.queue_entries for each row execute function app.audit_row();
create trigger touch_updated_at before update on public.queue_entries for each row execute function app.touch_updated_at();

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
