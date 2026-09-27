-- 0005: phone calls answered by our own voice assistant (Phase 3).

-- ---------------------------------------------------------------------------------------------------
-- Calls: one row per phone call, whoever handled it (assistant, forwarded to the clinic, transferred).
-- ---------------------------------------------------------------------------------------------------

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  provider text not null,
  provider_call_id text not null,
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  from_phone text,
  to_phone text,
  patient_id uuid,
  -- How the call was handled when it arrived.
  route text check (route in ('assistant', 'forwarded_hours', 'forwarded_disabled', 'forwarded_unhealthy', 'forwarded_busy')),
  status text not null default 'ringing' check (status in ('ringing', 'in_progress', 'transferring', 'ended')),
  outcome text check (outcome in (
    'booked', 'rescheduled', 'cancelled', 'confirmed', 'information', 'transferred', 'transfer_failed',
    'callback', 'emergency', 'caller_hung_up', 'no_input', 'forwarded', 'error')),
  intents text[] not null default '{}',
  language text,
  -- Written by code from what happened (not by the language model).
  summary text,
  appointment_id uuid,
  -- Where to connect the caller after the assistant hands over, in ring order.
  transfer_kind text check (transfer_kind in ('staff', 'emergency')),
  transfer_numbers text[],
  transfer_status text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  recording_url text,
  recording_key text,
  -- Metering: speech-to-text audio ms, text-to-speech characters, LLM tokens, assistant turns.
  usage jsonb not null default '{}'::jsonb,
  cost_estimate_paise int,
  -- Assistant response times (ms from the caller stopping to the first reply audio): p50, p95, max.
  latency jsonb not null default '{}'::jsonb,
  -- The assistant's working memory for this call.
  state jsonb not null default '{}'::jsonb,
  -- Acceptance testing (PLAN Phase 3: 50 real test calls marked pass/fail by the tester).
  is_test boolean not null default false,
  test_result text check (test_result in ('pass', 'fail')),
  test_notes text,
  tested_by uuid references public.users (id) on delete set null,
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_call_id),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete set null (patient_id),
  foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id) on delete set null (appointment_id)
);
create index calls_recent on public.calls (clinic_id, started_at desc);

-- The transcript, turn by turn.
create table public.call_turns (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  call_id uuid not null,
  seq int not null,
  speaker text not null check (speaker in ('caller', 'assistant', 'system')),
  text text not null,
  language text,
  -- Assistant turns: ms from the end of the caller's speech to the first audio of the reply.
  latency_ms int,
  -- e.g. {emergency, barge_in, safety_blocked, stt_failed, dtmf}
  flags text[] not null default '{}',
  at timestamptz not null default now(),
  unique (call_id, seq),
  foreign key (clinic_id, call_id) references public.calls (clinic_id, id) on delete cascade
);

-- Tasks created from a call link back to it.
alter table public.tasks add column call_id uuid;

-- Call-flow requests from the telephony provider arrive before we know the clinic. Returns only the id.
create or replace function app.clinic_for_call(p_provider text, p_call_id text) returns uuid
language sql stable security definer set search_path = public, app
as $$ select clinic_id from public.calls where provider = p_provider and provider_call_id = p_call_id $$;

do $$
declare
  t text;
begin
  foreach t in array array['calls', 'call_turns'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update, delete on public.%I to app_user', t);
  end loop;
end
$$;
create trigger touch_updated_at before update on public.calls
  for each row execute function app.touch_updated_at();

grant execute on function app.clinic_for_call(text, text) to app_user;

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
