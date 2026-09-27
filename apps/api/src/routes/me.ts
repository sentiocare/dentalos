import { normalizePhone } from "@dentalos/shared";
import { withAppRole, type Pool } from "@dentalos/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { devUserId, signDevToken } from "../auth.js";
import { HttpError, parse } from "../http.js";
import type { StaffContextService } from "../staff-context.js";

export function meRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; staff: StaffContextService; devLogin?: { secret: string; audience: string } },
) {
  // Called right after sign-in: creates the user record, claims invitations, lists clinics.
  app.get("/v1/me", async (request) => {
    const user = await deps.staff.authenticate(request);
    const memberships = await deps.staff.memberships(user, true);
    const profile = await withAppRole(
      deps.pool,
      async (c) =>
        (await c.query("select name, phone, email, ui_language from users where id = $1", [user.userId]))
          .rows[0],
      { userId: user.userId },
    );
    return {
      user: {
        id: user.userId,
        phone: user.phone,
        email: user.email,
        name: profile?.name ?? null,
        uiLanguage: profile?.ui_language ?? "en",
      },
      clinics: memberships.map((m) => ({
        id: m.clinicId,
        name: m.clinicName,
        role: m.role,
        displayName: m.displayName,
      })),
    };
  });

  app.patch("/v1/me", async (request) => {
    const user = await deps.staff.authenticate(request);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        uiLanguage: z.enum(["en", "hi"]).optional(),
      }),
      request.body,
    );
    await withAppRole(
      deps.pool,
      (c) =>
        c.query(
          "update users set name = coalesce($2, name), ui_language = coalesce($3, ui_language) where id = $1",
          [user.userId, body.name ?? null, body.uiLanguage ?? null],
        ),
      { userId: user.userId },
    );
    return { ok: true };
  });

  // What the signed-in person may do in the chosen clinic (the dashboard hides what they cannot use).
  app.get("/v1/me/permissions", async (request) => {
    const staff = await deps.staff.resolve(request);
    return { clinicId: staff.clinicId, role: staff.role, permissions: [...staff.permissions].sort() };
  });

  if (deps.devLogin) {
    const { secret, audience } = deps.devLogin;
    app.post("/v1/dev/login", async (request) => {
      const body = parse(z.object({ phone: z.string() }), request.body);
      const phone = normalizePhone(body.phone);
      if (!phone) throw new HttpError(400, "invalid_input", "Invalid phone number");
      const userId = devUserId(phone);
      return { token: await signDevToken(secret, audience, { userId, phone }), userId };
    });
  }
}
