-- 0001: extensions, the restricted application role, and per-transaction clinic context.
-- Every tenant table added later enables RLS with policies that call app.current_clinic_id().

create extension if not exists btree_gist;   -- exclusion constraints on (resource, time range)
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;      -- fast fuzzy patient-name search

-- The backend never queries as a superuser or Supabase service role. It connects with a login role and
-- switches to app_user inside each transaction, so row-level security applies even if application code
-- has a bug.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end
$$;

-- current_user must be able to SET ROLE app_user.
do $$
begin
  execute format('grant app_user to %I', current_user);
end
$$;

grant usage on schema public to app_user;

create schema if not exists app;
grant usage on schema app to app_user;

-- Clinic context is set with set_config(..., is_local => true), so it lasts only for the transaction
-- and cannot leak to the next request that reuses the pooled connection.
create or replace function app.current_clinic_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.clinic_id', true), '')::uuid $$;

create or replace function app.current_user_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.current_actor() returns text
language sql stable
as $$ select coalesce(nullif(current_setting('app.actor', true), ''), 'system') $$;

-- Attach to append-only tables (usage ledger, audit log, consents) to block UPDATE and DELETE.
create or replace function app.forbid_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = 'P0001';
end
$$;

-- Liveness of background services, read by health checks. Not tenant data.
create table public.service_heartbeats (
  service text primary key,
  beat_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
grant select, insert, update on public.service_heartbeats to app_user;
