# Architecture

The full design and its reasoning are in [PLAN.md](PLAN.md). This page describes **what exists in the code today** and how the pieces fit. It is updated at the end of every phase.

## Current state: Phase 1 (foundation)

```
apps/
  api/        Fastify HTTP service
              /health, /health/ready             liveness and readiness (database, worker, each provider)
              /v1/me, /v1/dev/login               sign-in (Supabase token or dev-only login)
              /v1/clinic, /v1/config, …           clinic settings, doctors, chairs, treatments, hours, holidays,
                                                  leave, emergency slots, staff
              /v1/patients, /v1/family-links      patient records and family links
              /v1/appointments, /v1/slots         booking, move/resize, status, cancel, free-slot search
              /v1/imports/…                       Excel/CSV import: preview, then commit
              /v1/audit                           activity log
              src/admin/                          Sentio admin commands (create a clinic, demo data)
  worker/     Graphile Worker jobs: heartbeat (1 min), release expired holds (1 min),
              keep emergency reserves 14 days ahead (hourly)
  web/        Next.js staff dashboard (installable on Android): Today, Calendar, Patients, Import,
              Settings, Activity; English/Hindi; offline cache and outbox; Playwright tests in e2e/
packages/
  shared/     Money in paise, Indian phone numbers, UUIDv7, PII scrubbing, redacting logger, env loader
  adapters/   Interfaces for all 7 external providers, a fake for each, contract test suites
  db/         SQL migrations, migration runner, clinic-scoped transactions, test helpers
  core/       Domain logic: scheduling engine and service, patients, imports, permissions, clinic creation
```

## How a booking stays correct

1. **Offering slots.** The **availability engine** (`core/scheduling/availability.ts`) works out free slots. It is a pure function of the clinic's configuration (hours, breaks, visiting days, holidays, leave, procedure length and buffer, chair equipment) and what is already busy. The dashboard imports the same code to shade non-working time, so the screen and the server always agree.
2. **Holding and booking.** Every appointment, hold and emergency reserve writes one row per doctor and one per chair into `resource_occupancy`. A Postgres exclusion constraint makes overlapping rows impossible, so a double booking cannot be stored, whatever the application code does. The rows are written only by database triggers. Resources are locked in a fixed order, so two racing bookings never deadlock: one wins, the other gets "slot taken".
3. **Staff overrides.** Staff can book outside the normal schedule after seeing the warnings ("book anyway?"). They can never override a clash.
4. **Retries.** Every booking request from the dashboard carries an idempotency key. Retrying after a dropped connection returns the same appointment instead of creating a second one.

## Security model

- **Sign-in.** Staff sign in with a phone OTP (Supabase Auth). The API verifies the token and then looks up the person's clinic and role in `clinic_memberships`. Nothing about clinic or role is trusted from the token.
- **Row-level security.** Every request runs inside `withClinic(...)`: one transaction, switched to the restricted `app_user` role, with the clinic set for that transaction only. Every tenant table has a policy for `app_user`, and child rows point to parents by `(clinic_id, id)`, so a row can never reference another clinic's data. Supabase's public `anon`/`authenticated` roles have no access to our tables at all.
- **Permissions.** One matrix (`core/access/permissions.ts`) is used by both the API and the dashboard. The owner can switch individual permissions off, for example revenue for a receptionist. The clinic can never lose its last owner.
- **Audit.** A database trigger records every change to clinic data in `audit_log`: who, what, before and after. The table cannot be edited or deleted.
- **Logs.** Logs never contain patient data. The logger scrubs names, phone numbers and emails, drops query strings, and never logs job payloads.

## Offline behaviour (dashboard)

- **App shell.** The service worker caches the app itself, so it opens without internet.
- **Data.** The clinic configuration and each viewed day's appointments are kept in IndexedDB on the phone. Without internet, the screens show that copy with an "offline" note.
- **Changes.** Status changes, moves, cancellations and bookings made offline wait in an on-device outbox. They are sent in order when the connection returns. Anything the server refuses (for example, the slot was taken meanwhile) is listed for staff to look at.

## Tests

| Suite           | What it proves                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`   | Double booking is impossible, including 50 rounds of 20 simultaneous bookings; isolation across all 18 tenant tables; audit trail; append-only tables                                              |
| `packages/core` | Availability rules (shifts, visiting days, buffers, leave, holidays, equipment, dates around month and year ends); holds and races; staff overrides; 5,000-patient import with duplicate detection |
| `apps/api`      | Sign-in, roles and permissions, cross-clinic isolation over HTTP, 20 simultaneous HTTP bookings giving one success, validation                                                                     |
| `apps/web/e2e`  | At 360px on a touch phone: book, drag to move, drag to resize, cancel; offline change queued then synced; app opens offline; Hindi                                                                 |
