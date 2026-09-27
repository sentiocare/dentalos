# Compliance

This document tracks how Sentio Dental OS meets each compliance requirement in Build Prompt §7. It is updated in every phase.

Where the law needs interpreting, the product uses **configurable settings** and the question is listed under "Open questions for the lawyer". We do not guess the law.

**Status legend:**

- ✅ Built and tested
- 🟡 Partly built
- ⏳ Planned (phase shown)

## Roles

- **Clinic:** Data Fiduciary.
- **Sentio Care Pvt Ltd:** Data Processor.

The data processing agreement (DPA) signed at purchase has to reflect this split. In the product, the split shows up like this:

- the clinic's owner approves consent notices, templates and campaigns;
- the clinic handles patient data requests from its dashboard;
- Sentio staff can only see operational data (health, billing, usage) in the admin panel, not patient records, unless the clinic grants support access for a limited time.

## Requirements

| #   | Requirement                                                                                                                                                                                                             | How it is met                                                                                                                                                                                                                                                                                                                                                                                             | Status                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | **DPDP Act 2023 and Rules**: consent notice (English and Hindi) at first contact, purpose-specific consent records, withdrawal, access and deletion requests, data minimisation, retention and purging, breach workflow | `consents` (append-only, per purpose, with notice version and evidence), `opt_outs`, `data_requests` handled from the dashboard, retention jobs, `breach_log` with notification workflow                                                                                                                                                                                                                  | ⏳ Phases 1, 2, 5                                                                                       |
| 2   | **Data localisation**: all databases, storage and backups in India                                                                                                                                                      | Supabase project in Mumbai (`ap-south-1`) holds all persistent data, including files and backups. The API and worker store nothing locally. SETUP.md Part B makes the Mumbai region a checked step.                                                                                                                                                                                                       | 🟡 Enforced for storage. Compute region is decision D1.                                                 |
| 3   | **Health data security**: encryption, per-clinic isolation, role-based access, audit logs, no PII in logs, PII redaction for analytics                                                                                  | Row-level security on every tenant table, with the backend running as the restricted `app_user` role per transaction (`withClinic`) and a test proving clinics cannot see each other's rows. PII-scrubbing logger (names, phones, emails, transcripts removed; query strings dropped). Sentry events scrubbed the same way. Append-only trigger for audit tables. TLS and at-rest encryption by Supabase. | 🟡 Foundation built in Phase 0 (RLS mechanism, scrubbing, append-only). Roles and audit log in Phase 1. |
| 4   | **Call recording announced** at the start of every recorded call                                                                                                                                                        | The greeting script always includes the recording line when recording is on. The eval suite asserts it.                                                                                                                                                                                                                                                                                                   | ⏳ Phase 3                                                                                              |
| 5   | **TRAI commercial communication**: transactional vs promotional separation, DND, opt-outs, registered headers, calling hours                                                                                            | `CommsPolicy.canContact` is the single gate: category, opt-outs, DND cache, allowed hours clamped to legal limits. SMS adapter refuses to send without a DLT template ID (built). Promotional AI calls stay **off** until the registration route is confirmed (A-10).                                                                                                                                     | 🟡 SMS guard built; policy engine in Phases 2 and 4                                                     |
| 6   | **WhatsApp Business policy**: opt-in, approved templates outside the 24-hour window, correct categories, STOP opt-out                                                                                                   | Template registry with category and approval status. 24-hour window check. STOP and Hindi equivalents record an opt-out immediately.                                                                                                                                                                                                                                                                      | ⏳ Phase 2                                                                                              |
| 7   | **DCI advertising ethics**: owner-approved templates, no superlatives, no fake urgency, no testimonials without consent                                                                                                 | Campaigns and marketing templates need an `owner_approved_by`. The output filter blocks superlatives and promises. Safe default templates are provided.                                                                                                                                                                                                                                                   | ⏳ Phases 2 and 4                                                                                       |
| 8   | **Medical safety**: no diagnosis, medicines or dosages; emergency escalation                                                                                                                                            | Enforced in prompts **and** code: an output filter (medicine lexicon, dosage patterns, severity judgements), an emergency detector (keywords OR classifier), and a 100% eval gate on safety cases                                                                                                                                                                                                         | ⏳ Phases 2 and 3                                                                                       |
| 9   | **Payments**: RBI recurring-payment rules; no card data on our servers                                                                                                                                                  | Only gateway-hosted checkout. The `PaymentProvider` interface has no card fields at all. Pre-debit notice is scheduled from a forecast of the burn rate. Auto-recharge is capped at ₹15,000 (additional authentication above that).                                                                                                                                                                       | 🟡 Interface built; flows in Phase 5                                                                    |
| 10  | **AI disclosure**                                                                                                                                                                                                       | The greeting identifies the assistant as the clinic's digital assistant. "Are you a human?" gets an honest answer, and the eval suite checks it.                                                                                                                                                                                                                                                          | ⏳ Phase 3                                                                                              |

## Open questions for the lawyer

These must be answered before the pilot (Phase 8).

1. **(D1)** Is it acceptable for the API and worker compute to run outside India (e.g. Railway Singapore) when no data is stored there? Or must compute also be in India?
2. **(D5)** Can PII-redacted conversation text be sent to an LLM hosted outside India? What should the DPA say about sub-processors?
3. **(D6)** What is the correct TRAI/DLT registration route for:
   - (a) Sentio-sent transactional SMS fallbacks, and
   - (b) promotional AI voice calls made on behalf of clinics?

   Which numbering series applies to AI outbound calls?

4. **(A-9)** Please confirm the pre-debit notification timing and the additional-authentication limit that apply to usage-wallet auto-recharges.
5. **Retention periods** for:
   - call recordings,
   - transcripts,
   - WhatsApp messages,
   - clinical notes (which may be covered by medical-records retention norms), and
   - billing records (tax law).
6. **Consent notice** wording in English and Hindi for voice (short, spoken) and WhatsApp (text).
7. Does the **GST treatment** of the license and of usage recharges need separate SAC codes?
