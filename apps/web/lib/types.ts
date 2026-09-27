export interface Doctor {
  id: string;
  name: string;
  speciality: string | null;
  kind: "permanent" | "visiting" | "on_call";
  phone: string | null;
  emergency_order: number | null;
  color: string | null;
  active: boolean;
}

export interface Chair {
  id: string;
  branch_id: string;
  name: string;
  equipment: string[];
  active: boolean;
  sort_order: number;
}

export interface Procedure {
  id: string;
  code: string;
  name: string;
  name_hi: string | null;
  default_duration_min: number;
  buffer_after_min: number;
  price_min_paise: number | null;
  price_max_paise: number | null;
  price_public: boolean;
  gst_mode: "exempt" | "taxable";
  gst_rate_bps: number;
  allowed_doctor_ids: string[];
  required_equipment: string[];
  is_consultation: boolean;
  active: boolean;
  synonyms: string[];
  recall_months?: number | null;
  checkin?: boolean;
  aftercare?: { en: string; hi: string; approved: boolean } | null;
  deposit_paise?: number | null;
}

export interface Window {
  id: string;
  branch_id: string;
  doctor_id: string | null;
  weekday: number;
  start: string;
  end: string;
}

export interface ClinicConfig {
  clinic: {
    id: string;
    name: string;
    timezone: string;
    slot_step_min: number;
    hold_minutes: number;
    min_booking_lead_min: number;
    default_language: string;
    languages: string[];
  };
  branches: { id: string; name: string; is_default: boolean }[];
  doctors: Doctor[];
  chairs: Chair[];
  procedures: Procedure[];
  workingHours: Window[];
  breaks: (Window & { label: string | null })[];
  visiting: (Window & { doctor_id: string; valid_from: string | null; valid_to: string | null })[];
  holidays: { id: string; branch_id: string | null; date: string; name: string }[];
  leaves: { id: string; doctor_id: string; starts_at: string; ends_at: string; reason: string | null }[];
  emergencySlots: {
    id: string;
    chair_id: string;
    weekday: number;
    start: string;
    duration_min: number;
    active: boolean;
  }[];
}

export type AppointmentStatus =
  "booked" | "confirmed" | "checked_in" | "in_chair" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  branchId: string;
  startsAt: string;
  endsAt: string;
  bufferMin: number;
  status: AppointmentStatus;
  source: string;
  notes: string | null;
  patient: { id: string; name: string; phone: string | null };
  doctor: { id: string; name: string; color: string | null };
  chair: { id: string; name: string };
  procedure: { id: string; name: string; nameHi: string | null } | null;
  /** Set locally while a change made offline waits to be sent. */
  pending?: boolean;
}

export interface Patient {
  id: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: string | null;
  approxBirthYear: number | null;
  gender: "female" | "male" | "other" | "unknown";
  languagePref: string | null;
  source: string | null;
  address: string | null;
  city: string | null;
  notes: string | null;
  fileNumber: string | null;
  lastVisitAt: string | null;
}
