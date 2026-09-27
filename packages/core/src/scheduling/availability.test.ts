import { describe, expect, it } from "vitest";
import { localMinutesOf } from "../time.js";
import { checkPlacement, findAvailableSlots, pickOptions } from "./availability.js";
import type { BusyInterval, ProcedureSpec, ScheduleConfig } from "./types.js";

const IST = "Asia/Kolkata";
const B = "branch-1";
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);
const hhmm = (d: Date) => {
  const m = localMinutesOf(d, IST);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// 2026-10-05 is a Monday; 2026-10-06 Tuesday; 2026-10-10 Saturday; 2026-10-11 Sunday.
function clinic(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  const weekdays = [1, 2, 3, 4, 5, 6];
  return {
    timezone: IST,
    slotStepMin: 15,
    minLeadMin: 30,
    doctors: [
      { id: "dr-sharma", name: "Dr. Sharma", kind: "permanent", active: true },
      { id: "dr-verma", name: "Dr. Verma", kind: "permanent", active: true },
      { id: "dr-ortho", name: "Dr. Ortho", kind: "visiting", active: true },
    ],
    chairs: [
      { id: "chair-1", branchId: B, name: "Chair 1", equipment: [], active: true, sortOrder: 1 },
      {
        id: "chair-2",
        branchId: B,
        name: "Chair 2",
        equipment: ["implant_motor"],
        active: true,
        sortOrder: 2,
      },
    ],
    workingHours: weekdays.flatMap((weekday) => [
      { branchId: B, doctorId: null, weekday, start: "10:00", end: "14:00" },
      { branchId: B, doctorId: null, weekday, start: "17:00", end: "21:00" },
    ]),
    breaks: [],
    visiting: [
      {
        branchId: B,
        doctorId: "dr-ortho",
        weekday: 2,
        start: "11:00",
        end: "13:00",
        validFrom: null,
        validTo: null,
      },
      {
        branchId: B,
        doctorId: "dr-ortho",
        weekday: 6,
        start: "11:00",
        end: "13:00",
        validFrom: null,
        validTo: null,
      },
    ],
    holidays: [],
    leaves: [],
    ...overrides,
  };
}

const scaling: ProcedureSpec = {
  id: "p-scaling",
  name: "Scaling",
  durationMin: 30,
  bufferMin: 0,
  requiredEquipment: [],
  allowedDoctorIds: [],
};
const rct: ProcedureSpec = {
  id: "p-rct",
  name: "RCT",
  durationMin: 45,
  bufferMin: 15,
  requiredEquipment: [],
  allowedDoctorIds: [],
};
const implant: ProcedureSpec = {
  id: "p-implant",
  name: "Implant",
  durationMin: 90,
  bufferMin: 15,
  requiredEquipment: ["implant_motor"],
  allowedDoctorIds: [],
};
const braces: ProcedureSpec = {
  id: "p-braces",
  name: "Braces adjustment",
  durationMin: 20,
  bufferMin: 0,
  requiredEquipment: [],
  allowedDoctorIds: ["dr-ortho"],
};

const NOW = at("2026-10-01", "09:00");
const q = (fromDate: string, toDate = fromDate, extra = {}) => ({
  branchId: B,
  fromDate,
  toDate,
  now: NOW,
  ...extra,
});

describe("findAvailableSlots", () => {
  it("offers slots inside split shifts on the step grid, never across the lunch gap", () => {
    const slots = findAvailableSlots(clinic(), scaling, [], q("2026-10-05"));
    const times = slots.map((s) => hhmm(s.start));
    expect(times[0]).toBe("10:00");
    expect(times).toContain("13:30");
    expect(times).not.toContain("13:45"); // 13:45 + 30 min would run past 14:00
    expect(times).not.toContain("15:00");
    expect(times).toContain("17:00");
    expect(times.at(-1)).toBe("20:30");
  });

  it("uses the procedure duration: a 45-minute RCT never starts after 13:15 in the morning shift", () => {
    const times = findAvailableSlots(clinic(), rct, [], q("2026-10-05")).map((s) => hhmm(s.start));
    expect(times).toContain("13:15");
    expect(times).not.toContain("13:30");
  });

  it("the buffer keeps the doctor and chair blocked after the procedure", () => {
    const [first] = findAvailableSlots(clinic(), rct, [], q("2026-10-05"));
    expect(hhmm(first!.end)).toBe("10:45");
    expect(hhmm(first!.occupiedUntil)).toBe("11:00");
  });

  it("is closed on Sundays and holidays", () => {
    expect(findAvailableSlots(clinic(), scaling, [], q("2026-10-11"))).toEqual([]);
    const withHoliday = clinic({ holidays: [{ branchId: null, date: "2026-10-05", name: "Dussehra" }] });
    expect(findAvailableSlots(withHoliday, scaling, [], q("2026-10-05"))).toEqual([]);
  });

  it("visiting consultants are only offered on their visiting days and hours", () => {
    const slots = findAvailableSlots(clinic(), braces, [], q("2026-10-05", "2026-10-11"));
    const days = new Set(slots.map((s) => s.date));
    expect([...days]).toEqual(["2026-10-06", "2026-10-10"]);
    expect(slots.every((s) => s.doctorId === "dr-ortho")).toBe(true);
    expect(slots.map((s) => hhmm(s.start))).toContain("12:30");
    expect(
      slots.every((s) => localMinutesOf(s.start, IST) >= 11 * 60 && localMinutesOf(s.end, IST) <= 13 * 60),
    ).toBe(true);
  });

  it("does not offer visiting consultants for general procedures unless allowed", () => {
    const slots = findAvailableSlots(clinic(), scaling, [], q("2026-10-06"));
    expect(slots.some((s) => s.doctorId === "dr-ortho")).toBe(false);
  });

  it("respects visiting schedule validity dates", () => {
    const config = clinic();
    config.visiting = config.visiting.map((v) => ({ ...v, validTo: "2026-10-07" }));
    const days = new Set(
      findAvailableSlots(config, braces, [], q("2026-10-05", "2026-10-11")).map((s) => s.date),
    );
    expect([...days]).toEqual(["2026-10-06"]);
  });

  it("only uses chairs with the required equipment", () => {
    const slots = findAvailableSlots(clinic(), implant, [], q("2026-10-05"));
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.chairId === "chair-2")).toBe(true);
  });

  it("removes breaks, and doctor-specific breaks only for that doctor", () => {
    const config = clinic({
      breaks: [{ branchId: B, doctorId: "dr-sharma", weekday: 1, start: "11:00", end: "12:00" }],
    });
    const at11 = findAvailableSlots(config, scaling, [], q("2026-10-05")).filter(
      (s) => hhmm(s.start) === "11:00",
    );
    expect(at11).toHaveLength(1);
    expect(at11[0]!.doctorId).toBe("dr-verma");
  });

  it("removes leave, including partial-day leave", () => {
    const config = clinic({
      leaves: [
        { doctorId: "dr-sharma", startsAt: at("2026-10-05", "00:00"), endsAt: at("2026-10-06", "00:00") },
        { doctorId: "dr-verma", startsAt: at("2026-10-05", "17:00"), endsAt: at("2026-10-05", "21:00") },
      ],
    });
    const slots = findAvailableSlots(config, scaling, [], q("2026-10-05"));
    expect(slots.every((s) => s.doctorId === "dr-verma")).toBe(true);
    expect(slots.every((s) => localMinutesOf(s.start, IST) < 14 * 60)).toBe(true);
  });

  it("uses a doctor's own hours instead of clinic hours when configured", () => {
    const config = clinic();
    config.workingHours.push({ branchId: B, doctorId: "dr-verma", weekday: 1, start: "18:00", end: "20:00" });
    const verma = findAvailableSlots(
      config,
      scaling,
      [],
      q("2026-10-05", "2026-10-05", { doctorId: "dr-verma" }),
    );
    expect(verma.map((s) => hhmm(s.start))[0]).toBe("18:00");
    expect(verma.every((s) => localMinutesOf(s.start, IST) >= 18 * 60)).toBe(true);
  });

  it("skips busy doctors and chairs and falls back to the other doctor", () => {
    const busy: BusyInterval[] = [
      { resourceId: "dr-sharma", start: at("2026-10-05", "10:00"), end: at("2026-10-05", "11:00") },
    ];
    const first = findAvailableSlots(clinic(), scaling, busy, q("2026-10-05"))[0]!;
    expect(first.doctorId).toBe("dr-verma");
    const bothChairsBusy: BusyInterval[] = [
      { resourceId: "chair-1", start: at("2026-10-05", "10:00"), end: at("2026-10-05", "10:30") },
      { resourceId: "chair-2", start: at("2026-10-05", "10:00"), end: at("2026-10-05", "10:45") },
    ];
    expect(hhmm(findAvailableSlots(clinic(), scaling, bothChairsBusy, q("2026-10-05"))[0]!.start)).toBe(
      "10:30",
    );
  });

  it("an emergency reserve on a chair behaves like a busy block", () => {
    const busy: BusyInterval[] = [
      { resourceId: "chair-2", start: at("2026-10-05", "10:00"), end: at("2026-10-05", "12:00") },
    ];
    expect(findAvailableSlots(clinic(), implant, busy, q("2026-10-05")).map((s) => hhmm(s.start))[0]).toBe(
      "12:00",
    );
  });

  it("never offers slots in the past or inside the minimum lead time", () => {
    const now = at("2026-10-05", "10:10");
    const slots = findAvailableSlots(clinic(), scaling, [], { ...q("2026-10-05"), now });
    expect(hhmm(slots[0]!.start)).toBe("10:45");
  });

  it("filters by part of day", () => {
    const evening = findAvailableSlots(
      clinic(),
      scaling,
      [],
      q("2026-10-05", "2026-10-05", { partsOfDay: ["evening"] }),
    );
    expect(evening.every((s) => localMinutesOf(s.start, IST) >= 16 * 60)).toBe(true);
    expect(evening.length).toBeGreaterThan(0);
  });

  it("returns nothing when no doctor or chair can do the procedure", () => {
    const noChair = clinic();
    noChair.chairs = noChair.chairs.filter((c) => c.id !== "chair-2");
    expect(findAvailableSlots(noChair, implant, [], q("2026-10-05"))).toEqual([]);
  });

  it("rejects very long searches", () => {
    expect(() => findAvailableSlots(clinic(), scaling, [], q("2026-10-01", "2027-01-01"))).toThrow(
      /too long/,
    );
  });
});

describe("pickOptions", () => {
  it("offers at most N options, spread across the day rather than 15 minutes apart", () => {
    const slots = findAvailableSlots(clinic(), scaling, [], q("2026-10-05", "2026-10-06"));
    const options = pickOptions(slots, 3, IST);
    expect(options).toHaveLength(3);
    expect(options.map((o) => hhmm(o.start))).toEqual(["10:00", "11:30", "13:00"]);
  });

  it("fills with the earliest remaining when few slots exist", () => {
    const slots = findAvailableSlots(clinic(), scaling, [], q("2026-10-05")).slice(0, 2);
    expect(pickOptions(slots, 3, IST)).toHaveLength(2);
  });
});

describe("checkPlacement (staff bookings)", () => {
  const place = (doctorId: string, chairId: string, date: string, s: string, e: string) => ({
    branchId: B,
    doctorId,
    chairId,
    start: at(date, s),
    end: at(date, e),
  });

  it("no warnings for a normal placement", () => {
    expect(
      checkPlacement(clinic(), place("dr-sharma", "chair-1", "2026-10-05", "10:00", "10:30"), scaling, NOW),
    ).toEqual([]);
  });

  it("warns outside hours, on holidays, on leave, and on a consultant's non-visiting day", () => {
    const config = clinic({
      holidays: [{ branchId: B, date: "2026-10-07", name: "Holiday" }],
      leaves: [
        { doctorId: "dr-verma", startsAt: at("2026-10-05", "00:00"), endsAt: at("2026-10-06", "00:00") },
      ],
    });
    expect(
      checkPlacement(config, place("dr-sharma", "chair-1", "2026-10-05", "15:00", "15:30"), scaling, NOW),
    ).toEqual(["outside_working_hours"]);
    expect(
      checkPlacement(config, place("dr-sharma", "chair-1", "2026-10-07", "10:00", "10:30"), scaling, NOW),
    ).toEqual(["holiday"]);
    expect(
      checkPlacement(config, place("dr-verma", "chair-1", "2026-10-05", "10:00", "10:30"), scaling, NOW),
    ).toEqual(["doctor_on_leave"]);
    expect(
      checkPlacement(config, place("dr-ortho", "chair-1", "2026-10-05", "11:00", "11:20"), braces, NOW),
    ).toEqual(["not_visiting_day"]);
  });

  it("warns about the wrong doctor or chair for a procedure, and past times", () => {
    expect(
      checkPlacement(
        clinic(),
        place("dr-ortho", "chair-1", "2026-10-06", "11:00", "12:30"),
        implant,
        NOW,
      ).sort(),
    ).toEqual(["chair_missing_equipment", "doctor_not_allowed"]);
    expect(
      checkPlacement(clinic(), place("dr-sharma", "chair-1", "2026-09-30", "10:00", "10:30"), scaling, NOW),
    ).toEqual(["in_past"]);
  });
});
