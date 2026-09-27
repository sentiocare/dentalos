import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { makeWorkerUtils, parseCrontab, runOnce } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildTaskList, CRONTAB, graphileLogger } from "./worker.js";

const logger = createLogger({ service: "worker-test", level: "silent" });

describe("worker config and schedule", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("crontab parses and only names known tasks", () => {
    const tasks = Object.keys(buildTaskList({ pool: undefined as never, version: "t" }));
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
      taskList: buildTaskList({ pool: db.pool, version: "abc123" }),
      logger: graphileLogger(logger),
    });
    const { rows } = await db.pool.query("select detail from service_heartbeats where service = 'worker'");
    expect(rows[0].detail).toEqual({ version: "abc123" });
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
