# Architecture

The full design and its reasoning are in [PLAN.md](PLAN.md). This page describes **what exists in the code today** and how the pieces fit. It is updated at the end of every phase.

## Current state: Phase 3 (phone calls)

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
              src/admin/                          Sentio admin commands (create a clinic, demo data)
  worker/     Graphile Worker jobs: heartbeat, release expired holds, emergency reserves,
              process_inbound (run the assistant on a message), send_outbox (+ a sweeper),
              plan_messages (booking confirmations, reminders, cancellations, unconfirmed tasks),
              fetch_recording, purge_recordings (nightly, after the retention period)
  voice/      Phone-call media server: one WebSocket per call from the phone company; turn detection,
              speech-to-text, dialogue, text-to-speech, barge-in, heartbeat
  web/        Next.js staff dashboard (installable on Android): Today, Calendar, WhatsApp inbox, Tasks,
              Patients, Phone calls, Import, Settings (incl. WhatsApp and phone assistant), Activity;
              English/Hindi; offline cache and outbox
packages/
  shared/     Money in paise, Indian phone numbers, UUIDv7, PII scrubbing, redacting logger, env loader,
              encryption of provider credentials
  adapters/   Interfaces for all 7 external providers, a fake for each, contract test suites;
              real adapters so far: WhatsApp Cloud API, Anthropic (LLM), Exotel (calls), Sarvam (speech);
              audio helpers (WAV, resampling)
  db/         SQL migrations, migration runner, clinic-scoped transactions, test helpers
  core/       Domain logic: scheduling engine and service, patients, imports, permissions, clinic creation,
              comms (contact policy, outbox, templates, reminders, conversations)
  agent/      The assistants: language, date and time understanding (Devanagari romanized first), intent
              detection, emergency detector, output safety filter; the WhatsApp assistant; the phone
              assistant (dialogue, spoken texts, call routing, call flow); test harnesses; the voice eval suite
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

| Suite                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`            | Double booking is impossible, including 50 rounds of 20 simultaneous bookings; isolation across all 28 tenant tables; audit trail; append-only tables                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core`          | Availability rules (shifts, visiting days, buffers, leave, holidays, equipment, dates around month and year ends); holds and races; staff overrides; 5,000-patient import with duplicate detection                                                                                                                                                                                                                                                                                                                                        |
| `apps/api`               | Sign-in, roles and permissions, cross-clinic isolation over HTTP, 20 simultaneous HTTP bookings giving one success, validation                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/agent`         | Whole chats with a simulated patient: consent; a new patient books end to end (three held times, read-back, explicit yes); confirm, reschedule and cancel; never confirms a booking the database did not save; staff takeover; STOP/START; duplicate webhooks answered once; emergencies (fixed script, 112 advice, critical task, doctor alert, even before consent); prices only from the clinic's list; honest "are you a robot?"; replies in the patient's language; voice notes; the safety filter; Hindi/Hinglish dates and intents |
| `apps/api` (WhatsApp)    | Webhook signature and verification, duplicate webhooks ignored, inbox, take over / hand back, 24-hour window enforced on staff replies, tasks, WhatsApp connection and templates                                                                                                                                                                                                                                                                                                                                                          |
| `packages/agent` (voice) | Whole phone calls at the text level: booking in Hindi (Devanagari transcripts) and English at the time asked for, changing times, emergencies (also mid-booking), staff hand-over, medical questions refused, prices only from the list, timings and address, silence, mishearing, keypad, cancel and move, own-number check, language switching, routing (assistant off, unhealthy, after-hours mode)                                                                                                                                    |
| Voice eval suite         | 240 scripted calls (incl. 40 held-out phrasings), run without the language model; gate: 100% on emergency, safety and never-invent, ≥95% overall (`pnpm eval:voice`)                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/voice`             | Real audio over a WebSocket with a fake Exotel: booking end to end, barge-in, notices not interruptible, silence, emergency hand-over, filler, speech-to-text failure, keypad, wrong key refused, 10 calls at once with p95 reply time under 1.5 s; turn detection on noise, clicks and noisy lines                                                                                                                                                                                                                                       |
| `apps/api` (calls)       | Call-flow URLs: secret key, routing by heartbeat, ring order, missed calls (task + WhatsApp), status callback; calls list, transcript, test results; voice settings                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/e2e`           | At 360px on a touch phone: book, drag to move, drag to resize, cancel; offline change queued then synced; app opens offline; Hindi; take over a WhatsApp chat, reply, hand back, close a task; review a phone call and mark a test result                                                                                                                                                                                                                                                                                                 |
