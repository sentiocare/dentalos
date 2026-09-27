# Runbook: what to do when something fails

For each failure, this document lists:

- how we find out,
- what the product does automatically, and
- what a person should do.

The automatic behaviours are built in the phase shown. Until then, the "what a person should do" column is the whole plan.

## Where to look first

| Check                    | How                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is everything up?        | Open `https://API-DOMAIN/health/ready`. `ok:true` means the API can serve. The `components` section shows the database, worker and each provider. |
| Background jobs running? | `components.worker.ok` in the same response. A heartbeat is written every minute. Stale after 3 minutes.                                          |
| Logs                     | Railway → service → Deployments → View logs. Logs never contain patient names or numbers.                                                         |
| Crashes                  | Sentry (if set up)                                                                                                                                |

## Failure table (Build Prompt §11)

| Failure                           | How we detect it                                     | Automatic behaviour                                                                                                                                                                                 | What a person does                                                                                                | Built in                           |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Voice provider down**           | Voice health check fails, or session start errors    | Calls go straight to the clinic's own phone. Missed calls get a WhatsApp follow-up. Sentio team alerted.                                                                                            | Check the provider's status page. Tell affected clinics calls are going direct. No clinic action needed.          | Phase 3                            |
| **Telephony provider down**       | Telephony health check; no call events               | Alert the owner and the Sentio team. The clinic's own phone line keeps working through its operator.                                                                                                | Ask clinics to temporarily remove call forwarding (operator guide in ONBOARDING). Restore it when fixed.          | Phase 3                            |
| **WhatsApp API down**             | Send errors / messaging health check                 | Messages stay queued in the outbox and retry with backoff. Critical alerts fall back to SMS if set up.                                                                                              | Watch the outbox queue on the admin panel. Nothing is lost; messages send when the API recovers.                  | Phase 2 ✅ (SMS fallback: Phase 4) |
| **LLM slow or down**              | Latency and error rate on LLM calls                  | Voice: scripted fallback flow and human transfer. WhatsApp: queue and retry, with a holding reply.                                                                                                  | Check the provider status. If it's long-lasting, switch `LLM_PROVIDER` / model in Railway variables and redeploy. | Phases 2–3                         |
| **Database slow**                 | Tool latency p95 > 1.5 s; readiness check            | The bot says it will confirm on WhatsApp shortly and creates a pending task. **It never confirms a booking the database hasn't saved.**                                                             | Check Supabase → Reports for slow queries and CPU. Upgrade the compute size if saturated.                         | Phase 3                            |
| **Database down**                 | `/health/ready` returns 503 with `database.ok:false` | Railway keeps the old containers. Webhooks are retried by providers.                                                                                                                                | Check the Supabase status page and project → Logs. If the project is paused (free tier), resume it.               | Phase 0 ✅ (detection)             |
| **Worker stopped**                | `components.worker.ok:false`                         | Railway restarts it automatically (`restartPolicyType: ALWAYS`). Jobs are stored in Postgres, so none are lost; they run when the worker is back.                                                   | If still red after 5 minutes, open the worker logs and redeploy the last good deployment.                         | Phase 0 ✅                         |
| **Wallet empty / mandate failed** | Wallet state machine                                 | Build Prompt §4.3: AI calls forward to the clinic phone, emergencies always work, campaigns pause, transactional WhatsApp continues within the grace amount, and the owner gets a one-tap pay link. | Call the owner if it isn't resolved within 24 hours. Check failed payments on the admin panel.                    | Phase 5                            |
| **Internet down at clinic**       | Dashboard offline indicator                          | The dashboard works from the phone's cache and queues changes. All automation continues on the server.                                                                                              | None. Changes sync when the connection returns.                                                                   | Phase 1                            |
| **Duplicate webhook / retry**     | `webhook_events` unique event ID                     | Duplicate is ignored. No double booking, payment or message.                                                                                                                                        | None.                                                                                                             | Phase 2 ✅                         |
| **Migration failed on deploy**    | Railway pre-deploy step fails                        | That migration's transaction rolls back and the old version keeps running.                                                                                                                          | Send the deploy logs to engineering. Never edit an applied migration; fix it with a new one.                      | Phase 0 ✅                         |

## WhatsApp: common problems

| What you see                                                           | Likely cause                                                                           | What to do                                                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Patients write but nothing appears in the dashboard                    | Webhook not subscribed, or `WHATSAPP_APP_SECRET` wrong (API logs show `bad signature`) | Meta app → WhatsApp → Configuration: check the callback URL and the `messages` subscription. Re-copy the app secret into Railway.         |
| Chats appear but the assistant never replies                           | Worker stopped, clinic not connected, or the chat was taken over                       | Check `/health/ready`. In the chat, look for "Staff handling" and tap **Hand back to assistant**. Settings → WhatsApp must say Connected. |
| Messages show **Not sent (outside_window_no_template)**                | The patient's 24-hour window closed and the template is not approved                   | Approve the template in Meta, then mark it Approved in Settings → WhatsApp.                                                               |
| Messages show **Failed**, and the outbox error is `whatsapp_cloud:190` | The clinic's access token expired or was revoked                                       | Generate a new permanent system-user token and reconnect in Settings → WhatsApp.                                                          |
| Messages show **Not sent (opted_out)**                                 | The patient sent STOP                                                                  | Nothing. They start receiving reminders again only if they write START.                                                                   |
| Reminders arrive late in the morning                                   | Quiet hours: due before 07:00, so they wait                                            | Expected (ASSUMPTIONS A-25).                                                                                                              |

## Adding production failures to the eval suite

Every real conversation that went wrong becomes a new test case in `evals/cases/` (Phase 3 onwards):

1. copy the redacted transcript,
2. write down what should have happened,
3. add the assertion, and
4. confirm the new case fails before the fix and passes after it.
