import { withAppRole, type Pool } from "@dentalos/db";

/** Records that the worker is alive; the API readiness check and admin panel read it. */
export function makeHeartbeatTask(deps: { pool: Pool; version: string }) {
  return async () => {
    await withAppRole(deps.pool, (c) =>
      c.query(
        `insert into service_heartbeats (service, beat_at, detail) values ('worker', now(), $1)
         on conflict (service) do update set beat_at = excluded.beat_at, detail = excluded.detail`,
        [{ version: deps.version }],
      ),
    );
  };
}
