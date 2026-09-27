import { normalizePhone } from "@dentalos/shared";
import { isLocalDate, type LocalDate } from "../time.js";
import { isLikelySamePerson, normalizeName } from "./names.js";

/**
 * Importing a clinic's existing patient list from Excel/CSV (Build Prompt §5.5). Files come from registers
 * typed by receptionists, so headers, dates and phone numbers are messy. Parsing happens in the browser
 * (CSV or .xlsx → rows of text); this module maps, validates and finds duplicates.
 */

export type PatientField =
  | "name"
  | "phone"
  | "altPhone"
  | "dob"
  | "age"
  | "gender"
  | "address"
  | "city"
  | "notes"
  | "fileNumber"
  | "source";

const HEADER_SYNONYMS: Record<PatientField, string[]> = {
  name: ["name", "patient name", "patient", "full name", "naam", "नाम", "मरीज़ का नाम", "patient's name"],
  phone: [
    "phone",
    "mobile",
    "mobile no",
    "mobile number",
    "phone number",
    "contact",
    "contact no",
    "contact number",
    "mob",
    "ph",
    "फ़ोन",
    "मोबाइल",
    "whatsapp",
  ],
  altPhone: [
    "alt phone",
    "alternate phone",
    "phone 2",
    "mobile 2",
    "alternate mobile",
    "other phone",
    "landline",
  ],
  dob: ["dob", "date of birth", "birth date", "birthday", "जन्म तिथि"],
  age: ["age", "umar", "umr", "उम्र", "age (years)"],
  gender: ["gender", "sex", "लिंग"],
  address: ["address", "addr", "पता"],
  city: ["city", "town", "place", "area", "शहर"],
  notes: ["notes", "remarks", "remark", "comments", "history", "complaint"],
  fileNumber: [
    "file no",
    "file number",
    "reg no",
    "registration no",
    "registration number",
    "opd no",
    "card no",
    "patient id",
    "id",
  ],
  source: ["source", "reference", "referred by", "how found", "lead source"],
};

function cleanHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[._\-:#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Guesses which column holds which field. Staff can correct the mapping in the preview. */
export function guessMapping(headers: string[]): Partial<Record<PatientField, string>> {
  const mapping: Partial<Record<PatientField, string>> = {};
  const used = new Set<string>();
  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [PatientField, string[]][]) {
    const match = headers.find((h) => !used.has(h) && synonyms.includes(cleanHeader(h)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }
  return mapping;
}

export interface ImportedPatient {
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: LocalDate | null;
  approxBirthYear: number | null;
  gender: "female" | "male" | "other" | "unknown";
  address: string | null;
  city: string | null;
  notes: string | null;
  fileNumber: string | null;
  source: string | null;
}

export type RowIssue = "missing_name" | "invalid_phone" | "invalid_dob" | "invalid_age" | "no_phone";

const GENDERS: Record<string, ImportedPatient["gender"]> = {
  m: "male",
  male: "male",
  man: "male",
  purush: "male",
  पुरुष: "male",
  boy: "male",
  f: "female",
  female: "female",
  woman: "female",
  mahila: "female",
  महिला: "female",
  स्त्री: "female",
  girl: "female",
  o: "other",
  other: "other",
};

/** Accepts dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd and Excel serial numbers. Day-first, as in India. */
export function parseIndianDate(input: string, today: LocalDate): LocalDate | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 100) {
      const century = y + 2000 > Number(today.slice(0, 4)) ? 1900 : 2000;
      y += century;
    }
  }
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!isLocalDate(iso)) return null;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) return null;
  if (iso > today || y < 1900) return null;
  return iso;
}

function text(v: string | undefined): string | null {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

export function normalizePatientRow(
  raw: Record<string, string | undefined>,
  mapping: Partial<Record<PatientField, string>>,
  today: LocalDate,
): { value: ImportedPatient | null; issues: RowIssue[] } {
  const get = (f: PatientField) => (mapping[f] ? raw[mapping[f]!] : undefined);
  const issues: RowIssue[] = [];

  const name = text(get("name"));
  if (!name) issues.push("missing_name");

  const phoneRaw = text(get("phone"));
  // Registers often hold two numbers in one cell: "98765 43210 / 91234 56789".
  const phoneParts = phoneRaw
    ? phoneRaw
        .split(/[,/;|]|\s{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const phones = phoneParts
    .map((p) => normalizePhone(p))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (phoneRaw && phones.length === 0) issues.push("invalid_phone");
  const altRaw = text(get("altPhone"));
  const alt = altRaw ? normalizePhone(altRaw) : null;

  const dobRaw = text(get("dob"));
  const dob = dobRaw ? parseIndianDate(dobRaw, today) : null;
  if (dobRaw && !dob) issues.push("invalid_dob");

  const ageRaw = text(get("age"));
  let approxBirthYear: number | null = null;
  if (ageRaw && !dob) {
    const age = Number(ageRaw.replace(/\s*(yrs?|years?|y|saal|वर्ष)\.?$/i, ""));
    if (Number.isFinite(age) && age >= 0 && age <= 120)
      approxBirthYear = Number(today.slice(0, 4)) - Math.round(age);
    else issues.push("invalid_age");
  }

  const genderRaw = text(get("gender"))?.toLowerCase();
  const gender = (genderRaw && GENDERS[genderRaw]) || "unknown";

  if (!phones[0] && !alt && !issues.includes("invalid_phone")) issues.push("no_phone");

  if (!name) return { value: null, issues };
  return {
    value: {
      name,
      phone: phones[0] ?? null,
      altPhone: alt ?? phones[1] ?? null,
      dob,
      approxBirthYear,
      gender,
      address: text(get("address")),
      city: text(get("city")),
      notes: text(get("notes")),
      fileNumber: text(get("fileNumber")),
      source: text(get("source")),
    },
    issues,
  };
}

export interface ExistingPatient {
  id: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
}

export interface PreviewRow {
  row: number;
  value: ImportedPatient | null;
  issues: RowIssue[];
  /** Existing patient that is probably the same person. */
  duplicateOf?: { id: string; name: string };
  /** Earlier row in the same file that is probably the same person. */
  duplicateOfRow?: number;
  /** Suggested action; staff can change it. Rows without a name are always skipped. */
  action: "create" | "skip" | "merge";
}

/**
 * Builds the preview staff review before anything is saved. Duplicates (same phone number and a matching
 * name, against existing patients or earlier rows) default to "merge" so no information is lost; rows
 * with the same phone but a different name are family members and are created.
 */
export function buildPatientImportPreview(
  rows: Record<string, string | undefined>[],
  mapping: Partial<Record<PatientField, string>>,
  existing: ExistingPatient[],
  today: LocalDate,
): PreviewRow[] {
  const byPhone = new Map<string, ExistingPatient[]>();
  for (const p of existing) {
    for (const ph of [p.phone, p.altPhone]) {
      if (!ph) continue;
      byPhone.set(ph, [...(byPhone.get(ph) ?? []), p]);
    }
  }
  const seen = new Map<string, { row: number; name: string }[]>();
  const seenNoPhone = new Map<string, number>();

  return rows.map((raw, index) => {
    const row = index + 1;
    const { value, issues } = normalizePatientRow(raw, mapping, today);
    if (!value) return { row, value, issues, action: "skip" as const };

    const phones = [value.phone, value.altPhone].filter((p): p is string => !!p);
    const existingMatch = phones
      .flatMap((ph) => byPhone.get(ph) ?? [])
      .find((p) => isLikelySamePerson(p.name, value.name));
    if (existingMatch) {
      return {
        row,
        value,
        issues,
        duplicateOf: { id: existingMatch.id, name: existingMatch.name },
        action: "merge" as const,
      };
    }

    const earlier = phones
      .flatMap((ph) => seen.get(ph) ?? [])
      .find((s) => isLikelySamePerson(s.name, value.name));
    const noPhoneKey = phones.length === 0 ? normalizeName(value.name) : null;
    const earlierNoPhone = noPhoneKey ? seenNoPhone.get(noPhoneKey) : undefined;
    for (const ph of phones) seen.set(ph, [...(seen.get(ph) ?? []), { row, name: value.name }]);
    if (noPhoneKey && earlierNoPhone === undefined) seenNoPhone.set(noPhoneKey, row);

    const dupRow = earlier?.row ?? earlierNoPhone;
    if (dupRow !== undefined) return { row, value, issues, duplicateOfRow: dupRow, action: "skip" as const };
    return { row, value, issues, action: "create" as const };
  });
}
