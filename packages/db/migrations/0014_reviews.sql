-- 0014: after a visit, ask every patient how it went, once. Happy patients get the clinic's Google review link;
-- unhappy ones reach the doctor first (and still see the link: Google forbids asking only happy patients).

alter table public.followup_ladders drop constraint followup_ladders_kind_check;
alter table public.followup_ladders add constraint followup_ladders_kind_check
  check (kind in ('treatment_continuity', 'estimate', 'no_show', 'unconfirmed', 'recall', 'aftercare_checkin', 'dues', 'lead', 'review'));

-- What the patient answered: one row per visit (a second tap changes it).
create table public.visit_feedback (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  appointment_id uuid not null,
  patient_id uuid not null,
  rating text not null check (rating in ('good', 'bad')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, appointment_id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete cascade,
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete cascade
);

alter table public.visit_feedback enable row level security;
create policy tenant_isolation on public.visit_feedback to app_user
  using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id());
grant select, insert, update on public.visit_feedback to app_user;
create trigger touch_updated_at before update on public.visit_feedback for each row execute function app.touch_updated_at();

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.visit_feedback from %I', r);
    end if;
  end loop;
end
$$;
