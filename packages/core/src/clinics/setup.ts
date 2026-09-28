import type { PoolClient } from "pg";
import { DomainError } from "../errors";
import { testModeOf } from "./test-mode";

/**
 * The owner's setup checklist (PLAN Phase 6, the onboarding wizard). Most steps are read from the clinic's
 * real data, so the list can't claim something is done when it isn't. Three steps can't be detected (hours
 * and prices look right, call forwarding is set on the clinic phone), so the owner ticks those.
 */
export const SETUP_STEPS = [
  { key: "clinic", required: true, href: "/settings#clinic" },
  { key: "doctors", required: true, href: "/settings#doctors" },
  { key: "hours", required: true, href: "/settings#hours", ticked: true },
  { key: "procedures", required: true, href: "/settings#procedures", ticked: true },
  { key: "staff", required: false, href: "/settings#staff" },
  { key: "whatsapp", required: true, href: "/settings#whatsapp" },
  { key: "voice", required: true, href: "/settings#voice" },
  { key: "forwarding", required: true, href: "/setup#forwarding", ticked: true },
  { key: "testCall", required: true, href: "/calls" },
  { key: "payments", required: false, href: "/settings#payments" },
  { key: "leadAds", required: false, href: "/settings#leadAds" },
  { key: "reviews", required: false, href: "/settings#reviews" },
  { key: "license", required: true, href: "/wallet" },
] as const;
export type SetupKey = (typeof SETUP_STEPS)[number]["key"];
const TICKED = SETUP_STEPS.filter((s) => "ticked" in s).map((s) => s.key as string);

export async function setupChecklist(client: PoolClient) {
  const row = (
    await client.query(
      `select c.phone, c.address, c.settings,
         (select count(*) from doctors d where d.active)::int as doctors,
         (select count(*) from clinic_memberships m where m.active)::int as staff,
         exists (select 1 from clinic_channels ch where ch.kind = 'whatsapp' and ch.active) as whatsapp,
         exists (select 1 from clinic_channels ch where ch.kind = 'voice' and ch.active) as voice,
         exists (select 1 from clinic_channels ch where ch.kind = 'payments' and ch.active) as payments,
         exists (select 1 from clinic_channels ch where ch.kind = 'meta_page' and ch.active) as lead_ads,
         exists (select 1 from calls k where k.is_test and k.test_result = 'pass') as test_call,
         exists (select 1 from licenses l where l.status = 'paid') as license
       from clinics c where c.id = app.current_clinic_id()`,
    )
  ).rows[0];
  const ticked = new Set<string>(row.settings?.setup?.confirmed ?? []);
  const auto: Record<string, boolean> = {
    clinic: Boolean(row.phone && row.address),
    doctors: row.doctors > 0,
    staff: row.staff > 1,
    whatsapp: row.whatsapp,
    voice: row.voice,
    testCall: row.test_call,
    payments: row.payments,
    leadAds: row.lead_ads,
    reviews: row.settings?.reviews?.enabled === true && Boolean(row.settings?.reviews?.link),
    license: row.license,
  };
  const steps = SETUP_STEPS.map((s) => ({
    key: s.key,
    required: s.required,
    href: s.href,
    ticked: TICKED.includes(s.key),
    done: TICKED.includes(s.key) ? ticked.has(s.key) : auto[s.key] === true,
  }));
  const required = steps.filter((s) => s.required);
  return {
    steps,
    done: required.filter((s) => s.done).length,
    total: required.length,
    ready: required.every((s) => s.done),
    testMode: testModeOf(row.settings),
  };
}

/** The owner ticks (or unticks) a step that can't be detected. */
export async function tickSetupStep(client: PoolClient, key: string, done: boolean) {
  if (!TICKED.includes(key)) throw new DomainError("invalid", "This step is checked automatically");
  await client.query(
    `update clinics set settings = jsonb_set(settings, '{setup}', coalesce(settings->'setup', '{}'::jsonb) || jsonb_build_object('confirmed',
       (select coalesce(jsonb_agg(distinct k), '[]'::jsonb) from (
          select jsonb_array_elements_text(coalesce(settings->'setup'->'confirmed', '[]'::jsonb)) as k
          union select $1::text where $2::boolean) x where $2::boolean or k <> $1)))
     where id = app.current_clinic_id()`,
    [key, done],
  );
  return setupChecklist(client);
}
