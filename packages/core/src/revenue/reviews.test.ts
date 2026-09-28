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
import { advanceFollowups, planFollowups } from "./followups";
import { recordVisitFeedback, reviewSettings, reviewStats, saveReviewSettings } from "./reviews";

// Monday 7 January 2030.
const VISIT_END = new Date("2030-01-07T11:30:00+05:30");
const LINK = "https://g.page/r/CabcDEF123/review";

describe.skipIf(!hasTestDatabase)("Google reviews after a visit", () => {
  let db: TestDatabase;
  let c: SeededClinic;
  const run = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withClinic(db.pool, { clinicId: c.clinicId, actor: "system", role: "system" }, fn);
  const completed = (patientId: string, end: Date) =>
    run(
      async (cl) =>
        (
          await cl.query(
            `insert into appointments (clinic_id, branch_id, patient_id, doctor_id, chair_id, starts_at, ends_at, status)
             values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, 'completed') returning id`,
            [
              c.branchId,
              patientId,
              c.doctorIds[0],
              c.chairIds[0],
              new Date(end.getTime() - 30 * 60_000),
              end,
            ],
          )
        ).rows[0].id as string,
    );
  const reviewRuns = () =>
    db.pool
      .query("select subject_id, next_at from followup_runs where kind = 'review' order by next_at")
      .then((r) => r.rows);

  beforeAll(async () => {
    db = await createTestDatabase();
    c = await seedMinimalClinic(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("only a Google review link is accepted, and asking needs one", async () => {
    await expect(run((cl) => saveReviewSettings(cl, { enabled: true, link: null }))).rejects.toThrow(
      /link first/,
    );
    await expect(
      run((cl) => saveReviewSettings(cl, { enabled: true, link: "https://example.com/review" })),
    ).rejects.toThrow(/Google Business Profile/);
    await expect(run((cl) => saveReviewSettings(cl, { enabled: true, link: "g.page/x" }))).rejects.toThrow(
      /https/,
    );
    expect(await run((cl) => reviewSettings(cl))).toEqual({ enabled: false, link: null });
  });

  it("switched off: nobody is asked", async () => {
    await completed(c.patientIds[0]!, VISIT_END);
    await run((cl) => planFollowups(cl, new Date(VISIT_END.getTime() + 3 * 3600_000)));
    expect(await reviewRuns()).toEqual([]);
  });

  it("switched on: asked two hours after the visit, with two buttons; never twice in 6 months", async () => {
    await run((cl) => saveReviewSettings(cl, { enabled: true, link: LINK }));
    const later = new Date(VISIT_END.getTime() + 30 * 60_000);
    await run((cl) => planFollowups(cl, later));
    const runs = await reviewRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.next_at).toEqual(new Date(VISIT_END.getTime() + 2 * 3600_000));

    await run((cl) => advanceFollowups(cl, new Date(VISIT_END.getTime() + 2 * 3600_000)));
    const msg = (
      await db.pool.query("select payload from outbox where payload->>'purpose' = 'review_request'")
    ).rows[0].payload;
    expect(msg).toMatchObject({
      purpose: "review_request",
      params: ["Ramesh", expect.any(String)],
      buttonPayloads: [`review:${runs[0]!.subject_id}:good`, `review:${runs[0]!.subject_id}:bad`],
    });
    // No staff task when the patient doesn't answer: one message only.
    expect((await db.pool.query("select count(*)::int as n from tasks")).rows[0].n).toBe(0);

    // The same patient comes again next month: not asked again.
    const next = new Date("2030-02-07T11:30:00+05:30");
    await completed(c.patientIds[0]!, next);
    await run((cl) => planFollowups(cl, new Date(next.getTime() + 3 * 3600_000)));
    expect(await reviewRuns()).toHaveLength(1);
  });

  it("answers are counted for the owner's report", async () => {
    const appt = (await reviewRuns())[0]!.subject_id as string;
    await run((cl) =>
      recordVisitFeedback(cl, { appointmentId: appt, patientId: c.patientIds[0]!, rating: "bad" }),
    );
    await run((cl) =>
      recordVisitFeedback(cl, { appointmentId: appt, patientId: c.patientIds[0]!, rating: "good" }),
    );
    const stats = await run((cl) =>
      reviewStats(cl, { from: new Date("2020-01-01"), to: new Date("2099-01-01") }),
    );
    expect(stats).toEqual({ asked: 1, good: 1, bad: 0 });
  });
});
