import { randomBytes } from "node:crypto";
import { createAdapters, type FakeTelephonyProvider } from "@dentalos/adapters";
import { createClinic, MemoryJobQueue } from "@dentalos/core";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "@dentalos/db/testing";
import { createLogger } from "@dentalos/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

const logger = createLogger({ service: "api-test", level: "silent" });
const auth = {
  jwtSecret: "test-secret-that-is-long-enough-1234567890",
  audience: "authenticated",
  devLogin: true,
};
const VIRTUAL = "+918047110001";
const CLINIC_PHONE = "+916512340001";

describe.skipIf(!hasTestDatabase)("phone calls: call-flow endpoints, calls list, voice settings", () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let clinicId: string;
  let token: string;
  let key: string;
  const jobs = new MemoryJobQueue();
  const staffCall = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}` },
    });
  const flow = (path: string, params: Record<string, string>) =>
    app.inject({ method: "GET", url: `/telephony/${path}?${new URLSearchParams({ key, ...params })}` });
  const voiceHealthy = (yes: boolean) =>
    yes
      ? db.pool.query(
          "insert into service_heartbeats (service) values ('voice') on conflict (service) do update set beat_at = now()",
        )
      : db.pool.query("delete from service_heartbeats where service = 'voice'");

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await db.pool.connect();
    try {
      ({ clinicId } = await createClinic(client, {
        name: "Call Dental",
        owner: { name: "Dr. C", phone: "9835000041" },
      }));
      await client.query("update clinics set phone = $2 where id = $1", [clinicId, CLINIC_PHONE]);
    } finally {
      client.release();
    }
    const adapters = createAdapters({
      messaging: "fake",
      telephony: "fake",
      voice: "fake",
      llm: "fake",
      payments: "fake",
      sms: "fake",
      storage: "fake",
    });
    key = (adapters.telephony as FakeTelephonyProvider).callbackToken;
    app = buildApp({
      pool: db.pool,
      adapters,
      logger,
      version: "test",
      auth,
      jobs,
      channelKey: randomBytes(32),
    });
    token = (
      await (
        await app.inject({ method: "POST", url: "/v1/dev/login", payload: { phone: "9835000041" } })
      ).json()
    ).token;
    await staffCall("GET", "/v1/me");
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it("owner connects the clinic's virtual number and sets staff phones", async () => {
    const res = await staffCall("PUT", "/v1/voice", {
      enabled: true,
      answerMode: "all",
      staffPhones: ["98350 00099"],
      virtualNumber: "080 4711 0001",
    });
    expect(res.statusCode).toBe(200);
    const got = (await staffCall("GET", "/v1/voice")).json();
    expect(got).toMatchObject({
      enabled: true,
      answerMode: "all",
      staffPhones: ["+919835000099"],
      virtualNumber: VIRTUAL,
      clinicPhone: CLINIC_PHONE,
    });
  });

  it("call-flow URLs refuse requests without the secret key", async () => {
    const res = await app.inject({ method: "GET", url: "/telephony/route?CallSid=x&CallTo=08047110001" });
    expect(res.statusCode).toBe(403);
  });

  it("routes to the assistant only while the voice service is healthy; unknown numbers go to the fallback", async () => {
    await voiceHealthy(true);
    expect(
      (await flow("route", { CallSid: "ca-1", CallFrom: "09876500001", CallTo: "08047110001" })).statusCode,
    ).toBe(200);
    await voiceHealthy(false);
    expect(
      (await flow("route", { CallSid: "ca-2", CallFrom: "09876500002", CallTo: "08047110001" })).statusCode,
    ).toBe(302);
    expect(
      (await flow("route", { CallSid: "ca-3", CallFrom: "09876500003", CallTo: "08000000000" })).statusCode,
    ).toBe(302);
    const calls = (await db.pool.query("select provider_call_id, route from calls order by provider_call_id"))
      .rows;
    expect(calls).toEqual([
      { provider_call_id: "ca-1", route: "assistant" },
      { provider_call_id: "ca-2", route: "forwarded_unhealthy" },
    ]);
  });

  it("after the assistant: connects a transfer in ring order, or hangs up", async () => {
    await db.pool.query(
      "update calls set transfer_kind = 'emergency', transfer_numbers = $2 where provider_call_id = $1",
      ["ca-1", ["+919835000001", CLINIC_PHONE]],
    );
    expect((await flow("after-assistant", { CallSid: "ca-1" })).statusCode).toBe(200);
    const connect = await flow("connect", { CallSid: "ca-1" });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({
      destination: { numbers: ["09835000001", "06512340001"] },
      outgoing_phone_number: "08047110001",
      record: true,
      start_call_playback: { value: expect.stringMatching(/Emergency/) },
    });
    // A forwarded call rings the clinic phone, then staff phones.
    expect((await flow("connect", { CallSid: "ca-2" })).json().destination.numbers).toEqual([
      "06512340001",
      "09835000099",
    ]);
    expect((await flow("after-assistant", { CallSid: "ca-2" })).statusCode).toBe(302);
  });

  it("nobody answered: a call-back task and a WhatsApp message to the caller", async () => {
    const res = await flow("missed", { CallSid: "ca-1", DialCallStatus: "no-answer" });
    expect(res.statusCode).toBe(200);
    const task = (await db.pool.query("select kind, priority from tasks where dedupe_key like 'missed:%'"))
      .rows;
    expect(task).toEqual([{ kind: "emergency", priority: "critical" }]);
    const msg = (await db.pool.query("select to_phone, purpose from outbox where purpose = 'missed_call'"))
      .rows;
    expect(msg).toEqual([{ to_phone: "+919876500001", purpose: "missed_call" }]);
    expect(jobs.jobs.some((j) => j.task === "send_outbox")).toBe(true);
  });

  it("status callback stores duration and queues the recording download; a forwarded call nobody took counts as missed", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/telephony/status?key=${key}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload:
        "CallSid=ca-1&Status=completed&ConversationDuration=74&RecordingUrl=https%3A%2F%2Frec%2Fca-1.mp3",
    });
    expect(res.statusCode).toBe(200);
    const row = (
      await db.pool.query(
        "select duration_sec, recording_url, status from calls where provider_call_id = 'ca-1'",
      )
    ).rows[0];
    expect(row).toEqual({ duration_sec: 74, recording_url: "https://rec/ca-1.mp3", status: "ended" });
    expect(jobs.jobs.some((j) => j.task === "fetch_recording")).toBe(true);

    await app.inject({
      method: "POST",
      url: `/telephony/status?key=${key}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "CallSid=ca-2&Status=no-answer",
    });
    const missed = (await db.pool.query("select outcome from calls where provider_call_id = 'ca-2'")).rows[0];
    expect(missed.outcome).toBe("forwarded");
    expect(
      (await db.pool.query("select count(*)::int as n from tasks where dedupe_key like 'missed:%'")).rows[0]
        .n,
    ).toBe(2);
  });

  it("staff see calls with the transcript and mark test calls pass or fail", async () => {
    const callId = (await db.pool.query("select id from calls where provider_call_id = 'ca-1'")).rows[0].id;
    await db.pool.query(
      "insert into call_turns (clinic_id, call_id, seq, speaker, text) values ($1,$2,1,'assistant','Namaste'),($1,$2,2,'caller','kal appointment')",
      [clinicId, callId],
    );
    const list = (await staffCall("GET", "/v1/calls")).json();
    expect(list.map((c: { id: string }) => c.id)).toContain(callId);
    const detail = (await staffCall("GET", `/v1/calls/${callId}`)).json();
    expect(detail.turns.map((t: { text: string }) => t.text)).toEqual(["Namaste", "kal appointment"]);
    expect(detail.call).not.toHaveProperty("state");
    expect(
      (await staffCall("POST", `/v1/calls/${callId}/test`, { result: "pass", notes: "clear" })).statusCode,
    ).toBe(200);
    expect((await staffCall("GET", "/v1/calls/test-summary")).json()).toEqual({
      passed: 1,
      failed: 0,
      target: 50,
    });
    expect((await staffCall("GET", "/v1/calls?filter=test")).json()).toHaveLength(1);
  });
});
