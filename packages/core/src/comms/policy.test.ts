import { describe, expect, it } from "vitest";
import { decideContact, DEFAULT_HOURS, type ContactFacts } from "./policy";

const base = (over: Partial<ContactFacts> = {}): ContactFacts => ({
  category: "transactional",
  channel: "whatsapp",
  now: new Date("2026-10-13T11:00:00+05:30"),
  timezone: "Asia/Kolkata",
  optOuts: [],
  marketingConsent: false,
  lastInboundAt: null,
  hasApprovedTemplate: true,
  hours: DEFAULT_HOURS,
  ...over,
});

describe("decideContact", () => {
  it("uses a free-form message inside the 24-hour window, a template outside it", () => {
    expect(decideContact(base({ lastInboundAt: new Date("2026-10-13T09:00:00+05:30") }))).toEqual({
      allow: true,
      mode: "free_form",
    });
    expect(decideContact(base())).toEqual({ allow: true, mode: "template" });
    expect(decideContact(base({ hasApprovedTemplate: false }))).toEqual({
      allow: false,
      reason: "outside_window_no_template",
    });
  });

  it("STOP (opt-out of all) blocks reminders but not replies to the patient's own message", () => {
    const optOuts = [{ channel: "whatsapp", category: "all" }];
    expect(decideContact(base({ optOuts }))).toEqual({ allow: false, reason: "opted_out" });
    expect(
      decideContact(
        base({ optOuts, category: "service", lastInboundAt: new Date("2026-10-13T10:59:00+05:30") }),
      ),
    ).toEqual({ allow: true, mode: "free_form" });
  });

  it("a promotional opt-out does not block appointment reminders", () => {
    expect(decideContact(base({ optOuts: [{ channel: "all", category: "promotional" }] })).allow).toBe(true);
  });

  it("promotions need explicit marketing consent", () => {
    expect(decideContact(base({ category: "promotional" }))).toEqual({
      allow: false,
      reason: "no_marketing_consent",
    });
    expect(decideContact(base({ category: "promotional", marketingConsent: true })).allow).toBe(true);
  });

  it("business-initiated messages wait for allowed hours; retry time is the next opening", () => {
    const late = decideContact(base({ now: new Date("2026-10-13T22:15:00+05:30") }));
    expect(late).toEqual({
      allow: false,
      reason: "quiet_hours",
      retryAt: new Date("2026-10-14T07:00:00+05:30"),
    });
    const early = decideContact(
      base({ category: "promotional", marketingConsent: true, now: new Date("2026-10-13T08:00:00+05:30") }),
    );
    expect(early).toEqual({
      allow: false,
      reason: "quiet_hours",
      retryAt: new Date("2026-10-13T09:00:00+05:30"),
    });
  });

  it("critical alerts go out at any hour and ignore opt-outs", () => {
    expect(
      decideContact(
        base({
          category: "critical",
          now: new Date("2026-10-13T23:30:00+05:30"),
          optOuts: [{ channel: "all", category: "all" }],
        }),
      ),
    ).toEqual({ allow: true, mode: "template" });
  });
});
