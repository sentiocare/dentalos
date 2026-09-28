# Architecture

The full design and its reasoning are in [PLAN.md](PLAN.md). This page describes **what exists in the code today** and how the pieces fit. It is updated at the end of every phase.

## Current state: Phase 6, plus the reception desk and the doctor's record

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
              /webhooks/whatsapp                  Meta webhook: signature check, store, hand to the worker
              /v1/inbox, /v1/tasks                WhatsApp chats, take over / hand back, staff replies, tasks
              /v1/whatsapp                        connect a clinic's number, template approval status
              /telephony/route, after-assistant,  the phone company's call flow asks these what to do
                connect, missed, status
              /v1/calls, /v1/voice                call list, transcripts, recordings, test results, settings
                                                  (incl. confirmation calls)
              /v1/treatment-templates, /v1/…/plans treatment plans and sittings, next-sitting proposal
              /v1/estimates, /v1/…/estimates      estimates: from a plan or by hand, PDF, send, decision
              /v1/incomplete-treatments           plans with sittings still to come, and their value
              /v1/followups, /v1/followup-ladders follow-up runs (list, stop) and the owner's ladders
              /v1/campaigns, /v1/…/marketing-consent reactivation campaigns (wording check, owner approval)
              /v1/…/account, /charges, /payments  patient bills: charges, payments with receipts, invoices,
              /v1/ledger/…, /v1/receipts, /v1/invoices  discounts, refunds, corrections, PDFs, payment links
              /v1/collections, /v1/dues, /v1/ledger/export  collections by day and method, dues, Excel rows
              /v1/payments-account                the clinic's own Razorpay keys (encrypted)
              /v1/wallet                          the Sentio usage wallet: balance, usage, top-up, mandate, invoices
              /v1/admin/…                         Sentio admin panel: clinics, license, rates, reconciliation, health
              /v1/leads, /v1/lead-settings        leads from ads: list, detail, call outcomes, funnel; the Page and alert phone
              /webhooks/meta-leads                Meta lead-form webhook (signed; routed to the clinic by Page)
              /v1/reports                         owner report (day, week, month) and "rupees recovered"
              /v1/setup, /v1/test-mode            setup checklist and test mode
              /v1/desk, /v1/queue/…               the day's queue with tokens, walk-ins, send in, counts
              /v1/appointments/:id/checkout       a visit's bill: charges, payments, suggested price
              /v1/patients/:id/clinical, /notes,  case notes, tooth chart, prescriptions (and their
                /teeth, /prescriptions, /v1/rx-…  PDF and WhatsApp), prescription templates
              /webhooks/payments/clinic/:id       patients' payments (the clinic's own gateway account)
              /webhooks/payments/sentio           licenses, recharges and mandates (Sentio's gateway account)
              src/admin/                          Sentio admin commands (create a clinic, demo data)
  worker/     Graphile Worker jobs: heartbeat, release expired holds, emergency reserves,
              process_inbound (run the assistant on a message), send_outbox (+ a sweeper),
              plan_messages (booking confirmations, reminders, cancellations, unconfirmed tasks),
              fetch_recording, purge_recordings (nightly, after the retention period),
              followups (every 5 minutes: start and advance follow-up ladders, expire estimates),
              place_call (AI confirmation call, rules re-checked just before dialling), request_deposit,
              send_receipt, wallet_watch (owner notices, spend alerts), recharge_forecast (hourly, pre-debit
              notices), recharge_debit (every 15 minutes), reconcile (nightly), fetch_lead and lead_kickoff (a new
              lead gets its first WhatsApp within a minute), owner_report (hourly; sends at 9 pm clinic time)
  voice/      Phone-call media server: one WebSocket per call from the phone company; turn detection,
              speech-to-text, dialogue, text-to-speech, barge-in, heartbeat
  web/        Next.js staff dashboard (installable on Android): Today, Calendar, WhatsApp inbox, Tasks,
              Patients, Phone calls, Leads, Reports, Setup checklist, Import, Settings (incl. WhatsApp,
              phone assistant, lead ads), Activity;
              English/Hindi; offline cache and outbox
packages/
  shared/     Money in paise, Indian phone numbers, UUIDv7, PII scrubbing, redacting logger, env loader,
              encryption of provider credentials
  adapters/   Interfaces for all 7 external providers, a fake for each, contract test suites;
              real adapters so far: WhatsApp Cloud API, Anthropic (LLM), Exotel (calls), Sarvam (speech), Razorpay (payments), Supabase (storage);
              audio helpers (WAV, resampling)
  db/         SQL migrations, migration runner, clinic-scoped transactions, test helpers
  core/       Domain logic: scheduling engine and service, patients, imports, permissions, clinic creation,
              comms (contact policy, outbox, templates, reminders, conversations),
              revenue (treatment templates and plans, estimates and their PDF, follow-up engine, campaigns)
              billing (patient ledger, receipts and invoices, payment links; metering, the usage wallet and
              what each state allows; license, mandates, recharges, Sentio's GST invoices, reconciliation)
              leads (capture, qualifying answers, scoring, staff call tasks, funnel), reports (owner report,
              rupees recovered, nightly WhatsApp), clinics (setup checklist, test mode)
  agent/      The assistants: language, date and time understanding (Devanagari romanized first), intent
              detection, emergency detector, output safety filter; the WhatsApp assistant; the phone
              assistant (dialogue, spoken texts, call routing, call flow, outbound confirmation calls);
              follow-up buttons on WhatsApp; test harnesses; the voice eval suite; the 30-day clinic simulation
```

## How a WhatsApp message flows

1. **In.** Meta calls `/webhooks/whatsapp`. The API checks the signature, finds the clinic from the phone number ID, ignores repeats (`webhook_events`), stores the message and queues `process_inbound`. It answers Meta within milliseconds.
2. **Understand.** The worker runs the assistant for that one chat (chats are processed one message at a time). Emergencies are checked first, by keyword rules that need no AI. Then the message is understood: buttons and simple phrases by rules, free text by the LLM, which only returns a structured guess (intent, date, time, name). Every guess is checked against the clinic's real data.
3. **Act.** The assistant uses the same scheduling engine as the dashboard: slots are held for a few minutes while the patient chooses, and the booking is saved with the same double-booking protection.
4. **Reply.** Replies are chosen from fixed, reviewed texts, never written by the AI. They go through the safety filter and into the **outbox** in the same database transaction as the booking, so a reply is never sent for a booking that didn't save.
5. **Send.** `send_outbox` sends each message once (atomic claim, dedupe key) and checks the rules again at send time: opt-outs, quiet hours, the 24-hour window and template approval. Failures retry with backoff. Everything sent or blocked is recorded in the chat.
6. **People.** Staff see every chat in the inbox. Replying or tapping **Take over** silences the assistant for that chat until they hand it back. Anything the assistant can't or mustn't handle becomes a **task** (call back, emergency, complaint, unconfirmed booking).

Reminders work the same way: any booking change queues `plan_messages`, which decides what each appointment needs (confirmation, day-before and same-day reminders, cancellation notice) and queues it with a key that includes the appointment time. If the appointment moves or is cancelled before sending, the old message is dropped at send time.

## How a phone call flows

1. **Ring.** The patient calls the clinic. If the clinic doesn't pick up (or always, by the clinic's choice), the operator forwards the call to the clinic's Exotel number.
2. **Route.** Exotel asks `/telephony/route`. We record the call and decide: the assistant answers, or the clinic's phone rings (assistant switched off, "only outside clinic hours", or the voice service's heartbeat is older than a minute). If our API cannot be reached at all, Exotel's own fallback step rings the clinic phone.
3. **Stream.** Exotel opens a WebSocket to the `voice` service and streams the call audio both ways (8 kHz). Everything from here is our code:
   - **Turn detection** (`apps/voice/src/audio/endpointer.ts`): finds speech against a noise floor that adapts to the line, and decides the caller has finished after a short silence (shorter for yes/no answers, longer for names).
   - **Speech-to-text** (Sarvam): the finished utterance, as a WAV file.
   - **Dialogue turn** (`packages/agent/src/voice/dialog.ts`): in one database transaction, understand the sentence (rules first; the language model only for unclear sentences, with 3.5 s to answer), act (hold, book, move, cancel, create tasks), and choose the reply from fixed texts. Emergencies are checked before anything else. Every sentence passes the safety filter.
   - **Text-to-speech** (Sarvam): all sentences are synthesised at once and played in order; fixed sentences come from an in-memory cache, so they start instantly.
   - **Barge-in:** if the caller talks over a reply, playback is cleared at once and the caller is heard. Notices and emergency scripts cannot be talked over.
   - **Filler and silence:** "one moment" when understanding takes over 1.2 s; "are you there?" after 7 s of silence, then a polite goodbye.
4. **Hand-over.** To transfer, the assistant stores the numbers to ring (for emergencies: doctors in emergency order, then staff, then the clinic phone) and closes the stream. Exotel asks `/telephony/after-assistant` and `/telephony/connect`, and rings them in order. If nobody answers, `/telephony/missed` creates a call-back task and sends the caller a WhatsApp message.
5. **After the call.** Exotel's status callback gives the duration and recording; the worker copies the recording into our storage in India and deletes it after the retention period. Staff see every call under **Phone calls**: summary, transcript, reply times, recording and any tasks.

If anything fails during a call, the caller is put through to the clinic phone rather than left in silence.

## How follow-ups work

Every follow-up is a **run**: one per reason and subject. Examples: "next sitting of this plan", "this estimate", "this missed appointment", "this patient's recall". A unique key means the same reason never starts twice. Each run walks a **ladder** of steps: a WhatsApp, a staff task, or (for unconfirmed appointments only) an AI call. The worker checks every 5 minutes, in two passes:

1. **Plan:** find new reasons and start runs. These are sittings now due, estimates sent, no-shows, appointments still unconfirmed the day before, recalls due, and visits that need after-care.
2. **Advance:** for each run whose time has come, first check whether the reason has gone. The patient may have booked, replied, accepted, opted out, or the appointment may have been confirmed. If so the run stops. Otherwise the step is taken and the next step's time is set.

Messages go through the same outbox as everything else, so the contact rules (hours, opt-outs, the 24-hour window, templates) are applied in one place. Buttons on follow-up messages ("Book next sitting", "OK" on an estimate, check-in answers) come back to the WhatsApp assistant. It checks each button against the sender's own records before acting.

A sitting's status follows its appointment through a database trigger. Booked, completed and no-show states on the appointment update the sitting, so plan progress and the "Incomplete treatments" value never drift from the calendar.

## How money is kept straight

- **Two ledgers, both append-only.**
  - The **patient ledger** holds what each patient was charged and paid. The balance is the sum of the rows.
  - The **usage ledger** holds what each clinic used from Sentio. Each call, template or chat turn is priced from the rate card in force at that moment.
  - The database refuses edits and deletions. Corrections are new rows with a reason.
- **Metering happens where the cost happens.**
  - A call is metered when it ends (speech and AI) and when the phone company reports its length (minutes).
  - A WhatsApp template is metered when it is sent.
  - A chat is metered when the assistant has answered.
  - Each row is unique per kind and reference, so metering twice never charges twice.
- **The wallet balance is kept by a database trigger** from credits minus usage. The wallet's state (active, low, grace, suspended) is derived from that balance. The single function `walletAllows` decides what each state permits. The call router, the outbox, the WhatsApp assistant, the follow-up engine, campaigns and outbound calls all ask it. Emergencies never do.
- **Automatic recharges.**
  1. The worker forecasts from the last 7 days' spend.
  2. It stores the recharge with its notice time and sends the pre-debit WhatsApp.
  3. It debits only after 24 hours. The database also refuses a debit dated sooner.
  4. The gateway's webhook credits the wallet and issues the GST invoice, once.
- **Webhooks are claimed and applied in one transaction.** A retry after success changes nothing, and a crash part-way leaves the event for the gateway's retry.

## The reception desk

- **One queue, with tokens.** When a booked patient is marked arrived, a database trigger gives them the day's next token. A walk-in gets a token when the desk adds them. Tokens restart at 1 each day; an advisory lock stops two desks giving out the same number.
- **Walk-ins never push booked patients back.** A walk-in has no appointment while waiting. When the desk sends them in, the appointment starts now and runs for the treatment's duration, but is cut short to end before the doctor's or chair's next booking. If less than 5 minutes are free, the desk is told to choose another doctor or chair.
- **A visit finished early ends when it ended.** Marking it done before the booked end moves the end time back, so the doctor and chair are free at once.
- **Checkout** reads the visit's charges and payments, the patient's earlier dues, and suggests the price (the treatment plan's sitting value, else the treatment's price). It uses the normal ledger calls, each with its own idempotency key, so a double tap never charges twice.
- **Desk layout.** Screens 1024px and wider get the side menu with counts, the top bar (patient search, + Walk-in, + Appointment) and the four-column Today board; phones keep the single column and bottom menu.

## The doctor's record

Case notes (one per visit; edits kept in the audit log), a tooth chart (FDI numbers; each tooth shows its latest finding, older ones are its history) and prescriptions. Prescriptions are numbered `RX/2026-27/0001`, can't be changed or deleted (the database refuses), and a wrong one is cancelled with a reason and stays on file. The PDF prints the doctor's qualification and registration number. Only doctors and the owner can write clinical records (`clinical.write` can't be granted to anyone else); chair-side assistants can read them, and the owner can let reception read them. The assistant (WhatsApp and phone) never reads or writes any of this.

## How a lead becomes a patient

The proven pattern for ad leads is **speed plus a human close**: reply within minutes (leads reached in the first 5 minutes convert far better than those reached an hour later), let automation qualify and warm, and have a person make the call that closes. Sentio does exactly that:

1. **Capture.** A Meta lead form fires the webhook; the worker fetches the lead with the Page token. A tap on a Click-to-WhatsApp ad arrives as a chat carrying the ad's referral. Staff add phone, walk-in, JustDial or Practo leads by hand. The same phone is never two leads.
2. **First contact within a minute**, on WhatsApp, in the language the person wrote in. It asks at most two tap-questions: what they need, then when they want to come (skipping any the form already answered).
3. **Score.** Pain, "this week" or high-value work (implants, braces, cosmetic or smile work) is **hot**. A hot lead, or anyone who taps "Call me", gets a staff call task due within 15 minutes of clinic hours, and a WhatsApp alert to the chosen staff phone.
4. **Book.** The assistant offers consultation slots in the same chat; the booking is the normal one (the database commits it).
5. **Follow up.** No reply: a nudge the next morning, a staff call task, another nudge, a last call task, then two check-ins a week apart that answer the usual doubts. If WhatsApp can't deliver to the number at all, a person is asked to call at once. It stops the moment the lead books, says STOP, or staff mark it lost.
6. **The assistant calls, people close.** About 3 minutes after the first WhatsApp, the assistant phones the lead (in calling hours; a night lead is called at 09:00): it introduces the clinic, asks what they need, and books a consultation on the call. It calls once more the next afternoon if nothing is booked. A lead already chatting on WhatsApp isn't called. "Busy, call later" becomes a call-back task for a person two hours later; "not interested" or "wrong number" closes the lead. Hot leads still go to a person within 15 minutes. Staff calls are logged with outcomes (booked, call back, not interested, wrong number), and the lead's stage then follows the clinic's own records: booked → visited → won (with the rupee value from the ledger). The funnel shows each campaign's leads, bookings, visits and revenue.
7. **Teach the ads.** Every 15 minutes, the stages reached by leads from Meta (qualified, booked, visited, won with the amount) are sent back to the clinic's Meta dataset through the Conversions API, so Meta finds more people like those who became patients (`core/leads/signals.ts`).

## How the owner report counts "rupees recovered"

A payment counts when it was made within 30 days **after** a Sentio follow-up reached that patient (next sitting, estimate, missed visit, recall, dues or lead). Each payment counts once, for the latest follow-up before it; reversed payments don't count. The report lists every counted payment with the follow-up behind it, so anyone can check each rupee. It shows money that came in after follow-ups, not proof that the follow-up alone caused it.

## Test mode

While test mode is on, the outbox and the confirmation-call check allow only staff numbers and listed test numbers. Everything else is recorded as blocked with the reason `test_mode`, so the owner can test end to end without messaging a real patient.

## How a booking stays correct

1. **Offering slots.** The **availability engine** (`core/scheduling/availability.ts`) works out free slots. It is a pure function of the clinic's configuration (hours, breaks, visiting days, holidays, leave, procedure length and buffer, chair equipment) and what is already busy. The dashboard imports the same code to shade non-working time, so the screen and the server always agree.
2. **Holding and booking.** Every appointment, hold and emergency reserve writes one row per doctor and one per chair into `resource_occupancy`. A Postgres exclusion constraint makes overlapping rows impossible, so a double booking cannot be stored, whatever the application code does. The rows are written only by database triggers. Resources are locked in a fixed order, so two racing bookings never deadlock: one wins, the other gets "slot taken".
3. **Staff overrides.** Staff can book outside the normal schedule after seeing the warnings ("book anyway?"). They can never override a clash.
4. **Retries.** Every booking request from the dashboard carries an idempotency key. Retrying after a dropped connection returns the same appointment instead of creating a second one.

## Security model

- **Sign-in.** Staff sign in with a code sent to their email (Supabase Auth); they are invited by email. The API verifies the token and then looks up the person's clinic and role in `clinic_memberships`. Nothing about clinic or role is trusted from the token.
- **Row-level security.** Every request runs inside `withClinic(...)`: one transaction, switched to the restricted `app_user` role, with the clinic set for that transaction only. Every tenant table has a policy for `app_user`, and child rows point to parents by `(clinic_id, id)`, so a row can never reference another clinic's data. Supabase's public `anon`/`authenticated` roles have no access to our tables at all.
- **Permissions.** One matrix (`core/access/permissions.ts`) is used by both the API and the dashboard. The owner can switch individual permissions off, for example revenue for a receptionist. The clinic can never lose its last owner.
- **Audit.** A database trigger records every change to clinic data in `audit_log`: who, what, before and after. The table cannot be edited or deleted.
- **Logs.** Logs never contain patient data. The logger scrubs names, phone numbers and emails, drops query strings, and never logs job payloads.

## Offline behaviour (dashboard)

- **App shell.** The service worker caches the app itself, so it opens without internet.
- **Data.** The clinic configuration and each viewed day's appointments are kept in IndexedDB on the phone. Without internet, the screens show that copy with an "offline" note.
- **Changes.** Status changes, moves, cancellations and bookings made offline wait in an on-device outbox. They are sent in order when the connection returns. Anything the server refuses (for example, the slot was taken meanwhile) is listed for staff to look at.

## Tests

| Suite                      | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`              | Double booking is impossible, including 50 rounds of 20 simultaneous bookings; isolation across all 28 tenant tables; audit trail; append-only tables                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core`            | Availability rules (shifts, visiting days, buffers, leave, holidays, equipment, dates around month and year ends); holds and races; staff overrides; 5,000-patient import with duplicate detection                                                                                                                                                                                                                                                                                                                                        |
| `apps/api`                 | Sign-in, roles and permissions, cross-clinic isolation over HTTP, 20 simultaneous HTTP bookings giving one success, validation                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/agent`           | Whole chats with a simulated patient: consent; a new patient books end to end (three held times, read-back, explicit yes); confirm, reschedule and cancel; never confirms a booking the database did not save; staff takeover; STOP/START; duplicate webhooks answered once; emergencies (fixed script, 112 advice, critical task, doctor alert, even before consent); prices only from the clinic's list; honest "are you a robot?"; replies in the patient's language; voice notes; the safety filter; Hindi/Hinglish dates and intents |
| `apps/api` (WhatsApp)      | Webhook signature and verification, duplicate webhooks ignored, inbox, take over / hand back, 24-hour window enforced on staff replies, tasks, WhatsApp connection and templates                                                                                                                                                                                                                                                                                                                                                          |
| `packages/agent` (voice)   | Whole phone calls at the text level: booking in Hindi (Devanagari transcripts) and English at the time asked for, changing times, emergencies (also mid-booking), staff hand-over, medical questions refused, prices only from the list, timings and address, silence, mishearing, keypad, cancel and move, own-number check, language switching, routing (assistant off, unhealthy, after-hours mode)                                                                                                                                    |
| Voice eval suite           | 240 scripted calls (incl. 40 held-out phrasings), run without the language model; gate: 100% on emergency, safety and never-invent, ≥95% overall (`pnpm eval:voice`)                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/voice`               | Real audio over a WebSocket with a fake Exotel: booking end to end, barge-in, notices not interruptible, silence, emergency hand-over, filler, speech-to-text failure, keypad, wrong key refused, 10 calls at once with p95 reply time under 1.5 s; turn detection on noise, clicks and noisy lines                                                                                                                                                                                                                                       |
| `apps/api` (calls)         | Call-flow URLs: secret key, routing by heartbeat, ring order, missed calls (task + WhatsApp), status callback; calls list, transcript, test results; voice settings                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/core` (revenue)  | Plans from templates, sitting windows, next-sitting proposal; estimates and PDF; every ladder step and stop condition; recall window; campaign wording check, consent and opt-out filtering, owner approval                                                                                                                                                                                                                                                                                                                               |
| Clinic simulation          | **Phase 4 acceptance:** 30 simulated days, 300 patients, hourly clock, scripted replies including STOP. The follow-up schedule must match the golden file exactly. Nothing is sent after an opt-out or outside the allowed hours. Incomplete-treatment totals must match a hand-computed figure                                                                                                                                                                                                                                           |
| `packages/agent` (Phase 4) | Follow-up buttons (book a sitting, estimate OK / call me, check-in answers) checked against the sender's records; outbound confirmation calls: confirm, change, staff, "don't call me", and every rule that stops a call                                                                                                                                                                                                                                                                                                                  |
| `packages/core` (billing)  | Financial year and GST maths; receipts numbered without gaps even when taken at once; discounts, refunds, reversals; invoices (bill of supply or tax invoice); payment links paid once; dues reminders; metering once per event; every wallet state against every capability; owner notices once per change; license, mandate, the 24-hour debit rule, failed debits, top-ups, reconciliation                                                                                                                                             |
| Billed-month simulation    | **Phase 5 acceptance:** 30 days, over 500 calls, templates and chats through the real code, a mandate revoked mid-month. Provider bills computed from the raw events reconcile within 1%. Calls, reminders, campaigns and emergencies behave as §4.3 in each state the wallet passes through. Every debit was announced 24 hours ahead and was at most ₹15,000                                                                                                                                                                            |
| `apps/web/e2e`             | At 360px on a touch phone: book, drag to move, drag to resize, cancel; offline change queued then synced; app opens offline; Hindi; take over a WhatsApp chat, reply, hand back, close a task; review a phone call and mark a test result                                                                                                                                                                                                                                                                                                 |
