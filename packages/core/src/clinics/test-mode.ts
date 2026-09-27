import type { PoolClient } from "pg";
import { normalizePhone } from "@dentalos/shared";
import { DomainError } from "../errors";

/**
 * Test mode (PLAN Phase 6): while a clinic is being set up, messages and calls reach only the clinic's own
 * staff (and any extra numbers the owner lists), so test bookings never message a real patient.
 * Blocked messages are logged with the reason "test_mode" so the owner can see what would have gone out.
 */
export interface TestMode {
  on: boolean;
  phones: string[];
}

export function testModeOf(settings: { testMode?: Partial<TestMode> } | null | undefined): TestMode {
  return { on: settings?.testMode?.on === true, phones: settings?.testMode?.phones ?? [] };
}

/** True when test mode is on and `phone` is not a staff member's or a listed test number. */
export async function blockedByTestMode(
  client: PoolClient,
  phone: string,
  settings: { testMode?: Partial<TestMode> } | null | undefined,
): Promise<boolean> {
  const mode = testModeOf(settings);
  if (!mode.on) return false;
  if (mode.phones.includes(phone)) return false;
  const staff = await client.query(
    `select 1 from clinic_memberships m left join users u on u.id = m.user_id
     where m.clinic_id = app.current_clinic_id() and m.active and (m.invited_phone = $1 or u.phone = $1) limit 1`,
    [phone],
  );
  return staff.rowCount === 0;
}

export async function saveTestMode(client: PoolClient, input: { on: boolean; phones?: string[] }) {
  const phones = (input.phones ?? []).map((p) => {
    const n = normalizePhone(p);
    if (!n) throw new DomainError("invalid", `The phone number ${p} is not valid`);
    return n as string;
  });
  const mode: TestMode = { on: input.on, phones: [...new Set(phones)] };
  await client.query(
    "update clinics set settings = jsonb_set(settings, '{testMode}', $1::jsonb) where id = app.current_clinic_id()",
    [JSON.stringify(mode)],
  );
  return mode;
}
