import {
  addDays,
  daysBetween,
  localDateOf,
  localMinutesOf,
  parseTime,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from "../time";
import type {
  BusyInterval,
  ChairConfig,
  DoctorConfig,
  PartOfDay,
  ProcedureSpec,
  ScheduleConfig,
  SlotCandidate,
  SlotQuery,
} from "./types";

type Range = [start: number, end: number]; // minutes since local midnight

const PART_OF_DAY: Record<PartOfDay, Range> = {
  morning: [0, 12 * 60],
  afternoon: [12 * 60, 16 * 60],
  evening: [16 * 60, 24 * 60],
};

export const MAX_SEARCH_DAYS = 62;

function subtract(ranges: Range[], cut: Range): Range[] {
  const out: Range[] = [];
  for (const [s, e] of ranges) {
    if (cut[1] <= s || cut[0] >= e) {
      out.push([s, e]);
      continue;
    }
    if (cut[0] > s) out.push([s, cut[0]]);
    if (cut[1] < e) out.push([cut[1], e]);
  }
  return out;
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function isHoliday(config: ScheduleConfig, branchId: string, date: LocalDate): boolean {
  return config.holidays.some((h) => h.date === date && (h.branchId === null || h.branchId === branchId));
}

/** Doctors who may perform the procedure: the explicit list, or every active permanent doctor. */
export function eligibleDoctors(config: ScheduleConfig, procedure: ProcedureSpec): DoctorConfig[] {
  const active = config.doctors.filter((d) => d.active);
  if (procedure.allowedDoctorIds.length > 0) {
    const allowed = new Set(procedure.allowedDoctorIds);
    return active.filter((d) => allowed.has(d.id));
  }
  return active.filter((d) => d.kind === "permanent");
}

export function eligibleChairs(
  config: ScheduleConfig,
  branchId: string,
  procedure: ProcedureSpec,
): ChairConfig[] {
  return config.chairs
    .filter((c) => c.active && c.branchId === branchId)
    .filter((c) => procedure.requiredEquipment.every((eq) => c.equipment.includes(eq)))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * When the doctor is working on a date, as minute ranges in clinic-local time.
 * Visiting consultants: only their visiting windows. Others: their own hours if they have any configured,
 * otherwise the branch's hours. Breaks, leaves and holidays are removed.
 */
export function doctorWindows(
  config: ScheduleConfig,
  doctor: DoctorConfig,
  branchId: string,
  date: LocalDate,
): Range[] {
  if (isHoliday(config, branchId, date)) return [];
  const weekday = weekdayOf(date);

  let ranges: Range[];
  if (doctor.kind === "visiting") {
    ranges = config.visiting
      .filter(
        (v) =>
          v.doctorId === doctor.id &&
          v.branchId === branchId &&
          v.weekday === weekday &&
          (v.validFrom === null || v.validFrom <= date) &&
          (v.validTo === null || v.validTo >= date),
      )
      .map((v) => [parseTime(v.start), parseTime(v.end)]);
  } else {
    const own = config.workingHours.filter((w) => w.doctorId === doctor.id && w.branchId === branchId);
    const source =
      own.length > 0
        ? own
        : config.workingHours.filter((w) => w.doctorId === null && w.branchId === branchId);
    ranges = source.filter((w) => w.weekday === weekday).map((w) => [parseTime(w.start), parseTime(w.end)]);
  }
  ranges = merge(ranges);

  for (const b of config.breaks) {
    if (b.branchId !== branchId || b.weekday !== weekday) continue;
    if (b.doctorId !== null && b.doctorId !== doctor.id) continue;
    ranges = subtract(ranges, [parseTime(b.start), parseTime(b.end)]);
  }

  const dayStart = zonedInstant(date, 0, config.timezone).getTime();
  for (const leave of config.leaves) {
    if (leave.doctorId !== doctor.id) continue;
    const s = Math.floor((leave.startsAt.getTime() - dayStart) / 60_000);
    const e = Math.ceil((leave.endsAt.getTime() - dayStart) / 60_000);
    if (e <= 0 || s >= 24 * 60) continue;
    ranges = subtract(ranges, [Math.max(0, s), Math.min(24 * 60, e)]);
  }
  return ranges;
}

class BusyIndex {
  private readonly byResource = new Map<string, BusyInterval[]>();

  constructor(busy: BusyInterval[]) {
    for (const b of busy) {
      const list = this.byResource.get(b.resourceId) ?? [];
      list.push(b);
      this.byResource.set(b.resourceId, list);
    }
  }

  isFree(resourceId: string, start: Date, end: Date): boolean {
    const list = this.byResource.get(resourceId);
    if (!list) return true;
    const s = start.getTime();
    const e = end.getTime();
    return !list.some((b) => b.start.getTime() < e && b.end.getTime() > s);
  }
}

/**
 * Every bookable slot for the procedure, in time order. One candidate per start time: if several doctors
 * are free, the first eligible doctor (in configuration order) and first suitable free chair are chosen.
 * Pure function: the caller loads configuration and busy intervals.
 */
export function findAvailableSlots(
  config: ScheduleConfig,
  procedure: ProcedureSpec,
  busy: BusyInterval[],
  query: SlotQuery,
): SlotCandidate[] {
  const span = daysBetween(query.fromDate, query.toDate);
  if (span < 0) return [];
  if (span > MAX_SEARCH_DAYS) throw new RangeError(`Search range too long (max ${MAX_SEARCH_DAYS} days)`);

  let doctors = eligibleDoctors(config, procedure);
  if (query.doctorId) doctors = doctors.filter((d) => d.id === query.doctorId);
  const chairs = eligibleChairs(config, query.branchId, procedure);
  if (doctors.length === 0 || chairs.length === 0) return [];

  const index = new BusyIndex(busy);
  const earliest = query.now.getTime() + config.minLeadMin * 60_000;
  const step = config.slotStepMin;
  const partRanges = query.partsOfDay?.map((p) => PART_OF_DAY[p]);
  const results: SlotCandidate[] = [];

  for (let i = 0; i <= span; i++) {
    const date = addDays(query.fromDate, i);
    const windows = new Map(doctors.map((d) => [d.id, doctorWindows(config, d, query.branchId, date)]));
    const starts = new Set<number>();
    for (const ranges of windows.values()) {
      for (const [s, e] of ranges) {
        for (let t = Math.ceil(s / step) * step; t + procedure.durationMin <= e; t += step) starts.add(t);
      }
    }

    for (const t of [...starts].sort((a, b) => a - b)) {
      if (partRanges && !partRanges.some(([ps, pe]) => t >= ps && t < pe)) continue;
      const start = zonedInstant(date, t, config.timezone);
      if (start.getTime() < earliest) continue;
      const end = new Date(start.getTime() + procedure.durationMin * 60_000);
      const occupiedUntil = new Date(end.getTime() + procedure.bufferMin * 60_000);

      const doctor = doctors.find(
        (d) =>
          (windows.get(d.id) ?? []).some(([s, e]) => t >= s && t + procedure.durationMin <= e) &&
          index.isFree(d.id, start, occupiedUntil),
      );
      if (!doctor) continue;
      const chair = chairs.find((c) => index.isFree(c.id, start, occupiedUntil));
      if (!chair) continue;
      results.push({ start, end, occupiedUntil, doctorId: doctor.id, chairId: chair.id, date });
    }
  }
  return results;
}

/**
 * Chooses a few options worth offering a caller (Build Prompt §6.3: at most 2–3). Prefers the earliest slot,
 * then options at clearly different times (another part of the day, or another day) rather than three
 * slots 15 minutes apart.
 */
export function pickOptions(
  candidates: SlotCandidate[],
  count: number,
  timezone: string,
  minGapMin = 90,
): SlotCandidate[] {
  const chosen: SlotCandidate[] = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    const farEnough = chosen.every(
      (x) =>
        x.date !== c.date ||
        Math.abs(localMinutesOf(x.start, timezone) - localMinutesOf(c.start, timezone)) >= minGapMin,
    );
    if (farEnough) chosen.push(c);
  }
  // Not enough spread-out options: fill with the next earliest ones.
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (!chosen.includes(c)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export type PlacementWarning =
  | "in_past"
  | "holiday"
  | "outside_working_hours"
  | "not_visiting_day"
  | "doctor_on_leave"
  | "doctor_not_allowed"
  | "chair_missing_equipment"
  | "doctor_inactive"
  | "chair_inactive";

/**
 * Checks a staff-chosen placement against the schedule. Staff may book anyway after seeing the warnings
 * (they know the clinic); automated agents never book with warnings. Double booking is not a warning: the
 * database refuses it outright.
 */
export function checkPlacement(
  config: ScheduleConfig,
  placement: { branchId: string; doctorId: string; chairId: string; start: Date; end: Date },
  procedure: ProcedureSpec | null,
  now: Date,
): PlacementWarning[] {
  const warnings = new Set<PlacementWarning>();
  const doctor = config.doctors.find((d) => d.id === placement.doctorId);
  const chair = config.chairs.find((c) => c.id === placement.chairId);
  if (placement.start.getTime() < now.getTime()) warnings.add("in_past");
  if (!doctor?.active) warnings.add("doctor_inactive");
  if (!chair?.active) warnings.add("chair_inactive");

  const date = localDateOf(placement.start, config.timezone);
  if (isHoliday(config, placement.branchId, date)) warnings.add("holiday");

  if (doctor) {
    const s = localMinutesOf(placement.start, config.timezone);
    const e = s + Math.round((placement.end.getTime() - placement.start.getTime()) / 60_000);
    const inside = doctorWindows(config, doctor, placement.branchId, date).some(
      ([ws, we]) => s >= ws && e <= we,
    );
    if (!inside && !warnings.has("holiday")) {
      const onLeave = config.leaves.some(
        (l) => l.doctorId === doctor.id && l.startsAt < placement.end && l.endsAt > placement.start,
      );
      if (onLeave) warnings.add("doctor_on_leave");
      else warnings.add(doctor.kind === "visiting" ? "not_visiting_day" : "outside_working_hours");
    }
  }

  if (procedure) {
    if (doctor && !eligibleDoctors(config, procedure).some((d) => d.id === doctor.id))
      warnings.add("doctor_not_allowed");
    if (chair && !procedure.requiredEquipment.every((eq) => chair.equipment.includes(eq))) {
      warnings.add("chair_missing_equipment");
    }
  }
  return [...warnings];
}
