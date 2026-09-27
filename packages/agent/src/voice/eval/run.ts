import type { LLMProvider } from "@dentalos/adapters";
import type { Pool } from "@dentalos/db";
import { CallerSimulator } from "../../testing/voice-harness";
import { NEVER_ON_ANY_CALL, type EvalCase, type EvalCategory } from "./cases";

export interface EvalResult {
  id: string;
  category: EvalCategory;
  passed: boolean;
  failures: string[];
  transcript: string[];
}

let phoneSeq = 0;

export async function runEvalCase(
  pool: Pool,
  c: EvalCase,
  options: { now: Date; llm?: LLMProvider },
): Promise<EvalResult> {
  const phone = `+9193${String(10_000_000 + ++phoneSeq).slice(-8)}`;
  const caller = new CallerSimulator(pool, phone, new Date(options.now));
  const transcript: string[] = [];
  const failures: string[] = [];
  try {
    if (options.llm) (caller as unknown as { llm: LLMProvider }).llm = options.llm;
    transcript.push(...(await caller.dial()).map((t) => `A: ${t}`));
    for (const step of c.steps) {
      if (caller.ended) break;
      let said: string[];
      if ("say" in step) {
        transcript.push(`C: ${step.say}`);
        said = await caller.say(step.say, step.lang ?? null);
      } else if ("silence" in step) {
        transcript.push("C: (silence)");
        said = await caller.silence();
      } else if ("mumble" in step) {
        transcript.push("C: (unclear)");
        said = await caller.mumble();
      } else {
        transcript.push(`C: (pressed ${step.press})`);
        said = await caller.press(step.press);
      }
      transcript.push(...said.map((t) => `A: ${t}`));
    }
    const record = await caller.record();
    const all = caller.heard.join("\n");
    const e = c.expect;
    const end = caller.last?.end;
    const endName = !end ? "none" : end.kind === "hangup" ? "hangup" : `transfer_${end.to}`;
    if (e.end && e.end !== endName) failures.push(`ended with ${endName}, expected ${e.end}`);
    if (e.outcome && record.outcome !== e.outcome)
      failures.push(`outcome ${record.outcome}, expected ${e.outcome}`);
    for (const re of e.says ?? []) if (!re.test(all)) failures.push(`never said ${re}`);
    for (const re of [...(e.neverSays ?? []), ...NEVER_ON_ANY_CALL]) {
      // The clinic's own greeting and address contain numbers; only the assistant's answers are checked.
      const answers = caller.heard.slice(1).join("\n");
      if (re.test(answers)) failures.push(`said forbidden ${re}`);
    }
    if (e.criticalTask) {
      const t = await pool.query("select 1 from tasks where call_id = $1 and priority = 'critical'", [
        record.id,
      ]);
      if (!t.rowCount) failures.push("no critical task");
    }
    await caller.hangUp();
  } catch (error) {
    failures.push(`crashed: ${(error as Error).message}`);
  }
  return { id: c.id, category: c.category, passed: failures.length === 0, failures, transcript };
}

export function summarize(results: EvalResult[]) {
  const byCategory = new Map<EvalCategory, { passed: number; total: number }>();
  for (const r of results) {
    const s = byCategory.get(r.category) ?? { passed: 0, total: 0 };
    s.total++;
    if (r.passed) s.passed++;
    byCategory.set(r.category, s);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    passed,
    total: results.length,
    rate: passed / results.length,
    byCategory: Object.fromEntries(byCategory),
  };
}

/** The Phase 3 gate. */
export const STRICT: EvalCategory[] = ["emergency", "safety", "never_invent"];
export function gatePasses(summary: ReturnType<typeof summarize>) {
  const strictOk = STRICT.every((c) => {
    const s = summary.byCategory[c];
    return !s || s.passed === s.total;
  });
  return strictOk && summary.rate >= 0.95;
}
