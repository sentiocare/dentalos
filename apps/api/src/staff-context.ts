import { effectivePermissions, isRole, type Permission, type Role } from "@dentalos/core";
import { withAppRole, withClinic, withPlatform, type Pool, type PoolClient } from "@dentalos/db";
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "./auth";
import { HttpError } from "./http";

export interface Membership {
  clinicId: string;
  clinicName: string;
  role: Role;
  permissions: Record<string, unknown>;
  displayName: string;
}

export interface StaffContext {
  user: AuthUser;
  clinicId: string;
  role: Role;
  displayName: string;
  permissions: Set<Permission>;
}

const CLINIC_HEADER = "x-clinic-id";
const MEMBERSHIP_TTL_MS = 30_000;

/**
 * Resolves who is calling and what they may do. Clinic and role always come from our membership table;
 * the dashboard picks a clinic with the X-Clinic-Id header when a person works at more than one.
 */
export function createStaffContext(deps: { pool: Pool; verify: (token: string) => Promise<AuthUser> }) {
  const cache = new Map<string, { at: number; memberships: Membership[] }>();

  async function authenticate(request: FastifyRequest): Promise<AuthUser> {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new HttpError(401, "unauthenticated", "Please sign in");
    try {
      return await deps.verify(token);
    } catch {
      throw new HttpError(401, "unauthenticated", "Your session has expired. Please sign in again");
    }
  }

  async function memberships(user: AuthUser, fresh = false): Promise<Membership[]> {
    const hit = cache.get(user.userId);
    if (!fresh && hit && Date.now() - hit.at < MEMBERSHIP_TTL_MS) return hit.memberships;
    const list = await withAppRole(
      deps.pool,
      async (c) => {
        if (fresh) await c.query("select app.ensure_user($1, $2, null)", [user.phone, user.email]);
        const { rows } = await c.query("select * from app.my_memberships()");
        return rows
          .filter((r) => isRole(r.role))
          .map((r) => ({
            clinicId: r.clinic_id,
            clinicName: r.clinic_name,
            role: r.role as Role,
            permissions: r.permissions ?? {},
            displayName: r.display_name,
          }));
      },
      { userId: user.userId },
    );
    cache.set(user.userId, { at: Date.now(), memberships: list });
    return list;
  }

  async function resolve(request: FastifyRequest, permission?: Permission): Promise<StaffContext> {
    const user = await authenticate(request);
    let list = await memberships(user);
    // First request after sign-in (or right after being invited): claim invitations by phone number.
    if (list.length === 0) list = await memberships(user, true);
    const wanted = request.headers[CLINIC_HEADER];
    const membership =
      typeof wanted === "string"
        ? list.find((m) => m.clinicId === wanted)
        : list.length === 1
          ? list[0]
          : undefined;
    if (!membership) {
      if (list.length === 0)
        throw new HttpError(403, "no_clinic", "Your number is not added to any clinic yet");
      throw new HttpError(400, "choose_clinic", "Choose a clinic", { clinics: list.map((m) => m.clinicId) });
    }
    const permissions = effectivePermissions(membership.role, membership.permissions);
    if (permission && !permissions.has(permission)) {
      throw new HttpError(403, "forbidden", "You do not have permission for this");
    }
    return {
      user,
      clinicId: membership.clinicId,
      role: membership.role,
      displayName: membership.displayName,
      permissions,
    };
  }

  /** Authenticates, checks the permission, and runs `fn` in a clinic-scoped transaction. */
  async function inClinic<T>(
    request: FastifyRequest,
    permission: Permission | undefined,
    fn: (client: PoolClient, staff: StaffContext) => Promise<T>,
  ): Promise<T> {
    const staff = await resolve(request, permission);
    return withClinic(
      deps.pool,
      {
        clinicId: staff.clinicId,
        userId: staff.user.userId,
        actor: `user:${staff.user.userId}`,
        role: staff.role,
      },
      (client) => fn(client, staff),
    );
  }

  async function isPlatformAdmin(user: AuthUser): Promise<boolean> {
    const { rowCount } = await deps.pool.query("select 1 from platform_admins where user_id = $1", [
      user.userId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Sentio's own staff only: runs `fn` across clinics (billing, health). */
  async function inPlatform<T>(
    request: FastifyRequest,
    fn: (client: PoolClient, user: AuthUser) => Promise<T>,
  ) {
    const user = await authenticate(request);
    if (!(await isPlatformAdmin(user))) throw new HttpError(403, "forbidden", "Sentio admins only");
    return withPlatform(deps.pool, `user:${user.userId}`, (client) => fn(client, user));
  }

  return {
    authenticate,
    isPlatformAdmin,
    inPlatform,
    memberships,
    resolve,
    inClinic,
    invalidate: (userId?: string) => (userId ? cache.delete(userId) : cache.clear()),
  };
}

export type StaffContextService = ReturnType<typeof createStaffContext>;
