import {
  connectWhatsApp,
  enqueueMessage,
  scheduleSend,
  registerStandardTemplates,
  whatsAppStatus,
  WINDOW_MS,
  type JobQueue,
} from "@dentalos/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http";
import type { StaffContextService } from "../staff-context";

export function inboxRoutes(
  app: FastifyInstance,
  deps: { staff: StaffContextService; jobs: JobQueue; channelKey: Buffer | null },
) {
  app.get("/v1/inbox", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const q = parse(
        z.object({
          filter: z.enum(["all", "unread", "human", "tasks"]).default("all"),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        request.query,
      );
      const { rows } = await c.query(
        `select c.id, c.phone, c.mode, c.last_message_at, c.last_preview, c.unread_count, c.last_inbound_at,
                p.id as patient_id, p.name as patient_name,
                (select count(*)::int from tasks t where t.conversation_id = c.id and t.status = 'open') as open_tasks,
                (select max(priority) filter (where priority = 'critical') from tasks t where t.conversation_id = c.id and t.status = 'open') as critical
         from conversations c left join patients p on p.id = c.patient_id
         where c.last_message_at is not null
           and ($1 = 'all' or ($1 = 'unread' and c.unread_count > 0) or ($1 = 'human' and c.mode = 'human')
                or ($1 = 'tasks' and exists (select 1 from tasks t where t.conversation_id = c.id and t.status = 'open')))
         order by (select count(*) from tasks t where t.conversation_id = c.id and t.status = 'open' and t.priority = 'critical') desc,
                  c.last_message_at desc
         limit $2`,
        [q.filter, q.limit],
      );
      return rows;
    }),
  );

  app.get("/v1/inbox/:id", (request) =>
    deps.staff.inClinic(request, "patients.read", async (c) => {
      const { id } = parse(idParams, request.params);
      const conversation = (
        await c.query(
          `select c.*, p.name as patient_name, u.name as taken_over_by_name
           from conversations c left join patients p on p.id = c.patient_id left join users u on u.id = c.taken_over_by where c.id = $1`,
          [id],
        )
      ).rows[0];
      if (!conversation) throw new HttpError(404, "not_found", "Conversation not found");
      const messages = (
        await c.query(
          `select id, direction, author, kind, body, payload, template_name, status, error, safety_flag, created_at
           from messages where conversation_id = $1 order by created_at desc limit 150`,
          [id],
        )
      ).rows.reverse();
      // Staff replies still waiting for the worker, so the sender sees them straight away.
      const queued = (
        await c.query(
          `select id, 'out' as direction, 'staff' as author, 'text' as kind, payload->>'text' as body, '{}'::jsonb as payload,
                  null as template_name, 'queued' as status, null as error, null as safety_flag, created_at
           from outbox where to_phone = $1 and purpose = 'staff_reply' and status in ('pending', 'sending') order by created_at`,
          [conversation.phone],
        )
      ).rows;
      messages.push(...queued);
      const tasks = (
        await c.query(
          "select id, kind, priority, title, detail, created_at from tasks where conversation_id = $1 and status = 'open' order by created_at",
          [id],
        )
      ).rows;
      await c.query("update conversations set unread_count = 0 where id = $1", [id]);
      const windowOpen =
        !!conversation.last_inbound_at &&
        Date.now() - new Date(conversation.last_inbound_at).getTime() < WINDOW_MS;
      const { state: _state, ...rest } = conversation;
      return { conversation: { ...rest, windowOpen }, messages, tasks };
    }),
  );

  // Staff take over: the assistant stops replying in this thread until released (Build Prompt §5.2).
  app.post("/v1/inbox/:id/takeover", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c, staff) => {
      const { rowCount } = await c.query(
        "update conversations set mode = 'human', taken_over_by = $2, taken_over_at = now() where id = $1",
        [parse(idParams, request.params).id, staff.user.userId],
      );
      if (!rowCount) throw new HttpError(404, "not_found", "Conversation not found");
      return { ok: true };
    }),
  );

  app.post("/v1/inbox/:id/release", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c) => {
      const { id } = parse(idParams, request.params);
      await c.query("delete from slot_holds where holder = $1", [`wa:${id}`]);
      await c.query(
        "update conversations set mode = 'bot', taken_over_by = null, taken_over_at = null, state = jsonb_build_object('lang', state->'lang') where id = $1",
        [id],
      );
      return { ok: true };
    }),
  );

  // A staff reply. WhatsApp only allows free text within 24 hours of the patient's last message.
  app.post("/v1/inbox/:id/reply", (request) =>
    deps.staff
      .inClinic(request, "appointments.write", async (c, staff) => {
        const { id } = parse(idParams, request.params);
        const { text } = parse(z.object({ text: z.string().trim().min(1).max(4000) }), request.body);
        const conv = (
          await c.query("select id, phone, last_inbound_at, patient_id from conversations where id = $1", [
            id,
          ])
        ).rows[0];
        if (!conv) throw new HttpError(404, "not_found", "Conversation not found");
        if (!conv.last_inbound_at || Date.now() - new Date(conv.last_inbound_at).getTime() >= WINDOW_MS) {
          throw new HttpError(
            409,
            "window_closed",
            "The patient has not written in the last 24 hours, so WhatsApp only allows approved templates. Please call instead.",
          );
        }
        // Replying means a person is handling the thread; keep the assistant from answering in parallel.
        await c.query(
          "update conversations set mode = 'human', taken_over_by = coalesce(taken_over_by, $2), taken_over_at = coalesce(taken_over_at, now()) where id = $1",
          [id, staff.user.userId],
        );
        const outboxId = await enqueueMessage(c, {
          to: conv.phone,
          category: "service",
          purpose: "staff_reply",
          payload: { kind: "text", text },
          dedupeKey: `staff:${id}:${request.id}`,
          patientId: conv.patient_id,
        });
        return { staff, outboxId };
      })
      .then(async ({ staff, outboxId }) => {
        if (outboxId) await scheduleSend(deps.jobs, staff.clinicId, outboxId);
        return { ok: true, outboxId };
      }),
  );

  app.get("/v1/tasks", (request) =>
    deps.staff.inClinic(request, "appointments.read", async (c) => {
      const q = parse(z.object({ status: z.enum(["open", "done"]).default("open") }), request.query);
      const { rows } = await c.query(
        `select t.id, t.kind, t.priority, t.title, t.detail, t.status, t.created_at, t.due_at, t.conversation_id, t.patient_id, t.appointment_id,
                p.name as patient_name, p.phone as patient_phone
         from tasks t left join patients p on p.id = t.patient_id
         where t.status = $1
         order by case t.priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at desc
         limit 200`,
        [q.status],
      );
      return rows;
    }),
  );

  app.post("/v1/tasks/:id/done", (request) =>
    deps.staff.inClinic(request, "appointments.write", async (c, staff) => {
      const { rowCount } = await c.query(
        "update tasks set status = 'done', resolved_by = $2, resolved_at = now() where id = $1 and status = 'open'",
        [parse(idParams, request.params).id, staff.user.userId],
      );
      return { ok: rowCount === 1 };
    }),
  );

  // WhatsApp connection and templates (owner).
  app.get("/v1/whatsapp", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      const status = await whatsAppStatus(c);
      if (status.connected) await registerStandardTemplates(c);
      const templates = (
        await c.query(
          "select id, purpose, name, language, category, body, meta_status from message_templates order by purpose, language",
        )
      ).rows;
      return { ...status, templates };
    }),
  );

  app.put("/v1/whatsapp", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c) => {
      if (!deps.channelKey)
        throw new HttpError(
          503,
          "not_configured",
          "Server secret CHANNEL_SECRET_KEY is not set (docs/SETUP.md)",
        );
      const b = parse(
        z.object({
          phoneNumberId: z.string().trim(),
          displayPhone: z.string().trim(),
          accessToken: z.string().trim().min(20),
        }),
        request.body,
      );
      await connectWhatsApp(c, deps.channelKey, b);
      // Register the standard templates for this clinic (to be submitted to Meta for approval).
      await registerStandardTemplates(c);
      return whatsAppStatus(c);
    }),
  );

  app.patch("/v1/whatsapp/templates/:id", (request) =>
    deps.staff.inClinic(request, "settings.manage", async (c, staff) => {
      const b = parse(
        z.object({ metaStatus: z.enum(["draft", "submitted", "approved", "rejected", "paused"]) }),
        request.body,
      );
      const { rows } = await c.query(
        `update message_templates set meta_status = $2, owner_approved_by = coalesce(owner_approved_by, $3), owner_approved_at = coalesce(owner_approved_at, now())
         where id = $1 returning id, meta_status`,
        [parse(idParams, request.params).id, b.metaStatus, staff.user.userId],
      );
      if (!rows[0]) throw new HttpError(404, "not_found", "Template not found");
      return rows[0];
    }),
  );
}
