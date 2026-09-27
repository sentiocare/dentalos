import type { ExtractRequest, LLMProvider, LLMRequest } from "@dentalos/adapters";
import type { PoolClient } from "pg";

/**
 * Real-time metering (PLAN §4.7, §5.6). Every chargeable event writes one row to the append-only usage
 * ledger, priced from the rate card in force at that moment. The row is unique per (kind, reference), so
 * metering the same call or message twice charges once. The wallet balance follows by trigger.
 */
export type UsageKind =
  | "telephony_min"
  | "stt_sec"
  | "tts_char"
  | "llm_input_token"
  | "llm_output_token"
  | "wa_utility"
  | "wa_marketing"
  | "wa_authentication"
  | "sms_segment";

export interface Rate {
  providerCostPaise: number;
  marginPct: number;
  marginPaise: number;
}

/** The clinic's own rate if Sentio set one, else the default; the latest in force at `at`. */
export async function rateFor(client: PoolClient, kind: UsageKind, at: Date): Promise<Rate | null> {
  const r = (
    await client.query(
      `select provider_cost_paise, margin_pct, margin_paise from rate_cards
       where kind = $1 and effective_from <= $2 and (clinic_id is null or clinic_id = app.current_clinic_id())
       order by (clinic_id is not null) desc, effective_from desc limit 1`,
      [kind, at],
    )
  ).rows[0];
  return r
    ? {
        providerCostPaise: Number(r.provider_cost_paise),
        marginPct: Number(r.margin_pct),
        marginPaise: Number(r.margin_paise),
      }
    : null;
}

/** Price of a quantity: provider cost (exact), our margin, and the wallet charge rounded to the paisa. */
export function price(rate: Rate, quantity: number) {
  const cost = quantity * rate.providerCostPaise;
  const margin = (cost * rate.marginPct) / 100 + quantity * rate.marginPaise;
  return {
    providerCostPaise: Math.round(cost * 10_000) / 10_000,
    marginPaise: Math.round(margin * 10_000) / 10_000,
    totalPaise: Math.max(0, Math.round(cost + margin)),
  };
}

export interface UsageEvent {
  kind: UsageKind;
  quantity: number;
  refType: "call" | "message" | "outbox" | "sms";
  ref: string;
  at?: Date;
}

/** Writes one usage row (once). Returns the wallet charge in paise, or null if already metered or zero. */
export async function meter(client: PoolClient, e: UsageEvent): Promise<number | null> {
  if (!(e.quantity > 0)) return null;
  const at = e.at ?? new Date();
  const rate = await rateFor(client, e.kind, at);
  if (!rate) return null;
  const p = price(rate, e.quantity);
  const { rows } = await client.query(
    `insert into usage_ledger (clinic_id, kind, quantity, provider_cost_paise, margin_paise, total_paise, ref_type, ref, at)
     values (app.current_clinic_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (clinic_id, kind, ref) do nothing returning total_paise`,
    [e.kind, e.quantity, p.providerCostPaise, p.marginPaise, p.totalPaise, e.refType, e.ref, at],
  );
  return rows[0] ? Number(rows[0].total_paise) : null;
}

/**
 * A finished phone call: telephone minutes (billed per started minute, as Exotel bills), and for calls the
 * assistant handled, speech-to-text seconds, text-to-speech characters and model tokens.
 */
export async function meterCall(client: PoolClient, callId: string, at?: Date): Promise<number> {
  const c = (await client.query("select duration_sec, usage, ended_at from calls where id = $1", [callId]))
    .rows[0];
  if (!c) return 0;
  const u = (c.usage ?? {}) as Record<string, number>;
  const when = at ?? c.ended_at ?? new Date();
  let total = 0;
  const add = async (kind: UsageKind, quantity: number) => {
    total += (await meter(client, { kind, quantity, refType: "call", ref: callId, at: when })) ?? 0;
  };
  if (c.duration_sec) await add("telephony_min", Math.ceil(c.duration_sec / 60));
  await add("stt_sec", Math.round((u.stt_ms ?? 0) / 100) / 10);
  await add("tts_char", u.tts_chars ?? 0);
  await add("llm_input_token", u.llm_input_tokens ?? 0);
  await add("llm_output_token", u.llm_output_tokens ?? 0);
  // The call's cost on the dashboard: everything metered for it so far (the two halves arrive separately).
  await client.query(
    `update calls set cost_estimate_paise = (select coalesce(sum(total_paise), 0) from usage_ledger
       where ref_type = 'call' and ref = $2) where id = $1`,
    [callId, callId],
  );
  return total;
}

/** Counts the model tokens used through this provider, for metering. */
export function countingLLM(llm: LLMProvider): {
  llm: LLMProvider;
  usage: { input: number; output: number };
} {
  const usage = { input: 0, output: 0 };
  return {
    usage,
    llm: {
      name: llm.name,
      healthCheck: () => llm.healthCheck(),
      async complete(request: LLMRequest) {
        const res = await llm.complete(request);
        usage.input += res.usage.inputTokens;
        usage.output += res.usage.outputTokens;
        return res;
      },
      async extract<T>(request: ExtractRequest<T>) {
        const res = await llm.extract(request);
        usage.input += res.usage.inputTokens;
        usage.output += res.usage.outputTokens;
        return res;
      },
    },
  };
}

/** Usage for the clinic's screen: this month by kind, and the most recent rows. */
export async function usageSummary(client: PoolClient, input: { from: Date; to: Date }) {
  const byKind = (
    await client.query(
      `select kind, sum(quantity)::float8 as quantity, sum(total_paise)::bigint as total, count(*)::int as events
       from usage_ledger where at >= $1 and at < $2 group by kind order by kind`,
      [input.from, input.to],
    )
  ).rows.map((r) => ({
    kind: r.kind as UsageKind,
    quantity: r.quantity,
    totalPaise: Number(r.total),
    events: r.events,
  }));
  return { byKind, totalPaise: byKind.reduce((s, k) => s + k.totalPaise, 0) };
}
