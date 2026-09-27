-- 0003: WhatsApp messaging, consent and opt-outs, the outbox, staff tasks.

-- ---------------------------------------------------------------------------------------------------
-- Channels: a clinic's WhatsApp Business number (and later its phone numbers)
-- ---------------------------------------------------------------------------------------------------

create table public.clinic_channels (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in ('whatsapp', 'voice')),
  -- WhatsApp: Meta's phone_number_id. Voice: the virtual number. Unique across all clinics, so an inbound
  -- webhook can be routed to exactly one clinic.
  external_id text not null,
  display_phone text not null,
  -- Provider credentials, encrypted by the application (AES-256-GCM, key in CHANNEL_SECRET_KEY).
  credentials_encrypted text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, external_id),
  unique (clinic_id, id)
);

-- Webhooks arrive before we know the clinic. This returns only the clinic id for a channel.
create or replace function app.clinic_for_channel(p_kind text, p_external_id text) returns uuid
language sql stable security definer set search_path = public, app
as $$ select clinic_id from public.clinic_channels where kind = p_kind and external_id = p_external_id and active $$;

-- ---------------------------------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  channel text not null check (channel in ('whatsapp')),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  patient_id uuid,
  -- 'bot': the assistant replies. 'human': staff took over; the assistant stays silent (Build Prompt §5.2).
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  taken_over_by uuid references public.users (id) on delete set null,
  taken_over_at timestamptz,
  -- WhatsApp's 24-hour customer-service window starts at the patient's last message.
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_preview text,
  unread_count int not null default 0,
  -- The assistant's working memory for this chat (current step, offered holds, language…).
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, channel, phone),
  unique (clinic_id, id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id) on delete set null (patient_id)
);
create index conversations_recent on public.conversations (clinic_id, last_message_at desc nulls last);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  conversation_id uuid not null,
  direction text not null check (direction in ('in', 'out')),
  author text not null check (author in ('patient', 'bot', 'staff', 'system')),
  author_user_id uuid references public.users (id) on delete set null,
  kind text not null check (kind in ('text', 'template', 'buttons', 'button_reply', 'audio', 'image', 'document', 'unsupported')),
  body text,
  payload jsonb not null default '{}'::jsonb,
  template_name text,
  provider_message_id text,
  status text not null check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'blocked')),
  error text,
  -- Set when the safety filter replaced an unsafe reply (for review; the original is never sent).
  safety_flag text,
  created_at timestamptz not null default now(),
  unique (clinic_id, id),
  foreign key (clinic_id, conversation_id) references public.conversations (clinic_id, id) on delete cascade
);
create index messages_thread on public.messages (conversation_id, created_at);
create unique index messages_provider_id on public.messages (provider_message_id) where provider_message_id is not null;

-- ---------------------------------------------------------------------------------------------------
-- Outbox: the only way anything is sent (PLAN §1). One row per intended message; dedupe_key makes every
-- scheduler idempotent (e.g. "appt:<id>:reminder_day_before:<starts_at>").
-- ---------------------------------------------------------------------------------------------------

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'sms')),
  to_phone text not null,
  patient_id uuid,
  conversation_id uuid,
  appointment_id uuid,
  category text not null check (category in ('service', 'transactional', 'promotional', 'critical')),
  purpose text not null,
  payload jsonb not null,
  dedupe_key text not null,
  not_before timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled', 'blocked')),
  attempts int not null default 0,
  last_error text,
  message_id uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (clinic_id, dedupe_key),
  unique (clinic_id, id)
);
create index outbox_due on public.outbox (not_before) where status = 'pending';

-- ---------------------------------------------------------------------------------------------------
-- Templates (WhatsApp messages outside the 24-hour window must use Meta-approved templates)
-- ---------------------------------------------------------------------------------------------------

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  purpose text not null,
  -- Name registered with Meta.
  name text not null check (name ~ '^[a-z0-9_]+$'),
  language text not null check (language in ('en', 'hi')),
  category text not null check (category in ('utility', 'marketing', 'authentication')),
  body text not null,
  -- Quick-reply buttons defined in the template, in order.
  buttons jsonb not null default '[]'::jsonb,
  meta_status text not null default 'draft' check (meta_status in ('draft', 'submitted', 'approved', 'rejected', 'paused')),
  -- Marketing and reactivation templates need the owner's approval (Build Prompt §7.7).
  owner_approved_by uuid references public.users (id) on delete set null,
  owner_approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, name, language),
  unique (clinic_id, purpose, language)
);

-- ---------------------------------------------------------------------------------------------------
-- Consent (append-only evidence) and opt-outs
-- ---------------------------------------------------------------------------------------------------

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  phone text not null,
  patient_id uuid,
  purpose text not null check (purpose in ('data_processing', 'reminders', 'marketing', 'call_recording')),
  channel text not null check (channel in ('whatsapp', 'voice', 'sms', 'in_person')),
  granted boolean not null,
  notice_version text not null,
  language text,
  captured_via text not null,
  evidence_message_id uuid,
  at timestamptz not null default now()
);
create index consents_lookup on public.consents (clinic_id, phone, purpose, at desc);
create trigger consents_append_only before update or delete on public.consents
  for each row execute function app.forbid_mutation();

create table public.opt_outs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  phone text not null,
  channel text not null check (channel in ('whatsapp', 'voice', 'sms', 'all')),
  category text not null check (category in ('promotional', 'transactional', 'all')),
  source text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index opt_outs_active on public.opt_outs (clinic_id, phone, channel, category) where revoked_at is null;

-- ---------------------------------------------------------------------------------------------------
-- Webhook dedupe (providers retry; each event is processed once). Not tenant data.
-- ---------------------------------------------------------------------------------------------------

create table public.webhook_events (
  provider text not null,
  event_id text not null,
  clinic_id uuid,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

-- Returns true the first time an event id is seen.
create or replace function app.claim_webhook_event(p_provider text, p_event_id text, p_clinic uuid) returns boolean
language plpgsql security definer set search_path = public, app
as $$
begin
  insert into public.webhook_events (provider, event_id, clinic_id) values (p_provider, p_event_id, p_clinic);
  return true;
exception when unique_violation then
  return false;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Staff tasks: callbacks, escalations, emergencies, follow-ups
-- ---------------------------------------------------------------------------------------------------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in ('callback', 'followup', 'escalation', 'emergency', 'complaint', 'unconfirmed', 'data_request')),
  priority text not null default 'normal' check (priority in ('critical', 'high', 'normal', 'low')),
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  title text not null,
  detail text,
  patient_id uuid,
  conversation_id uuid,
  appointment_id uuid,
  due_at timestamptz,
  assigned_user_id uuid references public.users (id) on delete set null,
  created_by text not null,
  resolved_by uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  -- One open task per purpose (e.g. "unconfirmed:<appointment>") even if a job runs twice.
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, dedupe_key)
);
create index tasks_open on public.tasks (clinic_id, status, priority, created_at desc);

-- ---------------------------------------------------------------------------------------------------
-- Row-level security, grants, audit
-- ---------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['clinic_channels', 'conversations', 'messages', 'outbox', 'message_templates', 'opt_outs', 'tasks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update, delete on public.%I to app_user', t);
  end loop;
  foreach t in array array['clinic_channels', 'message_templates', 'opt_outs', 'tasks'] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I
         for each row execute function app.audit_row()', t);
  end loop;
  foreach t in array array['clinic_channels', 'conversations', 'message_templates', 'tasks'] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end
$$;

-- Consents: readable and insertable, never changed.
alter table public.consents enable row level security;
create policy tenant_isolation on public.consents to app_user
  using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id());
grant select, insert on public.consents to app_user;

alter table public.webhook_events enable row level security;

grant execute on function app.clinic_for_channel(text, text) to app_user;
grant execute on function app.claim_webhook_event(text, text, uuid) to app_user;

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
