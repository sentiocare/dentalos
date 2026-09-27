import { OVERRIDABLE } from "@dentalos/core";
import { normalizePhone } from "@dentalos/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, idParams, parse } from "../http.js";
import type { StaffContextService } from "../staff-context.js";

const role = z.enum(["owner", "doctor", "receptionist", "assistant"]);
const permissionOverrides = z.partialRecord(z.enum(OVERRIDABLE as [string, ...string[]]), z.boolean());

export function staffRoutes(app: FastifyInstance, deps: { staff: StaffContextService }) {
  app.get("/v1/staff", (request) =>
    deps.staff.inClinic(request, "staff.manage", async (c) => {
      const { rows } = await c.query(
        `select m.id, m.display_name, m.role, m.permissions, m.active, m.invited_phone, m.user_id is not null as joined,
                u.phone, u.name as user_name
         from clinic_memberships m left join users u on u.id = m.user_id
         order by m.active desc, m.role, m.display_name`,
      );
      return rows;
    }),
  );

  // Adds a staff member by phone number. They sign in with an OTP on that number and are connected.
  app.post("/v1/staff", (request) =>
    deps.staff.inClinic(request, "staff.manage", async (c) => {
      const b = parse(
        z.object({
          phone: z.string(),
          name: z.string().trim().min(1).max(100),
          role,
          permissions: permissionOverrides.default({}),
        }),
        request.body,
      );
      const phone = normalizePhone(b.phone);
      if (!phone) throw new HttpError(400, "invalid_input", "Invalid phone number");
      const existingUser = await c.query("select id from users where phone = $1", [phone]);
      const { rows } = await c.query(
        `insert into clinic_memberships (clinic_id, user_id, invited_phone, display_name, role, permissions)
         values (app.current_clinic_id(), $1, $2, $3, $4, $5) returning id`,
        [existingUser.rows[0]?.id ?? null, phone, b.name, b.role, b.permissions],
      );
      deps.staff.invalidate();
      return { id: rows[0].id };
    }),
  );

  app.patch("/v1/staff/:id", (request) =>
    deps.staff.inClinic(request, "staff.manage", async (c, me) => {
      const { id } = parse(idParams, request.params);
      const b = parse(
        z.object({
          role: role.optional(),
          permissions: permissionOverrides.optional(),
          active: z.boolean().optional(),
          name: z.string().trim().min(1).max(100).optional(),
        }),
        request.body,
      );
      const target = (
        await c.query("select user_id, role, active from clinic_memberships where id = $1 for update", [id])
      ).rows[0];
      if (!target) throw new HttpError(404, "not_found", "Staff member not found");
      const losesOwner =
        target.role === "owner" && target.active && ((b.role && b.role !== "owner") || b.active === false);
      if (losesOwner) {
        const owners = await c.query(
          "select count(*)::int as n from clinic_memberships where role = 'owner' and active",
        );
        if (owners.rows[0].n <= 1)
          throw new HttpError(409, "last_owner", "The clinic must always have an owner");
        if (target.user_id === me.user.userId)
          throw new HttpError(409, "self_demotion", "Ask another owner to change your role");
      }
      await c.query(
        `update clinic_memberships set role = coalesce($2, role), permissions = coalesce($3, permissions),
           active = coalesce($4, active), display_name = coalesce($5, display_name) where id = $1`,
        [id, b.role ?? null, b.permissions ?? null, b.active ?? null, b.name ?? null],
      );
      deps.staff.invalidate();
      return { ok: true };
    }),
  );
}
