# Sentio Dental OS

An AI front desk and practice automation system for Indian dental clinics, built by Sentio Care Pvt Ltd.

Clinics buy it **once** (a perpetual license, no subscription). They save a payment method at onboarding, and only actual usage (call minutes, WhatsApp, AI processing) is billed against a prepaid wallet that recharges itself.

**Status:** Phase 0 (scaffolding) code is done and tested. The first staging deploy (docs/SETUP.md) needs the founder's Supabase and Railway accounts. Phase 1 (scheduling, patients, dashboard) is next.

## Documents

| Document                                | For                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------- |
| [PLAN.md](docs/PLAN.md)                 | Architecture, data model, phases and acceptance tests                     |
| [SETUP.md](docs/SETUP.md)               | Step-by-step deployment (non-technical) and local development             |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | What exists in the code today                                             |
| [COMPLIANCE.md](docs/COMPLIANCE.md)     | DPDP, TRAI, WhatsApp, DCI, RBI: how each is met, and open legal questions |
| [RUNBOOK.md](docs/RUNBOOK.md)           | What to do when something fails                                           |
| [ASSUMPTIONS.md](docs/ASSUMPTIONS.md)   | Decisions taken where the spec was ambiguous                              |

## Quick start (developers)

```bash
corepack enable && pnpm install
cp .env.example .env
pnpm dev:db && export $(grep -v '^#' .env | xargs)
pnpm db:migrate
pnpm check
```
