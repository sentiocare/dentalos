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

### B2. Turn on sign-in with phone OTP

Staff sign in with their mobile number and an SMS code.

1. In Supabase, open **Authentication**, then **Sign In / Providers** (or **Providers**), then **Phone**, and switch it **on**.
2. **SMS provider:** choose **Twilio Verify**. It handles India's DLT rules for OTP messages. Create a Twilio account at https://www.twilio.com, create a **Verify service**, and paste the three values Supabase asks for (Account SID, Auth Token, Verify Service SID).
3. **Staging only: skip real SMS while testing.** On the same Phone page, find **Test phone numbers / Test OTPs** and add:

   ```
   919000000001=123456
   919000000002=123456
   ```

   These two numbers can then sign in with code `123456` without any SMS being sent. Never add test numbers in production.

---

## Part C: Deploy the three services (Railway)

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

4. **To create a real clinic**, run this with the clinic's details. The owner's phone is the number they will sign in with.

   ```
   node admin.js create-clinic --name "Sharma Dental Clinic" --city "Ranchi" --owner-name "Dr. Rakesh Sharma" --owner-phone 9835012345
   ```

   The clinic starts with opening hours Monday–Saturday, 10:00–14:00 and 17:00–21:00, one chair, and a starter list of 21 treatments with Hindi names. Prices start empty; the owner fills them in under **More → Clinic settings → Treatments and prices**.

   **For a sales demo instead**, run:

   ```
   node admin.js seed-demo
   ```

   This creates "Sharma Dental Clinic (Demo)" with about 80 patients and this week's appointments. The owner logs in with `90000 00001` and the receptionist with `90000 00002`. Use code `123456` if you added the test numbers in Part B2 step 3.

5. Type `exit` to leave. The owner can now open the dashboard, sign in with their number, and add staff under **More → Clinic settings → Staff**.

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
pnpm --filter @dentalos/api seed:demo  # demo clinic: sign in as 90000 00001 (owner) or 90000 00002 (reception), any code
pnpm e2e                          # browser tests at phone size (resets the demo clinic in DATABASE_URL)
```

For local sign-in without SMS, set `AUTH_JWT_SECRET` (any 32+ characters) and `DEV_LOGIN=on` for the API, and `DEV_LOGIN=on` and `API_URL=http://localhost:8080` for the dashboard. Dev login is refused on staging and production.

**Rules that CI enforces:**

- Database tests run against a real Postgres. In CI they can never be skipped (`REQUIRE_DB_TESTS=1`).
- A migration that deletes or renames data is refused unless its first lines include:

  ```
  -- destructive-approved-by: <name>, <date>, <reason>
  ```

  Add that line only after the founder has approved the change.

- `console.log` is not allowed in application code. Use the logger from `@dentalos/shared/logger`, which removes patient details automatically.
