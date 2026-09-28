# Sentio Dental OS

An AI front desk and practice automation system for Indian dental clinics, built by Sentio Care Pvt Ltd.

Clinics buy it **once** (a perpetual license, no subscription). They save a payment method at onboarding, and only actual usage (call minutes, WhatsApp, AI processing) is billed against a prepaid wallet that recharges itself.

**Status:** Built and tested. The core: the WhatsApp assistant, the phone assistant (our own speech pipeline) and the leads qualifier for Meta ads. Around it: scheduling that cannot double-book, follow-ups, money and the prepaid usage wallet, the owner report, onboarding, the reception desk (walk-in tokens, checkout) and the doctor's record (notes, tooth chart, prescriptions). No more features are planned; next is a pilot in one clinic, once the provider accounts and keys are added (docs/SETUP.md).

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
