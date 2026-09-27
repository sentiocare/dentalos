# Architecture

The full design and its reasoning are in [PLAN.md](PLAN.md). This page describes **what exists in the code today** and how the pieces fit. It is updated at the end of every phase.

## Current state: Phase 0 (scaffolding)

```
apps/
  api/        Fastify HTTP service. /health (liveness) and /health/ready (database, worker, each provider).
  worker/     Graphile Worker (Postgres-backed job queue). Heartbeat job every minute.
  web/        Next.js PWA shell: installable on Android, English/Hindi switch (cookie), mobile-first.
packages/
  shared/     Money in paise, Indian phone normalisation, UUIDv7, PII scrubbing, redacting logger, env loader.
  adapters/   Interfaces for all 7 external providers, a fake for each, and contract test suites.
  db/         SQL migrations, the migration runner (with destructive-change guard), clinic-scoped transactions.
deploy/       Dockerfiles and Railway config for each service.
scripts/      Node service bundler, local dev database.
```

## Rules the code follows

1. **Tenant isolation is enforced by the database.**
   - Every tenant table has `clinic_id` and row-level security (RLS) policies that use `app.current_clinic_id()`.
   - Application code reaches tenant data only through `withClinic(pool, { clinicId, actor }, fn)`. It opens a transaction, switches to the restricted `app_user` role, and sets the clinic context for that transaction only.
   - A missing context means zero rows, not all rows.
2. **Business logic never imports a provider SDK.** It depends on the interfaces in `@dentalos/adapters`.
   - Real adapters are added per phase.
   - Selecting one that isn't built yet fails at startup, naming the phase.
   - Production refuses fake adapters.
3. **Every adapter must pass its contract suite** (`@dentalos/adapters/testing`). That makes swapping a provider a mechanical change.
4. **No PII in logs.**
   - The logger deep-scrubs PII keys, masks phone numbers and emails in all strings, and drops URL query strings.
   - Job payloads are never logged.
   - Lint forbids `console`.
5. **Migrations are append-only and all-or-nothing.**
   - Each runs in a transaction, under an advisory lock.
   - Editing an applied migration is an error.
   - Destructive statements need an explicit approval header.
6. **Money is integer paise.** Postgres `bigint` is parsed to a safe JavaScript integer, and conversion refuses anything unsafe.
7. **Jobs are idempotent.** Graphile `jobKey` deduplicates scheduling, and handlers must be safe to run twice.

## Request flow (today)

```
Railway → api (Fastify) → /health/ready → withAppRole(pool) → Postgres (Supabase Mumbai)
                                         → adapters.*.healthCheck()
worker (Graphile) → cron "heartbeat" → service_heartbeats
```
