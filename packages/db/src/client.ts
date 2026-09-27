import pg from "pg";

// Postgres bigint (int8) holds money in paise; parse it to a JS number (safe far beyond any clinic's totals).
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value out of safe range: ${value}`);
  return n;
});

export type { Pool, PoolClient } from "pg";

export function createPool(
  connectionString: string,
  options: { max?: number; onError?: (error: Error) => void } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Keep voice tool calls fast: fail quickly instead of queueing behind a stuck connection.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "dentalos",
  });
  // An idle client losing its connection (e.g. a database restart) must not crash the process.
  const onError = options.onError ?? (() => {});
  pool.on("error", onError);
  pool.on("connect", (client) => client.on("error", onError));
  return pool;
}

export type Actor = "system" | `user:${string}` | `agent:voice` | `agent:whatsapp` | `job:${string}`;

export type StaffRole = "owner" | "doctor" | "receptionist" | "assistant";

export interface ClinicContext {
  clinicId: string;
  userId?: string;
  actor: Actor;
  /** Staff role, or "emergency"/"agent" for automated flows. Checked by privileged database functions. */
  role?: StaffRole | "emergency" | "agent" | "system";
}

/**
 * Runs `fn` in a transaction as the restricted app_user role with the clinic context set, so row-level
 * security limits every query to this clinic. All request and job code touching tenant data goes through
 * here. Settings are transaction-local and vanish on commit or rollback.
 */
export async function withClinic<T>(
  pool: pg.Pool,
  context: ClinicContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_user");
    await client.query(
      `select set_config('app.clinic_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.actor', $3, true),
              set_config('app.role', $4, true)`,
      [context.clinicId, context.userId ?? "", context.actor, context.role ?? ""],
    );
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * For work before a clinic is chosen (login, membership lookup) or non-tenant work (health checks,
 * heartbeats). Still runs as app_user, so no tenant table is readable.
 */
export async function withAppRole<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  options: { userId?: string } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_user");
    if (options.userId) await client.query("select set_config('app.user_id', $1, true)", [options.userId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Sentio's own work across clinics: billing (licenses, mandates, recharges, invoices), reconciliation and
 * the Sentio admin panel. Runs as the login role that owns the tables, so row-level security does not
 * limit it. Never use it to serve a clinic's request; use withClinic for that.
 */
export async function withPlatform<T>(
  pool: pg.Pool,
  actor: Actor,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor', $1, true)", [actor]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Inside withPlatform: makes clinic-scoped helpers (which read app.current_clinic_id()) act for one clinic. */
export async function actAsClinic(client: pg.PoolClient, clinicId: string): Promise<void> {
  await client.query("select set_config('app.clinic_id', $1, true)", [clinicId]);
}
