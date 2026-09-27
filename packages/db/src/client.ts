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

export interface ClinicContext {
  clinicId: string;
  userId?: string;
  actor: Actor;
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
              set_config('app.actor', $3, true)`,
      [context.clinicId, context.userId ?? "", context.actor],
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

/** For non-tenant work (health checks, heartbeats) that still must not run as a privileged role. */
export async function withAppRole<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_user");
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
