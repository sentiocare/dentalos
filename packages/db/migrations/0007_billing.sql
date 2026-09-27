-- 0007: money (Build Prompt §4, PLAN §4.6, §4.7, §5.6).
-- Part 1, the clinic's own money: patient ledger, payment links, receipts and invoices, numbered per
-- financial year.
-- Part 2, what the clinic pays Sentio: a perpetual license, the prepaid usage wallet (usage ledger, credits,
-- rate cards), mandates and recharges, Sentio's tax invoices, and provider reconciliation.

-- ---------------------------------------------------------------------------------------------------
-- Document numbers: one series per clinic, kind and financial year (April–March), no gaps.
-- A row lock on the sequence row makes two receipts at the same moment get different numbers.
-- ---------------------------------------------------------------------------------------------------

create table public.doc_sequences (
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in ('receipt', 'invoice')),
  fy text not null,                       -- e.g. '2026-27'
  next_no int not null default 1,
  primary key (clinic_id, kind, fy)
);

create or replace function app.next_doc_number(p_kind text, p_fy text) returns int
language plpgsql
as $$
declare
  n int;
begin
  insert into public.doc_sequences (clinic_id, kind, fy) values (app.current_clinic_id(), p_kind, p_fy)
    on conflict do nothing;
  update public.doc_sequences set next_no = next_no + 1
    where clinic_id = app.current_clinic_id() and kind = p_kind and fy = p_fy
    returning next_no - 1 into n;
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Patient ledger (append-only). A mistake is corrected by a reversing entry, never by editing.
-- Balance owed by the patient = charges + refunds - payments ± adjustments (adjustment amounts are signed:
-- a discount is negative).
-- ---------------------------------------------------------------------------------------------------

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  number text not null,
  fy text not null,
  patient_id uuid not null,
  -- 'tax_invoice' when any line carries GST, otherwise 'bill_of_supply' (most dental care is exempt).
  doc_type text not null check (doc_type in ('tax_invoice', 'bill_of_supply')),
  lines jsonb not null,                   -- [{description, sac, qty, taxablePaise, gstRateBps, gstPaise, totalPaise}]
  taxable_paise bigint not null,
  gst_paise bigint not null,
  total_paise bigint not null,
  pdf_key text,
  issued_at timestamptz not null default now(),
  created_by uuid references public.users (id) on delete set null,
  unique (clinic_id, id),
  unique (clinic_id, number),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id)
);

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  patient_id uuid not null,
  appointment_id uuid,
  purpose text not null check (purpose in ('dues', 'deposit', 'other')),
  amount_paise bigint not null check (amount_paise > 0),
  provider text not null,
  provider_link_id text not null,
  url text not null,
  status text not null default 'created' check (status in ('created', 'paid', 'expired', 'cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (provider, provider_link_id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id)
);

create table public.patient_ledger (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  patient_id uuid not null,
  kind text not null check (kind in ('charge', 'payment', 'adjustment', 'refund')),
  amount_paise bigint not null,
  method text check (method in ('cash', 'upi', 'card', 'bank', 'gateway_link')),
  description text not null,
  reference text,
  appointment_id uuid,
  treatment_step_id uuid,
  procedure_type_id uuid,
  -- GST on a charge (per procedure, PLAN §4.7); amount_paise already includes it.
  gst_rate_bps int not null default 0 check (gst_rate_bps between 0 and 2800),
  gst_paise bigint not null default 0 check (gst_paise >= 0),
  invoice_id uuid,
  payment_link_id uuid,
  -- The entry this one cancels out (a reversal).
  reverses_id uuid,
  -- Same key → same entry: offline replays, webhook retries.
  dedupe_key text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (clinic_id, id),
  unique (clinic_id, dedupe_key),
  unique (clinic_id, reverses_id),
  check (kind = 'adjustment' or amount_paise > 0),
  check (kind in ('payment', 'refund') = (method is not null)),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, invoice_id) references public.invoices (clinic_id, id),
  foreign key (clinic_id, payment_link_id) references public.payment_links (clinic_id, id),
  foreign key (clinic_id, reverses_id) references public.patient_ledger (clinic_id, id)
);
create index patient_ledger_patient on public.patient_ledger (clinic_id, patient_id, created_at);
create index patient_ledger_day on public.patient_ledger (clinic_id, created_at) where kind = 'payment';
create trigger patient_ledger_append_only before update or delete on public.patient_ledger
  for each row execute function app.forbid_mutation();

-- Invoicing a charge is the one change allowed after the fact: it goes in a side table, so the ledger
-- itself stays append-only.
create table public.invoice_charges (
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  invoice_id uuid not null,
  ledger_id uuid not null,
  primary key (clinic_id, ledger_id),
  foreign key (clinic_id, invoice_id) references public.invoices (clinic_id, id),
  foreign key (clinic_id, ledger_id) references public.patient_ledger (clinic_id, id)
);

create view public.patient_balances with (security_invoker = true) as
  select clinic_id, patient_id,
         sum(case kind when 'payment' then -amount_paise else amount_paise end)::bigint as balance_paise,
         max(created_at) filter (where kind = 'payment') as last_payment_at,
         min(created_at) filter (where kind = 'charge') as first_charge_at
  from public.patient_ledger group by clinic_id, patient_id;
grant select on public.patient_balances to app_user;

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  number text not null,
  fy text not null,
  patient_id uuid not null,
  ledger_id uuid not null,
  amount_paise bigint not null,
  method text not null,
  pdf_key text,
  issued_at timestamptz not null default now(),
  -- Set when the payment was entered by mistake and reversed; the number is never reused.
  cancelled_at timestamptz,
  unique (clinic_id, number),
  unique (clinic_id, ledger_id),
  foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  foreign key (clinic_id, ledger_id) references public.patient_ledger (clinic_id, id)
);

-- Webhooks for a clinic's own payment gateway arrive at one URL per clinic; this finds the link.
create or replace function app.clinic_for_payment_link(p_link_id uuid) returns uuid
language sql stable security definer set search_path = public
as $$ select clinic_id from public.payment_links where id = p_link_id $$;
revoke all on function app.clinic_for_payment_link(uuid) from public;
grant execute on function app.clinic_for_payment_link(uuid) to app_user;

-- A clinic's own payment gateway account is a channel like its WhatsApp number (keys stored encrypted).
alter table public.clinic_channels drop constraint clinic_channels_kind_check;
alter table public.clinic_channels add constraint clinic_channels_kind_check check (kind in ('whatsapp', 'voice', 'payments'));

-- Dues reminders use the follow-up engine.
alter table public.followup_ladders drop constraint followup_ladders_kind_check;
alter table public.followup_ladders add constraint followup_ladders_kind_check
  check (kind in ('treatment_continuity', 'estimate', 'no_show', 'unconfirmed', 'recall', 'aftercare_checkin', 'dues'));
alter table public.followup_runs drop constraint followup_runs_subject_type_check;
alter table public.followup_runs add constraint followup_runs_subject_type_check
  check (subject_type in ('treatment_step', 'estimate', 'appointment', 'ledger_entry'));

-- ---------------------------------------------------------------------------------------------------
-- Sentio billing: license, wallet, usage.
-- Clinics can read their own rows; only system code (the worker and metering, as the database owner or
-- through the functions below) writes them.
-- ---------------------------------------------------------------------------------------------------

create table public.platform_admins (
  user_id uuid primary key references public.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  sku text not null,
  price_paise bigint not null check (price_paise >= 0),
  gst_paise bigint not null default 0,
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'cancelled')),
  provider_checkout_id text,
  checkout_url text,
  provider_payment_id text unique,
  purchased_at timestamptz,
  -- The product keeps working after this date; only updates and support stop (perpetual license).
  updates_support_until date,
  invoice_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index licenses_clinic on public.licenses (clinic_id);

create table public.wallets (
  clinic_id uuid primary key references public.clinics (id) on delete cascade,
  -- Cached; the source of truth is credits minus usage (see app.wallet_ledger_balance).
  balance_paise bigint not null default 0,
  threshold_paise bigint not null default 50000,            -- "low" below ₹500
  recharge_amount_paise bigint not null default 200000 check (recharge_amount_paise between 10000 and 1500000),
  -- How far below zero transactional messages may still go (grace) before everything pauses.
  grace_paise bigint not null default 20000 check (grace_paise >= 0),
  monthly_cap_paise bigint check (monthly_cap_paise > 0),
  auto_recharge boolean not null default true,
  -- Off until Sentio switches billing on for the clinic (license paid, or by hand for a pilot). While off,
  -- usage is still metered and shown, but nothing is paused.
  enforced boolean not null default false,
  state text not null default 'active' check (state in ('active', 'low', 'grace', 'suspended')),
  state_since timestamptz not null default now(),
  -- The last state the owner was told about (low / paused), so each change is announced once.
  notified_state text,
  updated_at timestamptz not null default now()
);

create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references public.clinics (id) on delete cascade,   -- null: the default for everyone
  kind text not null,
  unit text not null,
  -- What the provider charges us per unit, and what we add. Fractions of a paisa are allowed here.
  provider_cost_paise numeric(14, 4) not null check (provider_cost_paise >= 0),
  margin_pct numeric(6, 2) not null default 0 check (margin_pct >= 0),
  margin_paise numeric(14, 4) not null default 0 check (margin_paise >= 0),
  effective_from timestamptz not null default '2020-01-01',
  created_at timestamptz not null default now()
);
create unique index rate_cards_one on public.rate_cards (coalesce(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, effective_from);

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in (
    'telephony_min', 'stt_sec', 'tts_char', 'llm_input_token', 'llm_output_token',
    'wa_utility', 'wa_marketing', 'wa_authentication', 'sms_segment')),
  quantity numeric(14, 3) not null check (quantity >= 0),
  provider_cost_paise numeric(14, 4) not null,              -- exact, for reconciliation
  margin_paise numeric(14, 4) not null,
  total_paise bigint not null check (total_paise >= 0),     -- what the wallet is charged, rounded up
  ref_type text not null,                                   -- 'call', 'message', 'outbox', 'sms'
  ref text not null,
  at timestamptz not null default now(),
  unique (clinic_id, kind, ref)
);
create index usage_ledger_month on public.usage_ledger (clinic_id, at);
create trigger usage_ledger_append_only before update or delete on public.usage_ledger
  for each row execute function app.forbid_mutation();

create table public.wallet_credits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  kind text not null check (kind in ('recharge', 'topup', 'adjustment', 'opening')),
  amount_paise bigint not null,
  recharge_id uuid,
  note text,
  created_by text not null default app.current_actor(),
  at timestamptz not null default now(),
  unique (recharge_id)
);
create trigger wallet_credits_append_only before update or delete on public.wallet_credits
  for each row execute function app.forbid_mutation();

-- Wallet state from a balance (PLAN §5.6): active → low (≤ threshold) → grace (≤ 0) → suspended (≤ -grace).
create or replace function app.wallet_state(balance bigint, threshold bigint, grace bigint) returns text
language sql immutable
as $$
  select case
    when balance > threshold then 'active'
    when balance > 0 then 'low'
    when balance > -grace then 'grace'
    else 'suspended' end
$$;

-- Keeps the cached balance and state in step with every usage and credit row. Runs as the table owner
-- so metering code needs no update right on wallets.
create or replace function app.apply_wallet_delta() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  delta bigint;
begin
  -- Separate branches: a record only has the fields of its own table.
  if tg_table_name = 'usage_ledger' then
    delta := -new.total_paise;
  else
    delta := new.amount_paise;
  end if;
  insert into public.wallets (clinic_id) values (new.clinic_id) on conflict do nothing;
  update public.wallets w
     set balance_paise = w.balance_paise + delta,
         state = app.wallet_state(w.balance_paise + delta, w.threshold_paise, w.grace_paise),
         state_since = case when w.state = app.wallet_state(w.balance_paise + delta, w.threshold_paise, w.grace_paise)
                            then w.state_since else now() end,
         updated_at = now()
   where w.clinic_id = new.clinic_id;
  return new;
end
$$;
create trigger wallet_delta after insert on public.usage_ledger for each row execute function app.apply_wallet_delta();
create trigger wallet_delta after insert on public.wallet_credits for each row execute function app.apply_wallet_delta();

-- The ledger truth, for the reconciliation check of the cached balance.
create or replace function app.wallet_ledger_balance(p_clinic uuid) returns bigint
language sql stable
as $$
  select coalesce((select sum(amount_paise) from public.wallet_credits where clinic_id = p_clinic), 0)::bigint
       - coalesce((select sum(total_paise) from public.usage_ledger where clinic_id = p_clinic), 0)::bigint
$$;

-- Settings changes (threshold, grace) re-derive the state.
create or replace function app.wallet_restate() returns trigger
language plpgsql
as $$
begin
  new.state := app.wallet_state(new.balance_paise, new.threshold_paise, new.grace_paise);
  if new.state is distinct from old.state then new.state_since := now(); end if;
  return new;
end
$$;
create trigger wallet_restate before update of threshold_paise, grace_paise on public.wallets
  for each row execute function app.wallet_restate();

create table public.mandates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  provider text not null,
  -- Known once the clinic has authorised it on the gateway's page.
  provider_mandate_id text,
  provider_customer_id text,
  registration_url text,
  -- Who the gateway charges (recurring debits need the payer's contact).
  payer_phone text not null,
  payer_email text,
  method text check (method in ('upi_autopay', 'card', 'enach')),
  max_amount_paise bigint not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'paused', 'cancelled', 'failed')),
  consecutive_failures int not null default 0,
  last_failure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_mandate_id),
  unique (provider, provider_customer_id)
);

create table public.recharges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  -- 'mandate': auto-debit after a pre-debit notice; 'link': the owner pays a link (above ₹15,000, after
  -- a failed debit, or by choice).
  via text not null check (via in ('mandate', 'link')),
  mandate_id uuid references public.mandates (id),
  amount_paise bigint not null check (amount_paise > 0),
  gst_paise bigint not null default 0,
  status text not null default 'notified' check (status in ('notified', 'debiting', 'link_sent', 'paid', 'failed', 'cancelled')),
  pre_debit_notified_at timestamptz,
  debit_after timestamptz,
  link_url text,
  provider_link_id text,
  provider_payment_id text unique,
  failure text,
  paid_at timestamptz,
  invoice_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (via = 'link' or (mandate_id is not null and debit_after is not null
                          and debit_after >= pre_debit_notified_at + interval '24 hours'))
);
create index recharges_open on public.recharges (clinic_id) where status in ('notified', 'debiting', 'link_sent');

-- Sentio's GST invoices to clinics (license and recharges): one series per financial year across all clinics.
create table public.sentio_invoice_sequences (
  fy text primary key,
  next_no int not null default 1
);

create table public.sentio_invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  number text not null unique,
  fy text not null,
  kind text not null check (kind in ('license', 'recharge')),
  lines jsonb not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null default 0,
  sgst_paise bigint not null default 0,
  igst_paise bigint not null default 0,
  total_paise bigint not null,
  place_of_supply text,
  buyer jsonb not null,                     -- legal name, GSTIN, address at the time of the invoice
  pdf_key text,
  issued_at timestamptz not null default now()
);

-- Nightly comparison of our usage ledger with what providers say they charged us.
create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  provider text not null,
  our_cost_paise numeric(16, 4) not null,
  provider_cost_paise numeric(16, 4),
  drift_pct numeric(8, 3),
  status text not null check (status in ('ok', 'drift', 'unavailable')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (period_start, period_end, provider)
);

-- Calls forwarded because the wallet is paused (PLAN §5.6).
alter table public.calls drop constraint calls_route_check;
alter table public.calls add constraint calls_route_check
  check (route in ('assistant', 'forwarded_hours', 'forwarded_disabled', 'forwarded_unhealthy', 'forwarded_busy', 'forwarded_wallet'));

-- Every existing and new clinic has a wallet.
insert into public.wallets (clinic_id) select id from public.clinics on conflict do nothing;
create or replace function app.create_wallet() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.wallets (clinic_id) values (new.id) on conflict do nothing;
  return new;
end
$$;
create trigger create_wallet after insert on public.clinics for each row execute function app.create_wallet();

-- ---------------------------------------------------------------------------------------------------
-- Row-level security, grants, audit, timestamps
-- ---------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  -- Clinic data the app reads and writes.
  foreach t in array array['doc_sequences', 'invoices', 'payment_links', 'patient_ledger', 'invoice_charges', 'receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on public.%I to app_user
         using (clinic_id = app.current_clinic_id()) with check (clinic_id = app.current_clinic_id())', t);
    execute format('grant select, insert, update on public.%I to app_user', t);
  end loop;
  -- Sentio billing: clinics read their own; writes happen as the owner role (worker, admin) or via
  -- security-definer functions. Usage rows are inserted by metering inside the clinic's context.
  foreach t in array array['licenses', 'wallets', 'usage_ledger', 'wallet_credits', 'mandates', 'recharges', 'sentio_invoices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy tenant_read on public.%I for select to app_user using (clinic_id = app.current_clinic_id())', t);
    execute format('grant select on public.%I to app_user', t);
  end loop;
  execute 'create policy tenant_insert on public.usage_ledger for insert to app_user with check (clinic_id = app.current_clinic_id())';
  execute 'grant insert on public.usage_ledger to app_user';
  -- The owner changes their own wallet settings (not the balance: that column is not granted).
  execute 'create policy tenant_settings on public.wallets for update to app_user using (clinic_id = app.current_clinic_id())';
  execute 'grant update (threshold_paise, recharge_amount_paise, monthly_cap_paise, auto_recharge) on public.wallets to app_user';
  -- Rate cards: read-only for everyone (defaults and the clinic's own).
  alter table public.rate_cards enable row level security;
  create policy read_rates on public.rate_cards for select to app_user
    using (clinic_id is null or clinic_id = app.current_clinic_id());
  grant select on public.rate_cards to app_user;
  alter table public.platform_admins enable row level security;
  alter table public.reconciliation_runs enable row level security;
  alter table public.sentio_invoice_sequences enable row level security;

  foreach t in array array['invoices', 'payment_links', 'receipts', 'licenses', 'mandates', 'recharges'] loop
    execute format(
      'create trigger audit after insert or update or delete on public.%I
         for each row execute function app.audit_row()', t);
  end loop;
  foreach t in array array['payment_links', 'licenses', 'mandates', 'recharges'] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end
$$;

grant execute on function app.next_doc_number(text, text) to app_user;

-- A top-up link for the clinic in context (clinics cannot write recharges directly).
create or replace function app.record_topup_link(p_id uuid, p_clinic uuid, p_amount bigint, p_url text, p_link text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_clinic is distinct from app.current_clinic_id() then
    raise exception 'wrong clinic' using errcode = '42501';
  end if;
  insert into public.recharges (id, clinic_id, via, amount_paise, status, link_url, provider_link_id)
  values (p_id, p_clinic, 'link', p_amount, 'link_sent', p_url, p_link);
end
$$;
revoke all on function app.record_topup_link(uuid, uuid, bigint, text, text) from public;
grant execute on function app.record_topup_link(uuid, uuid, bigint, text, text) to app_user;

create or replace function app.set_wallet_notified(p_state text) returns void
language sql security definer set search_path = public
as $$ update public.wallets set notified_state = p_state where clinic_id = app.current_clinic_id() $$;
revoke all on function app.set_wallet_notified(text) from public;
grant execute on function app.set_wallet_notified(text) to app_user;
grant execute on function app.wallet_state(bigint, bigint, bigint) to app_user;

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

-- Default rate card (ASSUMPTIONS A-44). Provider costs are list prices as of Sep 2026; Sentio edits them in
-- the admin panel. Margins are Sentio's.
insert into public.rate_cards (clinic_id, kind, unit, provider_cost_paise, margin_pct) values
  (null, 'telephony_min',     'minute',          60.0000, 50),   -- Exotel voice, ~₹0.60/min
  (null, 'stt_sec',           'second',           0.5000, 50),   -- Sarvam speech-to-text, ~₹30/hour
  (null, 'tts_char',          'character',        0.0150, 50),   -- Sarvam text-to-speech, ~₹15 per 10k chars
  (null, 'llm_input_token',   'token',            0.0250, 50),   -- LLM input, ~$3 per million tokens
  (null, 'llm_output_token',  'token',            0.1250, 50),   -- LLM output, ~$15 per million tokens
  (null, 'wa_utility',        'message',         13.0000, 30),   -- Meta utility template, India
  (null, 'wa_marketing',      'message',         88.0000, 30),   -- Meta marketing template, India
  (null, 'wa_authentication', 'message',         13.0000, 30),
  (null, 'sms_segment',       'segment',         20.0000, 50);   -- DLT SMS
