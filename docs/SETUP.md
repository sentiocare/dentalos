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

   No patient data is stored on Railway, only in Supabase Mumbai. This choice is listed for the lawyer's review in `docs/COMPLIANCE.md` (decision D1).

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
      SENTRY_DSN=
   ```

   If you set up Sentry, paste its DSN after `SENTRY_DSN=`.

4. Go to **Settings**, then **Networking**, then **Generate Domain**. Railway gives you an address like `api-staging-xxxx.up.railway.app`. Save it.

### C3. Add the `worker` service

1. In the project, click **+ Create**, then **GitHub Repo**, then select `sentiocare/dentalos` again.
2. Rename the new service to `worker`.
3. Set its config file path to:

   ```
   deploy/railway/worker.json
   ```

4. Paste the same variables as the api (the Raw editor box in C2 step 3).
5. Do **not** generate a domain. The worker does not receive visitors.

### C4. Add the `web` service

1. Click **+ Create**, then **GitHub Repo**, then select `sentiocare/dentalos` again.
2. Rename the new service to `web`.
3. Set its config file path to:

   ```
   deploy/railway/web.json
   ```

4. Paste these variables:

   ```
   NEXT_TELEMETRY_DISABLED=1
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
3. Open your web domain (from C4 step 5). You should see the Sentio Dental OS screen with an **English / हिन्दी** switch.
4. On an Android phone, open the web domain in Chrome. Tap **⋮**, then **Add to Home screen**. The app icon appears like a normal app.

**If something is red:**

| What you see                                         | What to do                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"database":{"ok":false}`                            | The DATABASE_URL is wrong. Redo Part B steps 6–8, paste the value again into Railway's Variables, then click **Deploy**.                                  |
| `"worker":{"ok":false, ...}` for more than 3 minutes | Open the `worker` service, then **Deployments**, then the latest one, then **View logs**. Send a screenshot of the last 20 lines to the engineering team. |
| The api deploy failed at "pre-deploy"                | A database update (migration) failed. Nothing was changed, because each update is all-or-nothing. Send the deploy logs to the engineering team.           |
| Page does not load at all                            | Check that the service has a generated domain (C2 step 4 / C4 step 5) and that the latest deployment says **Active**.                                     |

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
```

**Rules that CI enforces:**

- Database tests run against a real Postgres. In CI they can never be skipped (`REQUIRE_DB_TESTS=1`).
- A migration that deletes or renames data is refused unless its first lines include:

  ```
  -- destructive-approved-by: <name>, <date>, <reason>
  ```

  Add that line only after the founder has approved the change.

- `console.log` is not allowed in application code. Use the logger from `@dentalos/shared/logger`, which removes patient details automatically.
