-- 0012: tell Meta which ad leads turned into patients (Conversions API), so the clinic's ads find more people
-- like the ones who booked and came, not just more form fills. Also records leads WhatsApp can't reach.

-- One row per lead and stage reached, sent to Meta once.
create table public.lead_meta_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  lead_id uuid not null,
  stage text not null check (stage in ('qualified', 'booked', 'visited', 'won')),
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, stage),
  foreign key (clinic_id, lead_id) references public.leads (clinic_id, id) on delete cascade
);
create index lead_meta_events_pending on public.lead_meta_events (clinic_id, status) where status = 'pending';

alter table public.lead_meta_events enable row level security;
create policy tenant_isolation on public.lead_meta_events to app_user
  using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id());
grant select, insert, update on public.lead_meta_events to app_user;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.lead_meta_events from %I', r);
    end if;
  end loop;
end
$$;

-- "WhatsApp could not deliver to this number": the lead needs a phone call instead.
alter table public.lead_activities drop constraint lead_activities_kind_check;
alter table public.lead_activities add constraint lead_activities_kind_check check (kind in (
  'created', 'message', 'replied', 'qualified', 'call_task', 'called', 'booked', 'visited', 'won', 'lost', 'note',
  'reopened', 'unreachable'));
