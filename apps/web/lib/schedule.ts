import { doctorWindows, isHoliday } from "@dentalos/core/availability";
import type { ScheduleConfig } from "@dentalos/core/scheduling-types";
import type { ClinicConfig } from "./types";

/** Adapts the dashboard's config to the scheduling engine's shape, so the calendar and server agree. */
export function toScheduleConfig(config: ClinicConfig): ScheduleConfig {
  return {
    timezone: config.clinic.timezone,
    slotStepMin: config.clinic.slot_step_min,
    minLeadMin: config.clinic.min_booking_lead_min,
    doctors: config.doctors.map((d) => ({ id: d.id, name: d.name, kind: d.kind, active: d.active })),
    chairs: config.chairs.map((c) => ({
      id: c.id,
      branchId: c.branch_id,
      name: c.name,
      equipment: c.equipment,
      active: c.active,
      sortOrder: c.sort_order,
    })),
    workingHours: config.workingHours.map((w) => ({
      branchId: w.branch_id,
      doctorId: w.doctor_id,
      weekday: w.weekday,
      start: w.start,
      end: w.end,
    })),
    breaks: config.breaks.map((w) => ({
      branchId: w.branch_id,
      doctorId: w.doctor_id,
      weekday: w.weekday,
      start: w.start,
      end: w.end,
    })),
    visiting: config.visiting.map((v) => ({
      branchId: v.branch_id,
      doctorId: v.doctor_id,
      weekday: v.weekday,
      start: v.start,
      end: v.end,
      validFrom: v.valid_from,
      validTo: v.valid_to,
    })),
    holidays: config.holidays.map((h) => ({ branchId: h.branch_id, date: h.date, name: h.name })),
    leaves: config.leaves.map((l) => ({
      doctorId: l.doctor_id,
      startsAt: new Date(l.starts_at),
      endsAt: new Date(l.ends_at),
    })),
  };
}

export { doctorWindows, isHoliday };
