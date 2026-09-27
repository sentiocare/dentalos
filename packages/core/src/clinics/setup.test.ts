import { randomBytes } from "node:crypto";
import { FakeMessagingProvider } from "@dentalos/adapters";
import { withClinic } from "@dentalos/db";
import {
  createTestDatabase,
  hasTestDatabase,
  seedMinimalClinic,
  type SeededClinic,
  type TestDatabase,
} from "@dentalos/db/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectWhatsApp, getWhatsAppChannel } from "../comms/channels";
import { ensureConversation } from "../comms/conversations";
import { enqueueMessage, processOutbox } from "../comms/outbox";
import { setupChecklist, tickSetupStep } from "./setup";
import { saveTestMode } from "./test-mode";

const KEY = randomBytes(32);
const NOON = new Date("2026-10-13T12:00:00+05:30");
const STAFF = "+919835000171";
const PATIENT = "+919876543210";

describe.skipIf(!hasTestDatabase)("setup checklist and test mode", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "system", role: "system" }, fn);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
    await db.pool.query(
      "insert into clinic_memberships (clinic_id, invited_phone, display_name, role) values ($1, $2, 'Owner', 'owner')",
      [c.clinicId, STAFF],
    );
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("steps are read from real data; the owner ticks only what can't be detected", async () => {
    let list = await run(setupChecklist);
    const done = () => Object.fromEntries(list.steps.map((s) => [s.key, s.done]));
    expect(done()).toMatchObject({
      clinic: false,
      doctors: true,
      hours: false,
      whatsapp: false,
      license: false,
    });
    expect(list.ready).toBe(false);

    await run((cl) =>
      connectWhatsApp(cl, KEY, {
        phoneNumberId: "109876543210",
        displayPhone: "0651 2345678",
        accessToken: "EAAG-x",
      }),
    );
    list = await run((cl) => tickSetupStep(cl, "hours", true));
    expect(done()).toMatchObject({ whatsapp: true, hours: true });
    list = await run((cl) => tickSetupStep(cl, "hours", true));
    list = await run((cl) => tickSetupStep(cl, "forwarding", true));
    list = await run((cl) => tickSetupStep(cl, "hours", false));
    expect(done()).toMatchObject({ hours: false, forwarding: true });
    await expect(run((cl) => tickSetupStep(cl, "whatsapp", true))).rejects.toThrow(/automatically/);
    expect(list.total).toBe(list.steps.filter((s) => s.required).length);
  });

  it("test mode: staff and listed numbers get messages; patients' are logged but never sent", async () => {
    await run((cl) => saveTestMode(cl, { on: true, phones: ["98111 22233"] }));
    await expect(run((cl) => saveTestMode(cl, { on: true, phones: ["12"] }))).rejects.toThrow(/not valid/);
    const messaging = new FakeMessagingProvider();
    const deps = { messaging, channel: (cl: PoolClient) => getWhatsAppChannel(cl, KEY), now: () => NOON };
    const send = async (to: string, key: string) => {
      // The person wrote to the clinic a minute ago, so a plain reply is allowed.
      await run(async (cl) => {
        const conv = await ensureConversation(cl, to);
        await cl.query("update conversations set last_inbound_at = $2 where id = $1", [
          conv.id,
          new Date(NOON.getTime() - 60_000),
        ]);
      });
      const id = await run((cl) =>
        enqueueMessage(cl, {
          to,
          category: "service",
          purpose: "test",
          payload: { kind: "text", text: "Test booking confirmed" },
          dedupeKey: key,
          notBefore: NOON,
        }),
      );
      return run((cl) => processOutbox(cl, id!, deps));
    };
    expect(await send(PATIENT, "t1")).toEqual({ status: "blocked", reason: "test_mode" });
    expect((await send(STAFF, "t2")).status).toBe("sent");
    expect((await send("+919811122233", "t3")).status).toBe("sent");
    expect(messaging.sent.map((m) => m.to)).toEqual([STAFF, "+919811122233"]);
    const logged = await db.pool.query("select status, error from messages where error = 'test_mode'");
    expect(logged.rows).toEqual([{ status: "blocked", error: "test_mode" }]);

    await run((cl) => saveTestMode(cl, { on: false }));
    expect((await send(PATIENT, "t4")).status).toBe("sent");
    expect((await run(setupChecklist)).testMode).toEqual({ on: false, phones: [] });
  });
});
