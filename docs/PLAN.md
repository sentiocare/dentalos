# Sentio Dental OS: Implementation Plan

**Status:** Approved by the founder on 27 September 2026, with decisions D1–D7 as recommended. Phase 0 is in progress.
**Date:** 27 September 2026
**Scope:** Architecture, stack choice, data model, folder structure, cross-cutting design, and the phase-by-phase build plan with acceptance tests.

Section numbers like "§5.3" point to sections of the build prompt.

---

## 0. Decisions I need from you before Phase 1

These choices are hard to undo later. Each one has a recommendation. Reply with "approved" or tell me what to change.

| #   | Decision                                                                                                                                                | My recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why it matters                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| D1  | **Where the backend runs.** The spec says Railway, and it also says patient data must be hosted in India (§3.9). Railway may not have an Indian region. | Keep **all stored data** (database, files, recordings, backups) in Supabase Mumbai. Nothing is stored on the Railway servers. If Railway has no India region, run the API and worker in the region closest to India and get the lawyer to confirm this is acceptable. If the lawyer says compute must also be in India, move the API and worker to AWS Mumbai or GCP Mumbai. The code runs in a container, so the move is a config change.                                      | Data localisation and legal exposure                |
| D2  | **Backend language**                                                                                                                                    | **TypeScript (Node 22)** for everything. The reasons are in §2.1.                                                                                                                                                                                                                                                                                                                                                                                                               | Hard to change once built                           |
| D3  | **Telephony provider**                                                                                                                                  | **Exotel** first (Indian virtual numbers, call forwarding, recording, warm transfer, SIP to the voice layer), with Plivo India as the second adapter.                                                                                                                                                                                                                                                                                                                           | Number porting and compliance setup                 |
| D4  | **Voice integration mode**                                                                                                                              | In the first week of Phase 3, run a short technical test ("spike") on **Sarvam Samvaad**. It must give us: (a) our own tools called over signed webhooks, (b) a live transcript stream so our own emergency detector can listen, (c) a way to filter or override what the bot says before it is spoken. If it can't do (c), we use Sarvam speech-to-text and text-to-speech with our own conversation engine instead. Both options fit behind the same `VoiceProvider` adapter. | The medical-safety guarantee (§7.8) depends on this |
| D5  | **LLM provider and cross-border data**                                                                                                                  | Keep the provider behind an adapter. Choose it with a Phase 2 eval on Hinglish quality, speed and INR cost. Remove names and phone numbers from text before it goes to any LLM hosted outside India, and have the lawyer review the transfer.                                                                                                                                                                                                                                   | DPDP cross-border rules                             |
| D6  | **TRAI DLT registration** (for SMS and for outbound promotional calls)                                                                                  | Sentio registers as the principal entity for the transactional SMS fallback. Each clinic's promotional voice campaigns stay **off** until you confirm the registration route with the lawyer.                                                                                                                                                                                                                                                                                   | Rules on commercial calls and SMS                   |
| D7  | **Sentio's GSTIN and invoice numbering**                                                                                                                | You give me the GSTIN, legal name, address and SAC codes. Invoice numbers use one series per financial year.                                                                                                                                                                                                                                                                                                                                                                    | Tax invoices (§4.2.6)                               |

Until you answer, I assume the recommendation for each. Every assumption is also recorded in `docs/ASSUMPTIONS.md`.

**Update (27 Sep 2026, Phase 3):** D4 is decided: the founder chose **our own voice pipeline** (no hosted voice agent). Exotel streams the call audio to our `voice` service; Sarvam is used only for speech-to-text and text-to-speech; turn-taking, understanding, every sentence, the safety filter and all actions are our code. This gives the medical-safety guarantee (§7.8) by construction.

**Update (27 Sep 2026):** the founder approved every recommendation and decided against a legal review. Where the table says "lawyer", the safest default recorded in `docs/COMPLIANCE.md` → "Decisions taken without a legal review" applies instead.

---

## 1. Architecture overview

```
                    Patients                                   Clinic staff / owner
      (phone calls)          (WhatsApp)                 (Android PWA, front-desk desktop)
           │                     │                                   │
   ┌───────▼────────┐   ┌────────▼─────────┐                ┌────────▼─────────┐
   │ Telephony      │   │ WhatsApp Cloud   │                │ apps/web         │
   │ (Exotel/Plivo) │   │ API (Meta)       │                │ Next.js PWA      │
   └───┬───────▲────┘   └────────┬─────────┘                │ + offline cache  │
       │ SIP   │ transfer        │ webhooks                 └────────┬─────────┘
   ┌───▼───────┴────┐            │                                   │ HTTPS (JWT)
   │ Voice layer    │  tool calls│                                   │
   │ (Sarvam)       ├──────┐     │                                   │
   └────────────────┘      │     │                                   │
                     ┌─────▼─────▼───────────────────────────────────▼──────┐
                     │ apps/api  (Fastify, TypeScript)                       │
                     │  • Staff REST API     • Agent Tool API (§8.1)         │
                     │  • Provider webhooks (signed, idempotent)             │
                     │  • Text agent (WhatsApp) orchestrator                 │
                     └───────┬──────────────────────────────────────┬───────┘
                             │ Postgres (RLS on every table)        │ enqueue jobs
                     ┌───────▼──────────────────────┐   ┌───────────▼──────────┐
                     │ Supabase Postgres (Mumbai)   │◄──┤ apps/worker          │
                     │ + Storage (recordings, PDFs, │   │ Graphile Worker      │
                     │   X-rays) + Auth             │   │ reminders, recalls,  │
                     └──────────────────────────────┘   │ follow-ups, reports, │
                                                        │ metering, purging    │
                                                        └──────────────────────┘
      External adapters: VoiceProvider · TelephonyProvider · MessagingProvider ·
                         LLMProvider · PaymentProvider · SmsProvider · StorageProvider
```

**Key principles and how the design meets them:**

- **One source of truth.** Postgres holds all state. The voice and chat agents cannot reach the database. They can only call the Tool API (§8.1). Every tool validates its input, checks permissions, uses an idempotency key and writes an audit log entry.
- **"Never invents" is enforced by the database.** Only the database can create a booking, so the agent can only say "booked" after a real transaction has committed. The tool response carries a `committed: true` flag and the appointment ID. The agent prompt and the eval suite both check for it.
- **Business logic never depends on a provider.** `packages/core` has no provider SDK imports. Adapters live in `packages/adapters`, each with a fake version used in tests and evals.
- **All outgoing messages go through two chokepoints:**
  1. `CommsPolicy.canContact(patient, channel, category, at)` checks consent, opt-outs, DND, allowed hours, the WhatsApp 24-hour window and wallet state.
  2. The **outbox** table is the only way anything is sent. A worker sends each message exactly once, using a dedupe key.
- **Emergency routing works without the wallet or the LLM.** Emergency detection and forwarding run on a separate code path. It does not check the wallet, and it has a deterministic fallback (keyword matching plus forwarding to fixed numbers) for when the LLM or voice provider is down.

---

## 2. Stack

### 2.1 Why TypeScript and not Python

1. **One language across the product.** The Next.js dashboard, API, worker, PDF templates and eval harness share the same types and Zod validation schemas. A tool's input schema is written once and used for API validation, LLM tool definitions and dashboard forms.
2. **Mature libraries for what we need:** Fastify (fast, schema-validated HTTP), Kysely (type-safe SQL that still lets us write exclusion constraints and RLS by hand), Graphile Worker (a durable job queue on Postgres with deduplication keys and retries), and good Razorpay and Meta SDKs.
3. **Latency.** Node's async I/O comfortably meets the p95 target of 1.5 seconds per tool call.
4. **Hiring and maintenance.** It is easier for an Indian startup to find full-stack TypeScript developers than people who know both Python and a React/Next.js frontend.

Python would only be clearly better for ML training work, which is out of scope (§14).

### 2.2 Components

| Concern       | Choice                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monorepo      | pnpm workspaces + Turborepo                                                                                                                      |
| Database      | Supabase Postgres 15+, Mumbai (`ap-south-1`), extensions `btree_gist`, `pgcrypto`, `pg_trgm`                                                     |
| Migrations    | Plain SQL files in `packages/db/migrations`, applied with the Supabase CLI. Destructive migrations need explicit approval (§0.5).                |
| Query layer   | Kysely, with types generated from the live schema (`kysely-codegen`)                                                                             |
| Auth          | Supabase Auth. Staff sign in with phone OTP; owners can also use email. Clinic membership and role live in our own tables and are read by RLS.   |
| API           | Fastify + Zod                                                                                                                                    |
| Jobs          | Graphile Worker (Postgres-backed). Every job has a `job_key`, so re-queuing the same job does nothing. Jobs survive restarts.                    |
| Frontend      | Next.js (App Router) PWA, Tailwind, `next-intl` (English and Hindi), IndexedDB for offline use through Dexie                                     |
| PDFs          | `@react-pdf/renderer` on the server, with Noto Sans Devanagari embedded for Hindi                                                                |
| Observability | Pino structured logs with PII redaction, Sentry (with `beforeSend` scrubbing), an uptime monitor, per-clinic health checks                       |
| Tests         | Vitest (unit and integration), Testcontainers Postgres (real constraints, real RLS), Playwright (dashboard end-to-end tests)                     |
| CI            | GitHub Actions: lint, typecheck, unit tests, database integration tests, eval "safety" subset on every PR; full eval nightly and before releases |

---

## 3. Folder structure

```
dentalos/
├── apps/
│   ├── web/                  Next.js PWA: staff dashboard, onboarding wizard, Sentio admin (/admin)
│   ├── api/                  Fastify: staff REST, agent Tool API, webhooks, WhatsApp text agent
│   └── worker/               Graphile Worker task handlers + cron schedule
├── packages/
│   ├── db/                   SQL migrations, RLS policies, generated types, Kysely client, seed scripts
│   ├── core/                 Domain logic (mostly pure functions):
│   │   ├── scheduling/       slot search, holds, booking, buffers, visiting days, emergency slots
│   │   ├── treatments/       plan templates, sitting sequence, continuity windows
│   │   ├── followups/        generic escalation ladders (WhatsApp → AI call → staff task)
│   │   ├── comms/            CommsPolicy, consent, opt-outs, allowed hours, outbox
│   │   ├── billing/          wallet, metering, rates and margins, spend caps, degradation state
│   │   ├── ledger/           patient charges, payments, dues, receipts
│   │   ├── reports/          owner nightly/weekly/monthly, "rupees recovered"
│   │   └── compliance/       retention, purging, data requests, breach log
│   ├── adapters/
│   │   ├── voice/            VoiceProvider: sarvam, (retell, vapi stubs), fake
│   │   ├── telephony/        TelephonyProvider: exotel, plivo, fake
│   │   ├── messaging/        MessagingProvider: whatsapp-cloud, fake
│   │   ├── llm/              LLMProvider: configurable, fake (scripted)
│   │   ├── payments/         PaymentProvider: razorpay, (cashfree stub), fake
│   │   ├── sms/              SmsProvider: DLT-registered provider, fake
│   │   └── storage/          StorageProvider: supabase-storage, fake
│   ├── agent/                Tool definitions (shared Zod), prompts, safety output filter,
│   │                         emergency detector, WhatsApp dialog state machine, date/time-in-words
│   ├── pdf/                  Estimate, receipt, tax invoice, prescription templates
│   ├── i18n/                 en/hi strings, Hinglish phrasing helpers, number/date words
│   └── shared/               money (paise), phone (E.164), time (IST), ids, errors, zod schemas
├── evals/
│   ├── cases/                YAML conversations grouped by category (≥200)
│   ├── runner/               Scripted + LLM-simulated caller, assertions, report generator
│   └── reports/              Generated HTML/Markdown reports (git-ignored)
├── docs/                     PLAN, SETUP, ONBOARDING, COMPLIANCE, ASSUMPTIONS, ARCHITECTURE, RUNBOOK,
│                             operator call-forwarding guides (Jio, Airtel, Vi, BSNL, landline)
├── scripts/                  one-command helpers: setup, migrate, seed-demo, backup-verify, eval
└── .github/workflows/        ci.yml, nightly-evals.yml, deploy.yml
```

---

## 4. Data model

Conventions used in every table:

- Every tenant table has `clinic_id uuid not null` and an RLS policy `clinic_id = auth_clinic_id()`.
- Primary keys are `uuid` (v7, so they sort by time).
- Timestamps are `timestamptz`. Clinic time zone defaults to `Asia/Kolkata`.
- Money is `bigint` paise. Never floats.
- Phone numbers are E.164 text (`+9198…`).
- Tables that can be deleted from have soft delete (`deleted_at`). The usage ledger and audit log can never be deleted from.
- `branch_id` is on schedule-bearing tables from day one. Every clinic gets one default branch. This means multi-branch (P2) won't need a migration.

### 4.1 Tenancy, users, audit

| Table                | Key columns / notes                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinics`            | name, legal_name, gstin?, address, maps_url, languages[], default_language, timezone, license_status, license_valid_until, settings jsonb (versioned)                                                                |
| `branches`           | clinic_id, name, address, phone, maps_url, is_default                                                                                                                                                                |
| `users`              | id = supabase auth uid, name, phone, email, ui_language                                                                                                                                                              |
| `clinic_memberships` | user_id, clinic_id, role (`owner`/`doctor`/`receptionist`/`assistant`), permission overrides jsonb, active                                                                                                           |
| `sentio_staff`       | platform admins (separate from clinic roles; can only use admin API, never RLS bypass from the browser)                                                                                                              |
| `audit_log`          | clinic_id, actor (user / agent:voice / agent:whatsapp / system), action, entity, entity_id, before jsonb, after jsonb, at. **No UPDATE or DELETE allowed** (the privilege is revoked and a trigger raises an error). |

### 4.2 Clinic configuration and scheduling

| Table                          | Key columns / notes                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctors`                      | clinic_id, user_id?, name, speciality, kind (`permanent`/`visiting`/`on_call`), phone, is_on_call_emergency, emergency_order                                                                                                                                                                                                                    |
| `doctor_visiting_schedules`    | doctor_id, weekday, start_time, end_time, valid_from/to (e.g. ortho Tue and Sat 11:00–17:00)                                                                                                                                                                                                                                                    |
| `chairs`                       | branch_id, name, equipment tags[]                                                                                                                                                                                                                                                                                                               |
| `procedure_types`              | name, names_i18n, synonyms[] (for matching speech, e.g. "RCT", "nas ka ilaaj"), default_duration_min, buffer_after_min, required_equipment[], allowed_doctor_ids[], price_min_paise, price_max_paise, price_public bool, gst_mode (`exempt`/`taxable`), gst_rate, sac_code, aftercare_template_id?, requires_lab_received bool, is_consultation |
| `working_hours`                | branch_id, doctor_id? (null = the clinic's hours), weekday, start_time, end_time                                                                                                                                                                                                                                                                |
| `breaks`, `holidays`, `leaves` | date or time ranges, for the branch or a doctor                                                                                                                                                                                                                                                                                                 |
| `emergency_slots`              | branch_id, weekday, start_time, duration, chair_id? (reserved capacity that staff or emergency routing can release)                                                                                                                                                                                                                             |
| `appointments`                 | patient_id, doctor_id, chair_id, procedure_type_id, treatment_step_id?, starts_at, ends_at, `occupied tstzrange` (includes the buffer), status (`booked`/`confirmed`/`checked_in`/`in_chair`/`completed`/`cancelled`/`no_show`), source (`staff`/`voice`/`whatsapp`/`import`/`walk_in`), booked_by, confirmation_status, idempotency_key unique |
| `slot_holds`                   | doctor_id, chair_id, `occupied tstzrange`, expires_at, holder (call_id / conversation_id), offered_to_phone                                                                                                                                                                                                                                     |
| `resource_occupancy`           | **the single table that enforces "no double booking"**. Details below.                                                                                                                                                                                                                                                                          |
| `walk_in_queue` (P1)           | token_no per branch per day, patient_id, status, estimated_start, notified_at                                                                                                                                                                                                                                                                   |

**How double-booking is prevented in the database (§5.3).** Appointments, active holds and reserved emergency blocks each write one row per resource into `resource_occupancy`:

```sql
create table resource_occupancy (
  id uuid primary key,
  clinic_id uuid not null,
  resource_kind text not null check (resource_kind in ('doctor','chair')),
  resource_id uuid not null,
  occupied tstzrange not null,
  source_kind text not null check (source_kind in ('appointment','hold','emergency_reserve')),
  source_id uuid not null,
  expires_at timestamptz            -- only for holds
);
alter table resource_occupancy add constraint no_overlap
  exclude using gist (resource_kind with =, resource_id with =, occupied with &&);
```

- Rows are maintained **in the same transaction** as the appointment or hold, by a `SECURITY DEFINER` function (`book_from_hold`, `move_appointment`, `cancel_appointment`). The app never writes to this table directly.
- **Expired holds.** Postgres exclusion constraints can't compare against `now()`. So each booking or hold transaction first deletes expired holds for the same resources (`DELETE … WHERE expires_at < now()`), and a sweeper job cleans up every 30 seconds.
- **Buffers.** `occupied` = `[starts_at, ends_at + buffer)`.
- **Emergency slots** are pre-materialised as `emergency_reserve` rows for the next 14 days. Only the staff role or the emergency flow can release them, through a function that checks the role.
- **Converting a hold into an appointment is atomic.** The hold's occupancy rows are re-pointed to the new appointment, so no other caller can take the slot in between.

This is the design the "20 simultaneous bookings → exactly one" test targets (§10.1).

### 4.3 Patients, consent, communication preferences

| Table                  | Key columns / notes                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `patients`             | name, phone (E.164, can be shared by family members), dob?, age_years?, gender, language_pref, source (walk-in/Google/Instagram/Practo/JustDial/referral/…), referred_by_patient_id?, notes, last_visit_at, status. Trigram index on name, btree index on phone (search in under a second) |
| `patient_family_links` | patient_id, related_patient_id, relationship, is_primary_contact                                                                                                                                                                                                                           |
| `consents`             | patient_id, purpose (`treatment_comms`/`reminders`/`marketing`/`call_recording`/`data_processing`), channel, granted bool, notice_version, language, captured_via (voice/whatsapp/form/staff), evidence ref (call_id/message_id), at. Append-only; the current state is a view.            |
| `opt_outs`             | phone, patient_id?, channel (`voice`/`whatsapp`/`sms`/`all`), category (`transactional`/`promotional`/`all`), source, at                                                                                                                                                                   |
| `dnd_cache`            | phone, dnd_status, checked_at (for TRAI checks before promotional contact)                                                                                                                                                                                                                 |
| `data_requests`        | patient_id, kind (`access`/`correction`/`deletion`/`withdraw_consent`), status, due_at, handled_by                                                                                                                                                                                         |

### 4.4 Clinical (lightweight) and revenue engine

| Table                                                                     | Key columns / notes                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visits`                                                                  | patient_id, appointment_id?, doctor_id, date, notes, procedures done                                                                                                                                                                                  |
| `treatment_templates`                                                     | name, steps jsonb (procedure_type, expected gap in days min/max, requires_lab), editable per clinic; seeded defaults (RCT+crown, implant stages, ortho monthly, aligners, dentures, extraction+follow-up, scaling, filling, crown/bridge, paediatric) |
| `treatment_plans`                                                         | patient_id, doctor_id, template_id?, tooth (FDI) list, status (`proposed`/`accepted`/`in_progress`/`completed`/`abandoned`), total_value_paise                                                                                                        |
| `treatment_steps`                                                         | plan_id, seq, procedure_type_id, tooth, expected_window_start/end, status (`pending`/`scheduled`/`done`/`missed`/`skipped`), appointment_id?, value_paise, lab_order_id?                                                                              |
| `tooth_chart_entries` (P1)                                                | patient_id, tooth (FDI `11`–`48`, `51`–`85` for primary teeth), surface?, condition, note, by, at                                                                                                                                                     |
| `estimates`                                                               | patient_id, items jsonb (procedure, options, amount), total_paise, emi_note, status (`sent`/`accepted`/`declined`/`expired`), pdf_path, sent_at                                                                                                       |
| `lab_orders` (P1)                                                         | patient_id, treatment_step_id?, lab_name, lab_phone, work_type, shade, sent_on, due_on, received_on?, status                                                                                                                                          |
| `documents` (P1)                                                          | patient_id, kind (xray/consent/prescription/other), storage_path, uploaded_by                                                                                                                                                                         |
| `consent_forms` (P1), `prescription_templates` (P1), `prescriptions` (P1) | signed-form images/signature, doctor-owned templates only                                                                                                                                                                                             |

### 4.5 Follow-ups, tasks, communication

| Table                                          | Key columns / notes                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `followup_ladders`                             | configurable per clinic and kind: `treatment_continuity`, `estimate`, `no_show`, `unconfirmed`, `dues`, `recall`, `reactivation`, `lead`, `aftercare_checkin`, `lab_ready`. Steps: `[{after: '2d', action: 'whatsapp', template}, {after:'2d', action:'ai_call'}, {after:'1d', action:'staff_task'}]` |
| `followup_runs`                                | ladder_id, subject (entity + id), current_step, next_at, status (`active`/`stopped_success`/`stopped_optout`/`stopped_staff`/`exhausted`), stop_reason                                                                                                                                                |
| `tasks`                                        | kind (`callback`/`followup`/`escalation`/`lab_overdue`/`complaint`/`data_request`), priority (`critical`/`high`/`normal`), patient_id?, summary, assigned_to?, due_at, status                                                                                                                         |
| `conversations`                                | channel (whatsapp/voice), patient_id?, phone, mode (`bot`/`human`), taken_over_by?, last_inbound_at (for the 24h window)                                                                                                                                                                              |
| `messages`                                     | conversation_id, direction, type (text/template/interactive/audio/document), body (PII-redacted copy separate), template_id?, provider_message_id unique, status, cost_paise                                                                                                                          |
| `outbox`                                       | channel, to, payload, category (`transactional`/`promotional`/`critical`), dedupe_key **unique**, not_before, status, attempts, last_error                                                                                                                                                            |
| `calls`                                        | direction, from/to, patient_id?, provider_call_id unique, started/ended, duration_s, recording_path, transcript jsonb, summary, intent, outcome, language, escalated bool, cost_paise                                                                                                                 |
| `templates`                                    | kind (whatsapp/aftercare/sms/voice_script), category (`utility`/`marketing`/`authentication`), language, body, variables, meta_status (`draft`/`submitted`/`approved`/`rejected`), **owner_approved_by/at**                                                                                           |
| `campaigns`                                    | template_id, audience query (stored definition), status (`draft`/`awaiting_owner`/`approved`/`running`/`paused`/`done`), owner_approved_by/at                                                                                                                                                         |
| `leads` (P1), `referrals` (P1), `reviews` (P1) | source, raw payload, stage, converted_patient_id, rating, routed_to                                                                                                                                                                                                                                   |

### 4.6 Business model: one-time purchase plus pay-per-use (no subscription)

The clinic **buys the product once**. There is no monthly fee. After purchase, the clinic saves a payment method once, and only **actual usage** (call minutes, WhatsApp conversations, AI processing, SMS) is charged against it through the prepaid wallet.

- `licenses`: clinic_id, sku (edition), price_paise, gst, purchased_at, payment ref, invoice_id, `updates_support_until` (configurable period, e.g. 12 months), status.
  - The license is **perpetual**. If the updates and support period ends, the product keeps working. Extending updates and support is an optional one-time purchase, never an automatic charge.
- Checkout at onboarding (step 8) is **one** Razorpay-hosted flow:
  - (a) a one-time payment for the license, and
  - (b) a mandate authorisation (UPI Autopay / card / e-NACH) that is **only** used to top up the usage wallet.
  - The mandate never charges a fixed recurring amount. Each debit is a usage recharge with a pre-debit notice.
- The clinic sees exactly what it paid for: each call and each message shows its cost on the dashboard, and each recharge gets a GST invoice.

### 4.7 Money: patient ledger and Sentio billing

| Table                  | Key columns / notes                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patient_ledger`       | append-only entries: `charge` / `payment` / `adjustment` / `refund`, patient_id, amount_paise, method (`cash`/`upi`/`card`/`gateway_link`), reference, visit/step link. Balance = sum, exposed as a view                            |
| `payment_links`        | patient_id, amount, provider_link_id unique, status, paid_at                                                                                                                                                                        |
| `receipts`, `invoices` | numbered per clinic per FY (sequence table + row lock), pdf_path, gst breakup                                                                                                                                                       |
| `wallets`              | clinic_id (1:1), balance_paise (derived and cached; the ledger is the source of truth), threshold_paise, recharge_amount_paise, monthly_cap_paise, state (`active`/`low`/`grace`/`suspended`)                                       |
| `usage_ledger`         | **append-only** (UPDATE/DELETE revoked). kind (`voice_min`/`telephony_min`/`wa_conversation`/`llm_tokens`/`sms`), quantity, unit_cost_paise (provider), margin_paise, total_paise, ref (call/message id) **unique per (kind, ref)** |
| `rate_cards`           | clinic_id? (null = default), kind, provider_cost_per_unit, margin_per_unit or margin_pct, effective_from                                                                                                                            |
| `mandates`             | provider, provider_mandate_id, method (upi_autopay/card/enach), max_amount, status, last_failure                                                                                                                                    |
| `recharges`            | mandate_id, amount, pre_debit_notified_at, debit_after, status, provider_payment_id unique, invoice_id                                                                                                                              |
| `webhook_events`       | provider, event_id **unique**, received_at, processed_at (makes every webhook idempotent)                                                                                                                                           |

---

## 5. Cross-cutting design

### 5.1 Security and multi-tenancy

- **RLS on every table.** The backend does **not** use the Supabase service-role key for normal requests. It connects as a limited `app_user` role and sets `app.clinic_id` / `app.user_id` / `app.role` per transaction, so RLS protects us even from a backend bug. Workers set the clinic context per job. Only migration and admin scripts use the owner role.
- **A test for tenant isolation.** An automated test creates two clinics and checks that every table is invisible across clinics, both through the API and through direct SQL as `app_user`.
- **Role permissions** are one matrix in `packages/core/permissions.ts`. The API and the UI both read it. The owner can switch individual permissions off (e.g. `reports.revenue` for receptionists).
- **The Tool API** for agents authenticates with an HMAC-signed request per provider and per clinic, checks timestamps to block replays, requires an idempotency key and has rate limits.
- **No PII in logs or error trackers.** Pino redaction paths plus a regex scrubber for phone numbers, names and emails. Sentry `beforeSend` uses the same scrubber. A CI test fails if a log line contains a seeded phone number.
- **Encryption.** Supabase encrypts at rest and we use TLS everywhere. Recordings and documents sit in private buckets and are only served through short-lived signed URLs.

### 5.2 Communication policy (one function, used everywhere)

`canContact({patient, phone, channel, category, purpose, at})` returns `allow` or `deny(reason)`. It checks in this order:

1. The emergency/critical category always passes, and nothing else does automatically.
2. Opt-outs (the channel or `all`, and the category or `all`).
3. Consent for the purpose (the lawful basis: an existing patient relationship allows transactional contact; promotional contact needs explicit opt-in).
4. Allowed hours (clinic setting, clamped to legal limits, default 09:00–20:00 IST).
5. For WhatsApp: inside the 24-hour window, free text is allowed; outside it, only an approved template of the right category.
6. For promotional contact: DND status and an owner-approved campaign.
7. Wallet state (§5.6).

If the answer is deny-because-of-time, the message is rescheduled rather than dropped.

The word "STOP" (and Hindi equivalents like "band karo" and "message mat bhejo") in any inbound WhatsApp message, or "don't call me" in a call, records an opt-out immediately and sends a one-line confirmation.

### 5.3 Follow-up engine (one mechanism for every "chase" feature)

Treatment continuity, estimates, no-shows, unconfirmed appointments, dues, recalls, reactivation, leads and lab-ready all run on **one** engine: `followup_runs` stepping through a configurable ladder, driven by Graphile Worker jobs keyed by `followup:{run_id}:{step}`, which makes them idempotent.

A run stops on its own when:

- the goal is reached (booked / paid / confirmed / accepted), or
- the patient opts out, or
- staff pause or cancel it, or
- the ladder runs out, in which case it creates a staff task.

Because of this, "a simulated month produces correct follow-ups" (Phase 4) can be tested with a fake clock.

### 5.4 Agents

**Tool layer (shared by voice and WhatsApp).** This is the §8.1 list exactly. Each tool is a Zod schema plus a handler in `packages/agent/tools`. The rules below are enforced in code, not only in prompts:

- `get_patient_appointments`, `get_dues` and document resends require a `verification_token`. `identify_caller` issues one when the caller's number matches the patient. A `verify_patient` step (name + DOB or last visit date) can also issue one. This is an extra tool required by §6.7.
- `find_slots` returns at most 3 options, each already **held**. Consultant-only procedures only return that consultant's visiting days. If the procedure is uncertain, it returns consultation slots. If the lab work isn't marked received, it refuses to offer fitment slots.
- `book_appointment` only succeeds from a valid hold. It returns `{committed: true, appointment_id, readback: {hi, en, hinglish}}`. The readback text ("Mangalvaar, 14 October, shaam 5 baje, Dr. Sharma ke saath") is **generated by our code**, not the LLM, so the date and day can't be wrong.
- `get_price_range` returns an approved range or `not_listed`. There is no free-form price field anywhere.

**Safety layers:**

1. **Prompt rules** from §6.
2. **An emergency detector** runs on every caller turn. It combines a deterministic multilingual keyword and phrase list (the doctor-configurable triggers, including Hindi and Hinglish variants such as "sujan", "khoon nahi ruk raha", "saans lene mein dikkat") with an LLM classifier. **Either one firing triggers escalation.** Life-threatening phrases trigger the 112 / nearest-hospital script first.
3. **An output filter** runs before any bot text is sent or spoken. It blocks:
   - medicine names (a curated list of Indian brand and generic names),
   - dosage patterns (`\d+\s?mg`, "din mein do baar", "tablet le lo"),
   - words that judge severity ("serious nahi hai", "normal hai"),
   - promises ("painless", "guaranteed", "best").

   If something is blocked, the reply is replaced with a safe fallback and an internal flag is logged.

4. **The eval gate** (§6 below).

**WhatsApp text agent.** The LLM handles understanding and phrasing. A **deterministic state machine** handles booking steps and uses interactive buttons for choosing a slot. Patient voice notes are transcribed with Sarvam and then go through the same path. If staff have taken over a thread (`conversations.mode = 'human'`), the bot is completely silent in it.

**Voice agent.** It uses the same tools and the same filter; decision D4 decides where the filter hooks in. If the LLM or voice layer degrades, the call switches to a scripted fallback flow (DTMF or short options, plus transfer to staff) or goes straight to the clinic's own number.

### 5.5 Offline-tolerant dashboard

- A service worker caches the app shell.
- Dexie (IndexedDB) stores today's and tomorrow's schedule, the queue, and the patients in them.
- Changes made offline go into a local **outbox**. Each one has a client-generated idempotency key, so replaying them never creates duplicates.
- When the connection returns, the outbox syncs. If the server rejects a change because of a conflict (e.g. the slot was taken meanwhile), the conflict is shown to the user.
- Data is fetched as small JSON payloads with no heavy client libraries. The target is under 200 KB of JavaScript on first load for the Today view.

### 5.6 Billing and degradation state machine

Wallet states: `active` → `low` (below threshold) → `grace` (balance ≤ 0, within the configurable grace amount for transactional messages) → `suspended`.

| Capability                              | active / low | grace                      | suspended                |
| --------------------------------------- | ------------ | -------------------------- | ------------------------ |
| AI inbound calls                        | ✅           | ❌ forward to clinic phone | ❌ forward               |
| Emergency routing                       | ✅           | ✅                         | ✅ (never metered-gated) |
| Transactional WhatsApp                  | ✅           | ✅ until grace used        | ❌ queued                |
| Outbound campaigns / recalls / AI calls | ✅           | ❌ paused                  | ❌ paused                |
| Owner notification + pay link           | on `low`     | ✅                         | ✅                       |

**RBI e-mandate rules.**

- A pre-debit notification must go out at least 24 hours before each auto-debit. So "auto-recharge" is really a **forecast**: the worker looks at the burn rate over the last 7 days and sends the pre-debit notice early enough that the debit happens before the balance hits the threshold.
- Recharges above ₹15,000 need additional authentication (AFA). So the default recharge amount is capped at ₹15,000, and larger amounts go through a one-tap payment link instead.
- Card data never touches our servers; only Razorpay-hosted checkout is used.

**Spend caps.** Alerts at 50%, 80% and 100% of the cap are sent as WhatsApp templates to the owner. Each alert is sent once per month, deduplicated by key.

**Reconciliation job (nightly).** Compares `usage_ledger` with provider usage APIs and reports (Exotel, Meta, Sarvam, LLM). Any drift over 1% shows up in the Sentio admin panel.

---

## 6. Voice and chat eval suite (design)

- **Case format (YAML).** Each case has: persona (language, age, speaking style, noise), clinic fixture, scripted turns or goal-driven LLM-caller instructions, a fake clock (e.g. "today is 30 Sep, caller says _next Tuesday_"), and **assertions**:
  - `tool_called(name, args-match)`, `tool_not_called`
  - `db.appointment_exists(...)` / `db.no_new_appointments`
  - `said_contains_any`, `never_said(regex / medicine lexicon)`
  - `escalated(type)` within N turns
  - `readback_matches_db`
  - `used_respectful_form` (aap/ji, never tum)
  - `max_options_offered ≤ 3`
- **Categories:** every intent · Hindi · English · Hinglish · one regional language (Bengali or Santali/Nagpuri to be decided, based on Jharkhand pilots) · elderly/slow/repeating · interruptions · noisy/garbled transcripts · relative dates at month and year ends · family bookings · visiting consultant bookings · prices outside the list · angry callers · emergencies (every default trigger, in every language) · "are you a robot?" · failed verification · spam/sales/wrong number · silence · opt-out requests.
- **Runner.** Runs `pnpm eval` against a real Postgres (Testcontainers) seeded with a demo clinic, using the real agent code, a real LLM (the configured provider) as the agent, and a simulated LLM caller. `pnpm eval --safety` runs only the release-gate categories.
- **Report.** HTML plus Markdown. Shows pass rate per category, each failed transcript with the assertion that failed, and the gate status.
  - **Gate:** 100% on `emergency`, `safety`, `never_invent_booking`, and ≥95% overall.
  - To reduce randomness, each safety case runs 3 times and all 3 runs must pass.
- **Audio subset.** 20+ cases run as real phone calls through the telephony sandbox, using pre-recorded Hindi and Hinglish caller audio.
- **Feedback loop.** Any failure found in production becomes a new YAML case (documented in RUNBOOK).

---

## 7. Phase plan

Each phase ends only when all of its acceptance tests pass in CI. Relative size: S ≈ 1 week, M ≈ 2–3 weeks, L ≈ 4+ weeks (rough estimates for one engineer working with an AI coding agent; they will be refined after Phase 1).

### Phase 0: Scaffolding (S)

- Monorepo, lint/format/typecheck, CI, Testcontainers Postgres, environment config with validation, secrets handling.
- Adapter **interfaces and fakes** for all providers. No real implementations yet.
- Supabase projects for dev, staging and prod (Mumbai). Deploy pipeline for API, worker and web to staging.
- Docs skeletons: `SETUP.md` (numbered steps: create accounts, set secrets, first deploy), `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `COMPLIANCE.md`, `RUNBOOK.md`.
- **Accept when:** CI is green on an empty app, a "hello" staging deploy works, and the founder can follow SETUP.md to redeploy.

### Phase 1: Foundation (L)

- Schema §4.1–4.3 plus appointments, occupancy and holds. RLS, audit triggers, roles and permissions.
- Clinic settings, doctors (including visiting schedules), chairs, procedures (durations, prices, GST mode), hours, holidays, leaves, emergency slots.
- Scheduling engine: slot search, holds, book, move, resize, cancel, buffers, visiting-day rules, emergency reserves.
- Patients (basic profile, family links, search), CSV/Excel import with preview, validation, and duplicate detection by phone. Appointment CSV import.
- Staff PWA: login, Today, a mobile calendar (drag, drop, resize), Patients, audit view, English/Hindi toggle, offline read cache plus action outbox.
- Demo seed script (Hindi names, visiting ortho on Tue/Sat, on-call endo, oral surgeon).
- **Automated acceptance tests:**
  - Unit tests for durations, buffers, holidays, leaves, visiting days, emergency slots, and edges around midnight and DST-free IST.
  - **20 concurrent bookings for one slot → exactly 1 succeeds** (repeated 50 times). Concurrent hold races. Moving onto an occupied slot is rejected by the DB even when app checks are bypassed.
  - The RLS isolation test across all tables.
  - Import of 5,000 patients with duplicates → correct merge preview.
  - Playwright: a receptionist on a 360px-wide viewport books, moves and cancels. Offline → queue → reconnect → synced.

### Phase 2: WhatsApp layer (M)

- WhatsApp Cloud API adapter (send, templates, interactive buttons, media, webhooks with signature check), template management and submission, outbox worker with retry and backoff.
- Booking confirmation, day-before reminder with Confirm/Reschedule buttons, 2-hour reminder, missed-call → WhatsApp (triggered by the telephony webhook).
- Text agent with booking, reschedule, cancel, check, info, prices and directions. Voice-note transcription. Human takeover and release. STOP opt-out. Consent notice (English and Hindi) at first contact.
- Safety output filter and emergency detector v1 (shared with voice).
- **Accept when:** end-to-end tests (fake Meta plus one live sandbox smoke test) show a patient can book, confirm, reschedule and cancel fully over WhatsApp; a staff takeover silences the bot; STOP blocks all further non-critical messages; duplicate webhooks cause no duplicate sends or bookings.

### Phase 3: Voice receptionist (L)

- Week 1: D4 spike, then Exotel adapter (forwarding and virtual numbers, recording with announcement, warm transfer, outbound calls).
- Sarvam voice adapter. Tool API endpoints with p95 under 1.5 s (clinic info and price lists cached, with a load test). Language detection and switching. Caller identification. Booking flow with readback. Price ranges. Emergency escalation ladder (doctor 1 → doctor 2 → staff, WhatsApp alert, critical incident). Callback tasks when a transfer fails. Calls view with recording, transcript, summary, intent, outcome and cost.
- Answer modes: all calls, after N rings, after hours. Fallback: forward to the clinic phone when the voice layer is unhealthy.
- Eval harness v1 with ≥200 cases.
- **Accept when:** the eval gate passes (100% on emergency/safety/never-invent, ≥95% overall) and **50 real test calls by non-team members** succeed. Those calls are logged with a pass/fail form in the dashboard.

### Phase 4: Revenue engine (L)

- Treatment templates and plans, auto-generated sittings, a next-sitting proposal after each completed sitting, continuity ladder, and the "Incomplete treatments" view with rupee values.
- Estimates (PDF on WhatsApp) with a follow-up ladder. No-show recovery. Unconfirmed → AI confirmation call. Recall (6-month, configurable per procedure). Reactivation campaigns that need owner approval. After-care templates plus a next-day check-in with doctor-defined triggers. AI outbound calls under the §6.9 rules. Optional deposit rules.
- **Accept when:** a **simulated 30-day clinic** (fake clock, about 300 patients, scripted replies including opt-outs) produces exactly the expected follow-up schedule (golden file), sends nothing to opted-out patients or outside allowed hours, and the incomplete-treatments totals match a hand-computed fixture.

**Update (27 Sep 2026, Phase 4 done):** Built as planned. Accepted by the 30-day clinic simulation (golden file checked by reading; totals computed by hand), unit and API tests, and dashboard e2e tests. Choices made along the way: advances are requested by payment link, but marking them paid waits for Phase 5; recalls older than 30 days go through campaigns instead (ASSUMPTIONS A-38 to A-43). Not yet tried against the live services: Exotel outbound calls, Supabase Storage, and Meta approval of the 9 new WhatsApp templates.

### Phase 5: Money and billing (L)

- Patient ledger, cash/UPI/card entry, Razorpay payment links with webhook auto-marking, receipts and invoices (PDF, GST per procedure, FY numbering), dues ladder, collections summary, Excel export.
- Wallet, rate cards and margins, real-time metering hooks on every chargeable event, mandates (UPI Autopay, card, e-NACH), pre-debit forecasting, spend-cap alerts, the degradation state machine, GST invoices for license and recharges, reconciliation job.
- Sentio admin panel: clinics, license, wallet, usage, margins, failed payments, integration health.
- **Accept when:** a test month of synthetic usage reconciles with mocked provider bills within 1%; the empty-wallet and failed-mandate scenarios match §4.3 exactly (tested for each capability); and emergency routing still works with a suspended wallet.

### Phase 6: Owner reporting and onboarding (M)

- Nightly 9 pm owner report (WhatsApp template plus a link to a detailed page), weekly and monthly "rupees recovered" (a defined, auditable formula, see ASSUMPTIONS A-12).
- Onboarding wizard (9 steps from §5.16), operator-specific call-forwarding guides (Jio, Airtel, Vi, BSNL, landline) with USSD codes, built-in test call, Meta embedded signup, test mode (a sandbox clinic mirror where owner test calls don't message real patients).
- Complete Hindi UI.
- **Accept when:** a non-technical person onboards a new clinic from scratch in under 2 hours using only the wizard and docs (a timed and recorded trial).

### Phase 7: P1 features (L)

Walk-in queue with tokens and wait-time updates, FDI tooth chart, digital consent forms with signatures, prescriptions from doctor templates only, lab tracking (with the fitment-before-received guard), reviews flow (4–5 → Google review link, 1–3 → private routing), lead capture (Meta lead ads, website form, manual Practo/JustDial), referral tracking.

### Phase 8: Pilot hardening (4 weeks in one clinic)

Daily review of sampled calls, every failure added to the eval suite, per-clinic metrics dashboard (answer rate, conversion, transfer rate, latency, cost per booking), a backup-restore drill, and a review of the compliance defaults in COMPLIANCE.md against the pilot's real usage.

---

## 8. Definition of done (applies to every feature)

- Tested (unit and integration; evals too if agent-facing)
- Visible and correct on the staff dashboard
- Respects opt-outs, consent and roles
- Metered if it costs money
- Has a fallback if a provider fails
- Documented
- An audit log entry for every change it makes

---

## 9. Main risks and how the plan reduces them

| Risk                                              | Mitigation                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The voice provider can't support our safety hooks | D4 spike in Phase 3 week 1, with a self-orchestrated fallback path behind the same adapter                                                                              |
| Voice latency over 1.5 s                          | Cached clinic data, pre-computed slot search indexes, a latency budget in CI load tests                                                                                 |
| LLM hallucinating bookings or prices              | Structurally impossible: bookings exist only from DB commits, prices only from the table, readback is generated by code, and the eval gate enforces it                  |
| Legal interpretation (DPDP, TRAI, DCI)            | Everything is behind configuration switches; COMPLIANCE.md records the safest default taken for each (no legal review, by founder decision); all are settings, not code |
| Unpredictable clinic bills                        | Real-time metering, visible per-call cost, caps and alerts, a pre-debit forecast                                                                                        |
| Provider churn (voice has changed three times)    | Adapters with contract tests. Swapping a provider = one new adapter plus passing the shared contract test suite                                                         |
