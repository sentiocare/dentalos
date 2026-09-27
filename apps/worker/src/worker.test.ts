import { createAdapters } from "@dentalos/adapters";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { makeWorkerUtils, parseCrontab, runOnce } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { buildTaskList, CRONTAB, graphileLogger } from "./worker";

const logger = createLogger({ service: "worker-test", level: "silent" });
const adapters = createAdapters({
  messaging: "fake",
  telephony: "fake",
  voice: "fake",
  llm: "fake",
  payments: "fake",
  sms: "fake",
  storage: "fake",
});
const deps = (pool: never, version = "t") => ({ pool, version, logger, adapters, channelKey: null });

describe("worker config and schedule", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("crontab parses and only names known tasks", () => {
    const tasks = Object.keys(buildTaskList(deps(undefined as never)));
    for (const item of parseCrontab(CRONTAB)) expect(tasks).toContain(item.task);
  });
});

describe.skipIf(!hasTestDatabase)("worker with a database", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("runs the heartbeat job and records it", async () => {
    const utils = await makeWorkerUtils({ pgPool: db.pool, logger: graphileLogger(logger) });
    await utils.migrate();
    await utils.addJob("heartbeat", {});
    await runOnce({
      pgPool: db.pool,
      taskList: buildTaskList(deps(db.pool as never, "abc123")),
      logger: graphileLogger(logger),
    });
    const { rows } = await db.pool.query("select detail from service_heartbeats where service = 'worker'");
    expect(rows[0].detail).toEqual({ version: "abc123" });
    await utils.release();
  });

  it("runs the scheduling maintenance jobs without errors", async () => {
    const utils = await makeWorkerUtils({ pgPool: db.pool, logger: graphileLogger(logger) });
    await utils.addJob("sweep_holds", {});
    await utils.addJob("emergency_reserves", {});
    await utils.addJob("outbox_sweep", {});
    await runOnce({
      pgPool: db.pool,
      taskList: buildTaskList(deps(db.pool as never)),
      logger: graphileLogger(logger),
    });
    const { rows } = await db.pool.query(
      "select count(*)::int as n from graphile_worker.jobs where task_identifier in ('sweep_holds','emergency_reserves','outbox_sweep')",
    );
    expect(rows[0].n).toBe(0);
    await utils.release();
  });

  it("deduplicates jobs by jobKey (idempotent scheduling)", async () => {
    const utils = await makeWorkerUtils({ pgPool: db.pool, logger: graphileLogger(logger) });
    await utils.addJob("heartbeat", {}, { jobKey: "reminder:appt-1:day-before" });
    await utils.addJob("heartbeat", {}, { jobKey: "reminder:appt-1:day-before" });
    const { rows } = await db.pool.query(
      "select count(*)::int as n from graphile_worker.jobs where key = 'reminder:appt-1:day-before'",
    );
    expect(rows[0].n).toBe(1);
    await utils.release();
  });
});
