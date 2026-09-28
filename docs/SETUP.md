# Setup and deployment guide

This guide is for a non-technical founder. Follow the steps in order. Anything in a grey box is meant to be copied and pasted exactly.

The screens on Supabase and Railway change from time to time. If a button name is slightly different, look for the closest match. The meaning of each step stays the same.

**What you will end up with:**

- **Database** on Supabase, in the **Mumbai** region. This is where all clinic and patient data lives.
- **Three services** on Railway:
  - `api`: the backend that the dashboard, WhatsApp and phone calls talk to.
  - `worker`: runs reminders, follow-ups and reports in the background.
  - `web`: the staff dashboard that staff open on their phones.
- **Two environments**: `staging` (for testing) and `production` (for real clinics). Real clinics are only put on production once every real provider is connected; until then production refuses to start.

---

## Part A: Accounts you need (one time)

1. **GitHub.** The code lives at `github.com/sentiocare/dentalos`. Make sure you are an owner of the `sentiocare` organisation.
2. **Supabase.** Sign up at https://supabase.com with the company email.
3. **Railway.** Sign up at https://railway.com with the same GitHub account (click "Login with GitHub").
4. **Sentry** (optional but recommended). Sign up at https://sentry.io. It emails us when the app crashes. Patient details are removed before anything is sent to it.

---

## Part B: Create the database (Supabase)

Do this twice: once named `dentalos-staging`, once named `dentalos-production`.

1. In Supabase, click **New project**.
2. **Name:** `dentalos-staging` (the second time: `dentalos-production`).
3. **Database password:** click **Generate a password**. Copy it into your password manager **now**. You cannot see it again.
4. **Region:** choose **South Asia (Mumbai)**. This is required by law for patient data (see `docs/COMPLIANCE.md`). Do not pick any other region.
5. Click **Create new project** and wait about 2 minutes.
6. Click **Connect** (at the top of the project page), then choose **Session pooler**.
   - Do **not** use the "Transaction pooler". The background worker needs the session pooler.
7. Copy the connection string. It looks like this:

   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

8. Replace `[YOUR-PASSWORD]` with the password from step 3. This complete line is your **DATABASE_URL**. Save it in your password manager as "DATABASE_URL staging" (or "production").
9. Check that the address contains **`ap-south-1`**. That means Mumbai. If it doesn't, delete the project and start again from step 1.
10. Open **Project Settings**, then **API** (or **Data API**), and save these three values in your password manager:
    - **Project URL**, for example `https://abcdefghijkl.supabase.co`. This is your **SUPABASE_URL**.
    - **anon public** key (a long text). This is your **SUPABASE_ANON_KEY**. It is safe to use in the dashboard; it cannot read any data by itself.
    - Your **AUTH_JWKS_URL**: the Project URL followed by `/auth/v1/.well-known/jwks.json`, for example:

      ```
      https://abcdefghijkl.supabase.co/auth/v1/.well-known/jwks.json
      ```

### B2. Turn on sign-in with an email code

Staff sign in with their email and a 6-digit code sent to it. There are no passwords, and no SMS provider is needed.

1. In Supabase, open **Authentication → Sign In / Providers**. Check that **Email** is **on** (it is by default). Switch **Phone** off.
2. **Send a code, not a link.** Open **Authentication → Emails → Templates**. In both the **Magic Link** and the **Confirm signup** templates, replace the body with:

   ```
   <p>Your Sentio sign-in code is <strong>{{ .Token }}</strong></p>
   <p>It works for 1 hour. If you didn't ask for it, ignore this email.</p>
   ```

   Set both subjects to `Your Sentio sign-in code`, and save.

3. **Send the emails from your own address.** Supabase's built-in sender is only for trying things out: it sends very few emails an hour and only to your own Supabase team. For real clinics:
   - Create a free account at [resend.com](https://resend.com), add your domain (for example `sentio.care`) and follow its steps to verify the domain.
   - In Resend, create an **API key**.
   - In Supabase, open **Authentication → Emails → SMTP Settings**, switch **Enable custom SMTP** on, and enter: host `smtp.resend.com`, port `465`, user `resend`, password = the API key, sender email `login@sentio.care`, sender name `Sentio`.

   Resend's free plan covers 3,000 emails a month, far more than staff sign-ins need.

4. **Who can sign in:** anyone can ask for a code, but the dashboard only opens a clinic for emails that clinic has added (the owner when the clinic is created, staff under **Settings → Staff**). Everyone else sees "This email is not added to a clinic yet".

---

## Part C: Deploy the services (Railway)

### C1. Create the project

1. In Railway, click **New Project**, then **Deploy from GitHub repo**, then select `sentiocare/dentalos`.
   - If the repo is not in the list, click **Configure GitHub App** and give Railway access to it.
2. Railway creates one service automatically. We will configure it as `api` in C2.
3. Open **Project settings**, then **Environments**:
   - rename the default environment to `production`, and
   - click **New environment** and name it `staging`.
4. **Region.** In each service's **Settings**, look for **Region**:
   - If an **India / Mumbai** region is offered, choose it.
   - If not, choose **Singapore** (closest to India).

   No patient data is stored on Railway, only in Supabase Mumbai (see decision 1 in `docs/COMPLIANCE.md`).

### C2. Configure the `api` service

1. Click the service, go to **Settings** and rename it to `api`.
2. Under **Config-as-code** (or "Railway config file"), set the path to:

   ```
   deploy/railway/api.json
   ```

3. Go to the **Variables** tab and click **Raw editor**. Paste this, replacing the DATABASE_URL with yours from Part B step 8:

   ```
   APP_ENV=staging
   LOG_LEVEL=info
   DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   AUTH_JWKS_URL=https://abcdefghijkl.supabase.co/auth/v1/.well-known/jwks.json
   WEB_ORIGINS=https://YOUR-WEB-DOMAIN
   SENTRY_DSN=
   CHANNEL_SECRET_KEY=PASTE-A-RANDOM-KEY
   ```

   - `CHANNEL_SECRET_KEY` locks the clinics' WhatsApp access tokens in the database. Make one on any computer with `openssl rand -base64 32` (or ask engineering), paste it here, and **keep a copy in your password manager**. If it is lost, every clinic has to reconnect WhatsApp. Use a different key for production.

   - Use your own values from Part B steps 8 and 10.
   - You will know `YOUR-WEB-DOMAIN` after step C4. Come back then and fill it in, for example `WEB_ORIGINS=https://web-staging-xxxx.up.railway.app`.
   - If you set up Sentry, paste its DSN after `SENTRY_DSN=`.

4. Go to **Settings**, then **Networking**, then **Generate Domain**. Railway gives you an address like `api-staging-xxxx.up.railway.app`. Save it.

### C3. Add the `worker` service

1. In the project, click **+ Create**, then **GitHub Repo**, then select `sentiocare/dentalos` again.
2. Rename the new service to `worker`.
3. Set its config file path to:

   ```
   deploy/railway/worker.json
   ```

4. Paste only these variables:

   ```
   APP_ENV=staging
   LOG_LEVEL=info
   DATABASE_URL=(the same value as the api)
   CHANNEL_SECRET_KEY=(the same value as the api)
   ```

5. Do **not** generate a domain. The worker does not receive visitors.

### C4. Add the `web` service

1. Click **+ Create**, then **GitHub Repo**, then select `sentiocare/dentalos` again.
2. Rename the new service to `web`.
3. Set its config file path to:

   ```
   deploy/railway/web.json
   ```

4. Paste these variables, using your values from C2 step 4 and Part B step 10:

   ```
   NEXT_TELEMETRY_DISABLED=1
   API_URL=https://YOUR-API-DOMAIN
   SUPABASE_URL=https://abcdefghijkl.supabase.co
   SUPABASE_ANON_KEY=eyJ...the long anon key...
   ```

5. Go to **Settings**, then **Networking**, then **Generate Domain**. This is the dashboard address staff will open.

### C5. Repeat for production

1. Switch the environment selector (top of the screen) to `production`.
2. Repeat C2 to C4 with the **production** DATABASE_URL.
3. **Important:** in production, `APP_ENV=production`. The api and worker **refuse to start** in production until every real provider is connected (Phases 2, 3 and 5). This is intentional: it stops real clinics from being served by test stand-ins. Until then, use staging only.

---

## Part D: Check that it works

1. Open this address in your browser (use your api domain from C2 step 4):

   ```
   https://YOUR-API-DOMAIN/health/ready
   ```

2. You should see a line that starts with `{"ok":true`. Inside it:
   - `"database":{"ok":true}` means the database is connected.
   - `"worker":{"ok":true}` means the background worker is running. Right after the first deploy, this can take up to a minute to turn true.
   - The `provider.…` entries show the test stand-ins for WhatsApp, calls, payments and so on. They are replaced by the real providers as each phase is built.
3. Open your web domain (from C4 step 5). You should see the **Sign in** screen with an **English / हिन्दी** switch.
4. On an Android phone, open the web domain in Chrome. Tap **⋮**, then **Add to Home screen**. The app icon appears like a normal app.

**If something is red:**

| What you see                                         | What to do                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"database":{"ok":false}`                            | The DATABASE_URL is wrong. Redo Part B steps 6–8, paste the value again into Railway's Variables, then click **Deploy**.                                  |
| `"worker":{"ok":false, ...}` for more than 3 minutes | Open the `worker` service, then **Deployments**, then the latest one, then **View logs**. Send a screenshot of the last 20 lines to the engineering team. |
| The api deploy failed at "pre-deploy"                | A database update (migration) failed. Nothing was changed, because each update is all-or-nothing. Send the deploy logs to the engineering team.           |
| Page does not load at all                            | Check that the service has a generated domain (C2 step 4 / C4 step 5) and that the latest deployment says **Active**.                                     |

---

## Part D2: Create a clinic (and the demo clinic)

New clinics are created by Sentio, not by the clinics themselves. You need the Railway command-line tool once.

1. Install **Node.js** (the "LTS" version) from https://nodejs.org.
2. Open **Terminal** (Mac) or **PowerShell** (Windows) and run:

   ```
   npm install -g @railway/cli
   railway login
   railway link
   ```

   When `railway link` asks, choose the Sentio Dental OS project, the **staging** environment and the **api** service.

3. Open a command line inside the running api service:

   ```
   railway ssh
   ```

4. **To create a real clinic**, run this with the clinic's details. The owner signs in with the email. The phone is where the owner gets the nightly report and billing messages on WhatsApp.

   ```
   node admin.js create-clinic --name "Sharma Dental Clinic" --city "Ranchi" --owner-name "Dr. Rakesh Sharma" --owner-email rakesh@gmail.com --owner-phone 9835012345
   ```

   The clinic starts with opening hours Monday–Saturday, 10:00–14:00 and 17:00–21:00, one chair, and a starter list of 21 treatments with Hindi names. Prices start empty; the owner fills them in under **More → Clinic settings → Treatments and prices**.

   **For a sales demo instead**, run:

   ```
   node admin.js seed-demo --owner-email=you@gmail.com --reception-email=your.other@gmail.com
   ```

   This creates "Sharma Dental Clinic (Demo)" with about 80 patients and this week's appointments. Use two email inboxes you can open: sign in with the first to show the owner's view, and with the second for the receptionist's.

5. Type `exit` to leave. The owner can now open the dashboard, sign in with their email, and add staff under **More → Clinic settings → Staff** (name, email, and optionally a mobile number for WhatsApp alerts).

---

## Part D3: Connect WhatsApp (Phase 2)

Until this part is done, the system uses a pretend WhatsApp: nothing reaches real phones.

### One time, for Sentio (about 1 hour, plus Meta's review time)

1. Open [business.facebook.com](https://business.facebook.com) and create a **Meta Business account** for Sentio Care. Complete **business verification** (GST certificate or company documents). Meta takes 1–3 days.
2. Open [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create app** → type **Business** → add the **WhatsApp** product.
3. In the app, go to **App settings → Basic** and copy the **App secret**.
4. Make up a long random **verify token**, for example the output of `openssl rand -hex 24`.
5. In Railway, add these variables to **both** `api` and `worker`, then redeploy:

   ```
   MESSAGING_PROVIDER=whatsapp_cloud
   WHATSAPP_APP_SECRET=(the app secret from step 3)
   WHATSAPP_VERIFY_TOKEN=(the token from step 4)
   LLM_PROVIDER=anthropic
   ANTHROPIC_API_KEY=(from console.anthropic.com → API keys)
   ```

   - `LLM_PROVIDER=anthropic` lets the assistant understand free-form messages such as "kal shaam ko aa sakta hoon?". Without it, the assistant still works through buttons and simple keywords.
   - In the Anthropic console, make sure your data is not used for training. Names and phone numbers are removed before any text is sent (COMPLIANCE decision 2).

6. In the Meta app, go to **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `https://YOUR-API-DOMAIN/webhooks/whatsapp`
   - **Verify token:** the token from step 4
   - Click **Verify and save**, then **Subscribe** to the `messages` field.

### For each clinic

1. In Meta Business Manager, add the clinic's WhatsApp number (**WhatsApp Manager → Phone numbers → Add**). The number must not be in use on the normal WhatsApp app; many clinics buy a new SIM for this.
2. Create a **system user** (Business settings → Users → System users), give it the WhatsApp permissions, and **generate a permanent access token** for the app.
3. The clinic owner opens the dashboard → **More → Clinic settings → WhatsApp** and enters:
   - the **Phone number ID** (WhatsApp Manager → the number; it is a long ID, not the phone number itself),
   - the WhatsApp number, and
   - the access token. It is stored encrypted and can't be read back from the dashboard.
4. After connecting, the same screen lists **14 message templates** (7 messages in English and Hindi). Create each one in **WhatsApp Manager → Message templates** with the same name, language and text. When Meta approves one, set its status to **Approved** in the dashboard.
   - Until a template is approved, its message is only sent while the patient's 24-hour chat window is open. Otherwise it is held back and shows as "Not sent" in the chat.

### Check it works

Send "Hi" from your own phone to the clinic's number. Within a few seconds you should get the welcome message with the privacy notice, and the chat appears in the dashboard under **WhatsApp**.

---

## Part D4: Connect phone calls (Phase 3)

The phone assistant is built by us: the phone company (Exotel) carries the call and streams its audio to our **voice** service; Sarvam turns speech into text and text into speech; everything the assistant decides and says comes from our own code. Until this part is done, calls are not answered by the assistant.

### One time, for Sentio

1. **Sarvam (speech).** Sign up at [dashboard.sarvam.ai](https://dashboard.sarvam.ai), add billing, and create an **API key**.
2. **Exotel (phone numbers).** Open an account at [exotel.com](https://exotel.com) and finish the KYC. Ask Exotel support to **enable the Voicebot (bidirectional streaming) applet** on your account. From **Settings → API**, copy the **Account SID**, **API key** and **API token**. Note which cluster your account is on: Singapore (`api.exotel.com`) or Mumbai (`api.in.exotel.com`).
3. Make up a long random **call-flow token**, for example with `openssl rand -hex 24`. It protects every URL Exotel calls.
4. **Add the `voice` service in Railway** (same way as the worker in Part C3):
   - Config file path: `deploy/railway/voice.json`
   - Variables:

     ```
     APP_ENV=staging
     LOG_LEVEL=info
     DATABASE_URL=(the same value as the api)
     CHANNEL_SECRET_KEY=(the same value as the api)
     TELEPHONY_PROVIDER=exotel
     VOICE_PROVIDER=sarvam
     SARVAM_API_KEY=(from step 1)
     EXOTEL_ACCOUNT_SID=(from step 2)
     EXOTEL_API_KEY=(from step 2)
     EXOTEL_API_TOKEN=(from step 2)
     EXOTEL_API_HOST=api.exotel.com
     EXOTEL_CALLBACK_TOKEN=(the token from step 3)
     LLM_PROVIDER=anthropic
     ANTHROPIC_API_KEY=(same as the api)
     ```

   - **Settings → Networking → Generate Domain.** Save the address, e.g. `voice-staging-xxxx.up.railway.app`.

5. Add these to the **api** and **worker** services too, then redeploy all three:

   ```
   TELEPHONY_PROVIDER=exotel
   VOICE_PROVIDER=sarvam
   SARVAM_API_KEY=...
   EXOTEL_ACCOUNT_SID=...
   EXOTEL_API_KEY=...
   EXOTEL_API_TOKEN=...
   EXOTEL_API_HOST=api.exotel.com
   EXOTEL_CALLBACK_TOKEN=...
   ```

6. Open `https://YOUR-VOICE-DOMAIN/health`. You should see `{"ok":true,...}`.

Optional voice settings (defaults are fine): `VOICE_NO_INPUT_MS` (7000: silence before "are you there?"), `VOICE_FILLER_AFTER_MS` (1200: when to say "one moment"), `VOICE_MAX_CALL_MIN` (15), `VOICE_LLM_TIMEOUT_MS` (3500), `SARVAM_TTS_SPEAKER` (voice name, default `anushka`), `SARVAM_STT_MODEL`, `SARVAM_TTS_MODEL`.

### For each clinic (about 30 minutes)

1. **Buy a number** in Exotel (an "ExoPhone", ideally with the clinic's city code).
2. **Build the call flow** in Exotel (**App Bazaar → Create**). Replace `API` with your api domain, `VOICE` with your voice domain and `TOKEN` with the call-flow token:

   | #   | Applet   | Setting                                                              | Next step                                                                      |
   | --- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
   | 1   | Passthru | URL `https://API/telephony/route?key=TOKEN`                          | Success (200) → 2. Otherwise → 5                                               |
   | 2   | Voicebot | URL `wss://VOICE/media?key=TOKEN` (bidirectional, 8 kHz)             | → 3                                                                            |
   | 3   | Passthru | URL `https://API/telephony/after-assistant?key=TOKEN`                | Success (200) → 4. Otherwise → Hangup                                          |
   | 4   | Connect  | **Dynamic URL** `https://API/telephony/connect?key=TOKEN`, record on | If nobody answers → Passthru `https://API/telephony/missed?key=TOKEN` → Hangup |
   | 5   | Connect  | The clinic's own phone number (fixed, not dynamic), record on        | If nobody answers → Passthru `https://API/telephony/missed?key=TOKEN` → Hangup |

   In the flow's settings, set the **status callback** to `https://API/telephony/status?key=TOKEN`. Step 5 is the safety net: if our servers are down, Exotel still rings the clinic's own phone.

3. Assign the ExoPhone to this flow.
4. The clinic owner opens **More → Clinic settings → Phone assistant** and enters:
   - the **assistant's phone number** (the ExoPhone),
   - **staff numbers** to ring when a caller wants a person (in order; the clinic's own number is always tried last),
   - **when** to answer: every call, or only outside clinic hours.
     Doctors ring first for emergencies, in the order set by "Emergency order" under Doctors.
5. **Point the clinic's phone at the assistant.** On the clinic's mobile, set call forwarding to the ExoPhone. The usual codes (most Indian operators) are:
   - forward when **not answered**: `**61*<ExoPhone>#`
   - forward when **busy**: `**67*<ExoPhone>#`
   - forward when **unreachable**: `**62*<ExoPhone>#`
   - forward **every** call: `**21*<ExoPhone>#`
     "Not answered + busy + unreachable" gives "the assistant picks up after a few rings". Landlines: ask the operator. (Operator-by-operator guides come in Phase 6.)

### Check it works

1. From your own phone, call the clinic. Let it ring through to the assistant. You should hear the greeting with the recording notice.
2. Book an appointment by voice. Check it appears on the dashboard, the WhatsApp confirmation arrives, and the call shows under **More → Phone calls** with its transcript.
3. **Acceptance (PLAN Phase 3):** 50 test calls by people outside the team. After each one, open it under **Phone calls** and mark **Pass** or **Fail** with a note. The screen shows progress towards 50.

## Part D5: Follow-ups, estimates and confirmation calls (Phase 4)

Phase 4 works with what is already set up. Follow-ups go out on WhatsApp (Part D3), and confirmation calls use the phone setup (Part D4). Two things remain.

### Where estimate PDFs are stored (one time, for Sentio)

Estimates are sent as a PDF link on WhatsApp. The PDFs are kept in Supabase Storage (Mumbai), in a **private** bucket. Each link works for a limited time only.

1. In Supabase, open **Storage → New bucket**. Name it `clinic-files` and leave **Public bucket** off.
2. In **Project Settings → API**, copy the **service_role** key. Keep it secret: it can read everything.
3. Add these to the **api** and **worker** services in Railway, then redeploy:

   ```
   STORAGE_PROVIDER=supabase
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=(from step 2)
   STORAGE_BUCKET=clinic-files
   ```

   Until this is done (`STORAGE_PROVIDER=fake`), estimates can be made and seen on the dashboard, but the WhatsApp link does not work.

### Confirmation calls (one time per clinic)

The day before a visit, a booked appointment that is still not confirmed gets an AI call between 9 am and 8 pm. If the call can't be made, staff get a "please call" task two hours later.

1. In Exotel, build a second flow, called for example "Sentio outbound". It needs just one step: a **Voicebot** applet with URL `wss://VOICE/media?key=TOKEN` (the same one as in Part D4, step 2), then **Hangup**. Set its status callback to `https://API/telephony/status?key=TOKEN`.
2. Note the flow's **App ID** (the number in its URL in App Bazaar).
3. In the dashboard, open **More → Clinic settings → Phone assistant**. Tick **Call patients to confirm tomorrow's appointments** and enter the App ID in **Exotel flow ID for calls we place**. Save.

The call uses the clinic's ExoPhone as caller ID. It is never made to a patient who said "don't call", or less than an hour before the visit.

### What the clinic sets (dashboard)

- **More → Clinic settings → Treatments and prices:** for each treatment:
  - the **recall** period, e.g. 6 months for scaling (blank means no recall);
  - whether to send a **next-day check-in**;
  - the **after-care text** in English and Hindi. It is sent only after the doctor ticks "approved".
- **More → Clinic settings → Automatic follow-ups** (owner only): the steps of each follow-up ladder. Each step says how many hours to wait, an optional time of day, and what to do: WhatsApp, staff task, or (for unconfirmed appointments only) an AI call. A ladder can be switched off.
- **Treatment plans** start from ready-made templates (root canal, crown, implant, braces, and 8 more) with sittings and the gaps between them. They are picked when adding a plan on a patient page. Prices come from Treatments and prices.
- **Campaigns** (More → Campaigns) go out only after the **owner** approves them. They go only to patients who said yes to offers (recorded on the patient page).

### Check it works

1. On a patient page, add a **root canal** plan, book its first sitting from the plan, and mark that appointment **Completed**. Within 5 minutes a WhatsApp about the next sitting arrives (with a button to book it), and **More → Follow-ups** shows the run.
2. Make an **estimate** from the plan and send it. The patient gets the PDF link with "OK" and "Call me" buttons.
3. Mark an appointment **No-show**. The patient gets the "we missed you" message within 5 minutes.
4. **More → Incomplete treatments** shows incomplete treatments with the rupee value still to come.

## Part D6: Money (Phase 5)

There are two kinds of money, kept apart on purpose:

- **Patients paying the clinic.** Patients pay into the **clinic's own** Razorpay account. The money never passes through Sentio.
- **Clinics paying Sentio.** Clinics pay for the one-time license and for usage (calls, WhatsApp, AI) from a prepaid **usage wallet**. These payments go into **Sentio's** Razorpay account.

### One time, for Sentio

1. **Sentio's Razorpay account.** Sign up at [razorpay.com](https://razorpay.com) and finish the KYC. Then ask Razorpay support to switch on **Payment Links** and **Recurring Payments** (UPI Autopay, cards and e-NACH), which the automatic recharge uses.
2. In Razorpay, open **Account & Settings → API Keys** and generate a key. Save the **Key ID** and **Key Secret**.
3. Open **Webhooks → Add new webhook**:
   - URL: `https://API/webhooks/payments/sentio`
   - A long random **secret**, for example from `openssl rand -hex 24`.
   - Events: `payment_link.paid`, `payment.captured`, `payment.failed`, `token.confirmed`, `token.rejected`, `token.paused`, `token.cancelled`.
4. Add these to the **api** and **worker** services in Railway, then redeploy:

   ```
   PAYMENT_PROVIDER=razorpay
   RAZORPAY_KEY_ID=(from step 2)
   RAZORPAY_KEY_SECRET=(from step 2)
   RAZORPAY_WEBHOOK_SECRET=(from step 3)
   SENTIO_LEGAL_NAME=Sentio Care Private Limited
   SENTIO_GSTIN=(your GSTIN)
   SENTIO_STATE=Jharkhand
   SENTIO_ADDRESS=(registered address, one line)
   ```

   The `SENTIO_*` values are printed on Sentio's GST invoices to clinics. Make sure `CHANNEL_SECRET_KEY` is set too (Part D3): it encrypts each clinic's Razorpay keys.

5. **Make yourself a Sentio admin.** Sign in to the dashboard once with your email. Then, in the Railway **api** service shell, run:

   ```
   node admin.js make-admin --email you@sentio.care
   ```

   Reload the dashboard: **More → Sentio admin** appears. Only Sentio staff should be admins, because the admin panel shows every clinic's billing.

6. **Check the rate card.** Open **Sentio admin → Rates**. It lists the default price per unit (what each provider charges Sentio) and Sentio's margin. Change a rate by adding a new one from a date; past usage keeps the price it had.

### For each clinic

1. **Sell the license.** Open **Sentio admin → Clinics → the clinic → Sell license**. Enter the edition, the price before GST and the months of updates, then press **Send payment link to owner**. The owner gets it on WhatsApp. Once they pay:
   - the license shows **paid (perpetual)**,
   - a GST invoice is issued, and
   - billing starts for the clinic.
2. **Opening balance.** The owner adds money under **More → Sentio balance & billing → Add money**. For a pilot, you can instead credit the wallet under Sentio admin (with a reason), or leave billing off.
3. **Automatic recharge.** On the same page the owner presses **Set up** and approves the mandate in their UPI app, card or bank. You can also send them the link from the admin panel. From then on:
   - the balance is topped up by the recharge amount when the forecast says it will run low;
   - every debit is announced on WhatsApp at least 24 hours before it happens, and is never more than ₹15,000.
4. **Patients paying the clinic online.** The owner opens **Settings → Online payments (Razorpay)** and enters the clinic's **own** Razorpay Key ID, Key Secret and a webhook secret. In the clinic's Razorpay account, they add the webhook address shown there (`https://API/webhooks/payments/clinic/<clinic id>`) with the events `payment_link.paid` and `payment.captured`. Until this is done:
   - payments at the desk (cash, UPI, card) work as normal;
   - payment links and online advances are not offered.

### Check it works

1. On a patient page, under **Bill and payments**:
   - **Add charge** for a treatment, then **Take payment** by UPI. A receipt number like `R/2026-27/0001` appears, and the patient gets the receipt on WhatsApp.
   - **Payment link**: pay it from your phone with a small amount. Within a minute the bill shows it paid, with a receipt.
2. **More → Payments & dues** shows the day's collections by method and who owes money. **Download Excel** gives the ledger.
3. **More → Sentio balance & billing** shows the balance, this month's usage and the recharges. **Sentio admin → Health** shows every provider's status.

---

## Part D7: Leads, owner report and onboarding (Phase 6)

### One time, for Sentio (about 30 minutes)

1. **Lead ads use the same Meta app as WhatsApp.** In [developers.facebook.com](https://developers.facebook.com) open the Sentio app, add the **Webhooks** product, choose **Page**, and subscribe to the **leadgen** field. Callback URL: `https://API/webhooks/meta-leads`. Verify token: the same value as `WHATSAPP_VERIFY_TOKEN`.
2. In the app's **App Review**, request the permissions `leads_retrieval`, `pages_manage_metadata`, `pages_show_list` and `pages_read_engagement`. Meta reviews these (usually a few days). Until approved, only people with a role on the app can test.
3. In Railway, on the **api** and **worker** services, set `LEADS_PROVIDER` to `meta`. It uses the existing `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`; the api refuses to start if either is missing.
4. On the **worker** service, set `DASHBOARD_URL` to the dashboard's address (for example `https://app.sentio.care`). The owner's 9 pm WhatsApp report links to it.

### For each clinic (about 15 minutes)

1. **Connect the Facebook Page.** The clinic's Page admin creates a long-lived **Page access token** that has `leads_retrieval` (Meta Business Suite → Settings → System users, or the Graph API Explorer). In the dashboard: **Settings → Lead ads (Facebook & Instagram)**, enter the Page ID and the token, and save. Then subscribe the Page to the app once:

   ```
   curl -X POST "https://graph.facebook.com/v23.0/<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen&access_token=<PAGE_TOKEN>"
   ```

2. **Alert phone.** In the same section, enter the staff mobile that should get a WhatsApp alert for every hot lead (the person who calls leads back).
3. **Click-to-WhatsApp ads** need nothing extra: people who tap the ad land in the clinic's WhatsApp chat, and the assistant records them as leads with the ad's name. In Ads Manager, keep the ad's destination as the clinic's WhatsApp number.
4. **Tell Meta which leads became patients (strongly recommended).** Without this, Meta's ads learn only from form fills and keep finding people who fill forms but never come. With it, they learn from the leads who booked, came in and paid.
   - In [Meta Events Manager](https://business.facebook.com/events_manager2), open the clinic's **dataset** (create one if there is none: **Connect data sources → CRM**). Copy its **Dataset ID** (a long number).
   - In the dataset's **Settings**, under **Conversions API**, click **Generate access token** and copy it.
   - In the dashboard: **Settings → Lead ads (Facebook & Instagram) → Tell Meta which leads became patients**, paste both and press **Connect dataset**. Within 15 minutes the line under it shows how many updates were sent.
   - Sentio sends, for each lead from a Meta form or a Click-to-WhatsApp ad: **qualified**, **booked**, **visited** and **won** (with the amount paid). Only the stage, its time and a scrambled (hashed) phone number go to Meta.
   - Once the clinic gets about **200 form leads a month**, ask the ad agency to switch the form campaign's performance goal to **Maximise number of conversion leads** and pick **booked** as the stage to optimise for (Meta wants a stage that 1 to 40 out of 100 leads reach within 28 days). For Click-to-WhatsApp ads, Meta receives the standard events **Lead**, **Schedule** and **Purchase**.
5. **AI calls to leads** are on once the phone assistant can make calls (Part D5, confirmation calls: the outbound flow ID). The assistant calls each new lead within minutes and books on the call. To switch it off: **Settings → Phone assistant → Call new leads from ads**.
6. **How to run the ads (share this with the clinic's agency):**
   - Prefer **Click-to-WhatsApp** ads: the person is already in the chat, so the assistant answers in seconds. Indian healthcare advertisers report these convert 2 to 3 times better than forms.
   - For lead forms, choose the **Higher intent** form type (it adds a review step, so fewer accidental submits) and keep the form short: name, phone, and the two questions below.
   - Make the ad offer concrete ("Implant consultation this week, know your cost before you decide"), not "chat with us".
7. **The lead form.** Ask the clinic's ad agency to add two short questions to the Meta lead form: "What do you need help with?" and "When would you like to come?". The assistant reads the answers (English or Hindi) and asks only what is missing.

### Onboarding a new clinic (the owner does this, with Sentio on the phone)

Before doctors write prescriptions, add each doctor's **qualification** and **Dental Council registration number** under Settings → Doctors. They are printed on every prescription.

The owner signs in and taps the **Setup** banner on Today (or **More → Setup checklist**). It lists every step with a link to where it is done, and shows a tick when the clinic's data shows the step is finished:

1. **Turn test mode on first.** Messages and calls then go only to staff numbers (and any test numbers entered there). Messages to patients are recorded as "blocked: test mode", never sent.
2. Clinic details, doctors, working hours, treatments and prices, staff.
3. WhatsApp (Part D3) and the phone number (Part D4).
4. **Call forwarding.** The checklist shows the codes for Jio, Airtel, Vi and BSNL mobiles, ready to tap, and what to ask for on a landline. Forward only busy, unanswered and unreachable calls, so staff still pick up first.
5. **Test call.** From another phone, call the clinic and don't pick up. The assistant answers; book a test visit. Open **Calls**, find the call and mark it **passed**.
6. Online payments and lead ads (optional), then the license (Part D6).
7. **Turn test mode off.** The Today banner reminds the owner while it is on.

### Check it works

1. Submit a test lead with Meta's [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing). Within a minute it appears under **More → Leads**, and the test phone gets the first WhatsApp.
2. Open **More → Reports**: the day's numbers and "rupees recovered", with every counted payment listed.
3. At 9 pm clinic time, the owner gets the day's summary on WhatsApp (they can switch it off on the Reports page).

---

## Part E: Updating the app

You don't need to do anything. When a change is merged into the `main` branch on GitHub, Railway deploys it automatically:

- database updates run first, and
- if any step fails, the old version keeps running.

To roll back to an earlier version: open the service, click **Deployments**, find the last good one, click **⋮** and then **Redeploy**.

---

## Part F: For developers (local machine)

```bash
# Requirements: Node 22 (see .nvmrc), pnpm 10, and either Docker or PostgreSQL 16+ installed.
corepack enable
pnpm install
cp .env.example .env
pnpm dev:db                       # starts Postgres on port 54329
export $(grep -v '^#' .env | xargs)
pnpm db:migrate                   # apply database migrations
pnpm check                        # format, lint, typecheck, all tests
pnpm --filter @dentalos/api dev    # API on http://localhost:8080
pnpm --filter @dentalos/worker dev # background worker
pnpm --filter @dentalos/web dev    # dashboard on http://localhost:3000
pnpm --filter @dentalos/api seed:demo  # demo clinic: sign in as owner@demo.sentio or reception@demo.sentio, any code
pnpm --filter @dentalos/api seed:demo -- --reset --at=12:10  # today as it looks at 12:10 (demos outside clinic hours)
pnpm e2e                          # browser tests at phone size (resets the demo clinic in DATABASE_URL)
```

For local sign-in without sending emails, set `AUTH_JWT_SECRET` (any 32+ characters) and `DEV_LOGIN=on` for the API, and `DEV_LOGIN=on` and `API_URL=http://localhost:8080` for the dashboard. Dev login is refused on staging and production.

**Rules that CI enforces:**

- Database tests run against a real Postgres. In CI they can never be skipped (`REQUIRE_DB_TESTS=1`).
- A migration that deletes or renames data is refused unless its first lines include:

  ```
  -- destructive-approved-by: <name>, <date>, <reason>
  ```

  Add that line only after the founder has approved the change.

- `console.log` is not allowed in application code. Use the logger from `@dentalos/shared/logger`, which removes patient details automatically.
