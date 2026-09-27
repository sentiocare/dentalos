# Sentio Dental OS

An AI front desk and practice automation system for Indian dental clinics, built by Sentio Care Pvt Ltd.

Clinics buy it **once** (a perpetual license, no subscription). They save a payment method at onboarding, and only actual usage (call minutes, WhatsApp, AI processing) is billed against a prepaid wallet that recharges itself.

**Status:** Phases 0–6 are built and tested: scheduling that cannot double-book, the WhatsApp and phone assistants (our own speech pipeline), follow-ups, money and the prepaid usage wallet, leads from ads, the owner report and onboarding. The reception desk (walk-in tokens, one-sheet checkout, desk layout) and the doctor's record (notes, tooth chart, prescriptions) were brought forward from Phase 7. Next: a pilot clinic (Phase 8).

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
pnpm check                            # format, lint, typecheck, all tests
pnpm --filter @dentalos/api seed:demo  # demo clinic
pnpm e2e                              # browser tests at phone size
```
