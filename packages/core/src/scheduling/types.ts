import type { LocalDate } from "../time.js";

export interface TimeWindow {
  weekday: number;
  /** "HH:MM" */
  start: string;
  end: string;
}

export interface DoctorConfig {
  id: string;
  name: string;
  kind: "permanent" | "visiting" | "on_call";
  active: boolean;
}

export interface ChairConfig {
  id: string;
  branchId: string;
  name: string;
  equipment: string[];
  active: boolean;
  sortOrder: number;
}

export interface ScheduleConfig {
  timezone: string;
  slotStepMin: number;
  minLeadMin: number;
  doctors: DoctorConfig[];
  chairs: ChairConfig[];
  /** doctorId null = the branch's opening hours. */
  workingHours: (TimeWindow & { branchId: string; doctorId: string | null })[];
  breaks: (TimeWindow & { branchId: string; doctorId: string | null })[];
  visiting: (TimeWindow & {
    branchId: string;
    doctorId: string;
    validFrom: LocalDate | null;
    validTo: LocalDate | null;
  })[];
  /** branchId null = all branches closed. */
  holidays: { branchId: string | null; date: LocalDate; name: string }[];
  leaves: { doctorId: string; startsAt: Date; endsAt: Date }[];
}

export interface ProcedureSpec {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  requiredEquipment: string[];
  /** Empty = any permanent doctor. */
  allowedDoctorIds: string[];
}

/** A blocked period on a doctor or chair (appointments, active holds, emergency reserves). */
export interface BusyInterval {
  resourceId: string;
  start: Date;
  end: Date;
}

export type PartOfDay = "morning" | "afternoon" | "evening";

export interface SlotQuery {
  branchId: string;
  fromDate: LocalDate;
  toDate: LocalDate;
  doctorId?: string;
  partsOfDay?: PartOfDay[];
  now: Date;
}

export interface SlotCandidate {
  start: Date;
  end: Date;
  /** end + buffer: how long the doctor and chair stay blocked. */
  occupiedUntil: Date;
  doctorId: string;
  chairId: string;
  date: LocalDate;
}
