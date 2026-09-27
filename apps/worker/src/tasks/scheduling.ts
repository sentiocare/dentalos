import { materializeEmergencyReserves } from "@dentalos/core";
import type { Pool } from "@dentalos/db";
import type { Logger } from "@dentalos/shared/logger";

// These run with the worker's own database role across all clinics, because they call maintenance
// functions that the restricted app_user role cannot execute. They touch no patient data.

export function makeSweepHoldsTask(deps: { pool: Pool; logger: Logger }) {
  return async () => {
    const { rows } = await deps.pool.query("select app.sweep_expired_holds() as n");
    if (rows[0].n > 0) deps.logger.debug({ released: rows[0].n }, "expired slot holds released");
  };
}

export function makeEmergencyReservesTask(deps: { pool: Pool; logger: Logger }) {
  return async () => {
    const client = await deps.pool.connect();
    try {
      const created = await materializeEmergencyReserves(client, 14);
      if (created > 0) deps.logger.info({ created }, "emergency reserves materialised");
    } finally {
      client.release();
    }
  };
}
