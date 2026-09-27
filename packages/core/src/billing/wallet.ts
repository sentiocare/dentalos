import type { PaymentProvider } from "@dentalos/adapters";
import { formatINR, type Paise } from "@dentalos/shared";
import type { PoolClient } from "pg";
import { enqueueMessage } from "../comms/outbox";
import { DomainError } from "../errors";
import { localDateOf, zonedInstant } from "../time";

/**
 * The prepaid usage wallet and what each of its states allows (PLAN §5.6, Build Prompt §4.3):
 *
 * | capability                           | active / low | grace          | suspended |
 * | ------------------------------------ | ------------ | -------------- | --------- |
 * | AI answering calls and chats         | yes          | no (clinic phone; chat by rules only) | no |
 * | Emergency routing, safety alerts     | yes          | yes            | yes       |
 * | Transactional WhatsApp (reminders…)  | yes          | yes            | queued    |
 * | Campaigns, recalls, AI outbound calls | yes         | paused         | paused    |
 * | Owner notices and top-up links       | yes          | yes            | yes       |
 *
 * Reaching the monthly spending limit pauses the optional spend (campaigns, recalls, AI outbound calls)
 * and nothing else (ASSUMPTIONS A-47).
 */
export type WalletState = "active" | "low" | "grace" | "suspended";

export type Capability =
  | "ai_inbound_call"
  | "ai_chat"
  | "ai_outbound_call"
  | "campaign"
  | "recall"
  | "transactional_message"
  | "promotional_message"
  | "service_message"
  | "critical_message"
  | "emergency"
  | "owner_notice";

/** Never gated by money: safety and telling the owner how to pay. */
const ALWAYS = new Set<Capability>(["emergency", "critical_message", "service_message", "owner_notice"]);

export interface WalletStatus {
  enforced: boolean;
  state: WalletState;
  balancePaise: number;
  thresholdPaise: number;
  gracePaise: number;
  rechargeAmountPaise: number;
  monthlyCapPaise: number | null;
  autoRecharge: boolean;
  spentThisMonthPaise: number;
  capReached: boolean;
  notifiedState: string | null;
}

export function walletAllows(
  s: Pick<WalletStatus, "enforced" | "state" | "capReached">,
  cap: Capability,
): boolean {
  if (ALWAYS.has(cap) || !s.enforced) return true;
  const paid = s.state === "active" || s.state === "low";
  switch (cap) {
    case "ai_inbound_call":
    case "ai_chat":
      return paid;
    case "transactional_message":
      return s.state !== "suspended";
    case "ai_outbound_call":
    case "campaign":
    case "recall":
    case "promotional_message":
      return paid && !s.capReached;
    default:
      return true;
  }
}

/** First instant of the clinic's current calendar month. */
export function monthStart(now: Date, timezone: string): Date {
  return zonedInstant(`${localDateOf(now, timezone).slice(0, 7)}-01`, 0, timezone);
}

export async function walletStatus(client: PoolClient, now: Date = new Date()): Promise<WalletStatus> {
  const w = (
    await client.query(
      `select w.*, c.timezone from wallets w join clinics c on c.id = w.clinic_id where w.clinic_id = app.current_clinic_id()`,
    )
  ).rows[0];
  if (!w) throw new DomainError("not_found", "Wallet not found");
  const spent = Number(
    (
      await client.query(
        "select coalesce(sum(total_paise), 0)::bigint as s from usage_ledger where at >= $1 and at <= $2",
        [monthStart(now, w.timezone), now],
      )
    ).rows[0].s,
  );
  const cap = w.monthly_cap_paise === null ? null : Number(w.monthly_cap_paise);
  return {
    enforced: w.enforced,
    state: w.state,
    balancePaise: Number(w.balance_paise),
    thresholdPaise: Number(w.threshold_paise),
    gracePaise: Number(w.grace_paise),
    rechargeAmountPaise: Number(w.recharge_amount_paise),
    monthlyCapPaise: cap,
    autoRecharge: w.auto_recharge,
    spentThisMonthPaise: spent,
    capReached: cap !== null && spent >= cap,
    notifiedState: w.notified_state,
  };
}

/** Is this allowed right now for the clinic in context? */
export async function canUse(client: PoolClient, cap: Capability, now?: Date): Promise<boolean> {
  if (ALWAYS.has(cap)) return true;
  return walletAllows(await walletStatus(client, now), cap);
}

/** The clinic owner's phone and name, for billing notices. */
export async function ownerContact(client: PoolClient) {
  const r = (
    await client.query(
      `select m.display_name, coalesce(u.phone, m.invited_phone) as phone, coalesce(u.ui_language, 'en') as language, u.email
       from clinic_memberships m left join users u on u.id = m.user_id
       where m.clinic_id = app.current_clinic_id() and m.role = 'owner' and m.active order by m.created_at limit 1`,
    )
  ).rows[0];
  return r
    ? {
        name: r.display_name as string,
        phone: r.phone as string | null,
        email: r.email as string | null,
        language: (r.language === "hi" ? "hi" : "en") as "en" | "hi",
      }
    : null;
}

const PAUSED_WORDS = {
  en: {
    grace: "AI answering of calls and chats, campaigns and recalls",
    suspended: "AI answering of calls and chats, reminders, campaigns and recalls",
  },
  hi: {
    grace: "कॉल और चैट का AI जवाब, कैंपेन और रिकॉल",
    suspended: "कॉल और चैट का AI जवाब, रिमाइंडर, कैंपेन और रिकॉल",
  },
};

/**
 * A top-up by payment link on Sentio's account (the owner pays; the webhook credits the wallet). Reuses an
 * open link for the same amount made in the last three days.
 */
export async function topupLink(
  client: PoolClient,
  deps: { payments: PaymentProvider },
  input: { amountPaise: number; ownerPhone: string; now?: Date },
): Promise<{ rechargeId: string; url: string }> {
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 10_000)
    throw new DomainError("invalid", "The smallest top-up is ₹100");
  const open = (
    await client.query(
      `select id, link_url from recharges where clinic_id = app.current_clinic_id() and via = 'link'
         and status = 'link_sent' and amount_paise = $1
         and created_at > now() - interval '3 days' order by created_at desc limit 1`,
      [input.amountPaise],
    )
  ).rows[0];
  if (open) return { rechargeId: open.id, url: open.link_url };
  const clinicId = (await client.query("select app.current_clinic_id() as id")).rows[0].id as string;
  const id = (await client.query("select gen_random_uuid() as id")).rows[0].id as string;
  const link = await deps.payments.createPaymentLink({
    amountPaise: input.amountPaise,
    description: "Sentio usage wallet top-up",
    customerPhone: input.ownerPhone,
    referenceId: `recharge:${id}`,
    expiresAt: new Date((input.now ?? new Date()).getTime() + 7 * 86_400_000),
  });
  // Written as the database owner: clinics cannot create recharges themselves.
  await client.query("select app.record_topup_link($1, $2, $3, $4, $5)", [
    id,
    clinicId,
    input.amountPaise,
    link.url,
    link.providerLinkId,
  ]);
  return { rechargeId: id, url: link.url };
}

/**
 * Tells the owner when the wallet runs low or pauses (once per change, with a top-up link), and when this
 * month's spending passes 50%, 80% and 100% of the limit (once each). Returns the outbox ids to send.
 */
export async function walletNotices(
  client: PoolClient,
  deps: { payments: PaymentProvider },
  now: Date = new Date(),
): Promise<string[]> {
  const s = await walletStatus(client, now);
  const owner = await ownerContact(client);
  const clinic = (await client.query("select name, timezone from clinics where id = app.current_clinic_id()"))
    .rows[0];
  const out: string[] = [];
  const push = (id: string | null) => id && out.push(id);
  if (!s.enforced || !owner?.phone) return out;

  if (s.state === "active") {
    if (s.notifiedState && s.notifiedState !== "active") await setNotified(client, "active");
  } else if (s.notifiedState !== s.state) {
    const amount = Math.max(
      s.rechargeAmountPaise,
      s.state === "low" ? 0 : -s.balancePaise + s.thresholdPaise,
    );
    const { url } = await topupLink(client, deps, {
      amountPaise: Math.min(amount, 1_500_000),
      ownerPhone: owner.phone,
      now,
    });
    const lang = owner.language;
    push(
      await enqueueMessage(client, {
        to: owner.phone,
        category: "critical",
        purpose: s.state === "low" ? "billing_wallet_low" : "billing_wallet_paused",
        dedupeKey: `wallet:${s.state}:${now.toISOString().slice(0, 13)}`,
        payload:
          s.state === "low"
            ? {
                kind: "template",
                purpose: "billing_wallet_low",
                language: lang,
                params: [owner.name, clinic.name, formatINR(s.balancePaise as Paise), url],
              }
            : {
                kind: "template",
                purpose: "billing_wallet_paused",
                language: lang,
                params: [owner.name, clinic.name, PAUSED_WORDS[lang][s.state], url],
              },
      }),
    );
    await setNotified(client, s.state);
  }

  if (s.monthlyCapPaise) {
    const month = localDateOf(now, clinic.timezone).slice(0, 7);
    for (const pct of [50, 80, 100])
      if (s.spentThisMonthPaise * 100 >= s.monthlyCapPaise * pct)
        push(
          await enqueueMessage(client, {
            to: owner.phone,
            category: "critical",
            purpose: "billing_spend_alert",
            dedupeKey: `spend:${month}:${pct}`,
            payload: {
              kind: "template",
              purpose: "billing_spend_alert",
              language: owner.language,
              params: [
                owner.name,
                clinic.name,
                String(pct),
                formatINR(s.spentThisMonthPaise as Paise),
                formatINR(s.monthlyCapPaise as Paise),
              ],
            },
          }),
        );
  }
  return out;
}

async function setNotified(client: PoolClient, state: string) {
  await client.query("select app.set_wallet_notified($1)", [state]);
}

/** The owner's wallet settings (the balance itself can only change through usage and payments). */
export async function updateWalletSettings(
  client: PoolClient,
  input: {
    thresholdPaise?: number;
    rechargeAmountPaise?: number;
    monthlyCapPaise?: number | null;
    autoRecharge?: boolean;
  },
) {
  if (
    input.rechargeAmountPaise !== undefined &&
    (input.rechargeAmountPaise < 10_000 || input.rechargeAmountPaise > 1_500_000)
  )
    throw new DomainError("invalid", "The automatic recharge must be between ₹100 and ₹15,000");
  if (input.thresholdPaise !== undefined && (input.thresholdPaise < 0 || input.thresholdPaise > 10_000_000))
    throw new DomainError("invalid", "The low-balance level is not valid");
  await client.query(
    `update wallets set threshold_paise = coalesce($1, threshold_paise),
            recharge_amount_paise = coalesce($2, recharge_amount_paise),
            monthly_cap_paise = case when $3::boolean then $4 else monthly_cap_paise end,
            auto_recharge = coalesce($5, auto_recharge)
     where clinic_id = app.current_clinic_id()`,
    [
      input.thresholdPaise ?? null,
      input.rechargeAmountPaise ?? null,
      input.monthlyCapPaise !== undefined,
      input.monthlyCapPaise ?? null,
      input.autoRecharge ?? null,
    ],
  );
}
