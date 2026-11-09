// npm run evals            replay recorded model outputs (no key, no cost); unrecorded calls use the deterministic fallbacks
// npm run evals:live       call the model and record every output, so CI can replay them
// node evals/run.ts --only v03,r05
import { mkdirSync, writeFileSync } from "node:fs";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import { llmFromEnv } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { grade } from "./graders.ts";
import type { Check } from "./graders.ts";
import { judgeMessage } from "./judge.ts";
import { SCENARIOS } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";

const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(",")) : null;
const llm = llmFromEnv();
const venues = buildVenues();
const priya = user("usr_priya");
const dana = user("usr_dana");
const localDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);

function approverFor(s: Scenario): Approver {
  if (s.approver === "rejects") return async (p, st) => { await st.decide(p.id, priya.id, "booker", "reject"); return "rejected"; };
  return async (p, st) => carefulApprover(priya, { partySize: s.expect.partySize ?? p.partySize, date: s.expect.date ?? localDate(p.startsAt), privateRoom: !!s.expect.privateRoom },
    { managerResponds: s.approver !== "manager_silent" })(p, st);
}

interface Row { id: string; group: string; checks: Check[]; result: RunResult; emails: number; hours: number; judge: number | null }
const rows: Row[] = [];

for (const s of SCENARIOS) {
  if (only && !only.has(s.id)) continue;
  const today = s.today ?? "2026-11-09";
  // Behaviors are assigned by contact order, so a scenario can say "the first two venues never reply".
  const assigned = new Map<string, Behavior>();
  let order: Behavior[] = s.warmup?.order ?? [];
  const world = new VenueWorld(venues, (id) => {
    if (!assigned.has(id)) assigned.set(id, order[assigned.size] ?? "accept");
    return assigned.get(id)!;
  }, `${today}T15:00:00.000Z`, 11);
  const store = new MemoryStore();
  await store.init(venues);
  const base = { actor: priya, principal: dana, today, store, world, llm, venues, company: COMPANY };
  let warmupRunId: string | null = null;
  if (s.warmup) {
    const w = await runConcierge({ ...base, text: s.warmup.text, approver: approverFor({ ...s, expect: { outcome: "booked" } }) });
    warmupRunId = w.runId;
    order = [...Array(assigned.size).fill("accept"), ...(s.order ?? [])];
  } else order = s.order ?? [];
  const t0 = Date.parse(world.now);
  const result = await runConcierge({ ...base, text: s.text, approver: approverFor(s), smsOptedOut: s.smsOptedOut ? new Set([priya.id]) : new Set() });
  const checks = await grade(s, result, store, world, venues, COMPANY, warmupRunId);
  const proposalMsg = result.messagesToBooker.find((m) => /Reply approve or reject/.test(m));
  const judged = proposalMsg && llm.mode !== "off" ? await judgeMessage(llm, s.text, proposalMsg) : null;
  rows.push({ id: s.id, group: s.group, checks, result, emails: world.sent().filter((m) => m.threadId.includes(result.runId)).length, hours: (Date.parse(world.now) - t0) / 3_600_000, judge: judged?.score ?? null });
}

const inv = rows.flatMap((r) => r.checks.filter((c) => c.kind === "invariant"));
const exp = rows.flatMap((r) => r.checks.filter((c) => c.kind === "expectation"));
const passed = rows.filter((r) => r.checks.every((c) => c.pass));
const booked = rows.filter((r) => r.result.outcome === "booked");
const groups = [...new Set(rows.map((r) => r.group))];
const median = (xs: number[]) => xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
const judged = rows.filter((r) => r.judge !== null);

const lines = [
  `# Eval report`,
  ``,
  `Model mode: **${llm.mode}**. Scenarios: **${rows.length}**. Fully passing: **${passed.length}/${rows.length}**.`,
  `Invariant checks: **${inv.filter((c) => c.pass).length}/${inv.length}** (must be 100%). Expectation checks: **${exp.filter((c) => c.pass).length}/${exp.length}**.`,
  `Bookings: ${booked.length}; median emails per booking ${median(booked.map((r) => r.emails))}; median simulated hours to booking ${median(booked.map((r) => r.hours)).toFixed(0)}.`,
  `Request parsing decided by: ${["model", "rules"].map((k) => `${k} ${rows.filter((r) => r.result.parseDecidedBy === k).length}`).join(", ")}.`,
  judged.length ? `LLM judge (booker-message quality, 1-5): mean ${(judged.reduce((a, r) => a + r.judge!, 0) / judged.length).toFixed(2)} over ${judged.length} messages.` : `LLM judge: skipped (no model outputs available in this mode).`,
  ``,
  `| Group | Scenarios | Passing |`,
  `|---|---|---|`,
  ...groups.map((g) => `| ${g} | ${rows.filter((r) => r.group === g).length} | ${rows.filter((r) => r.group === g && r.checks.every((c) => c.pass)).length} |`),
  ``,
  `| Scenario | Outcome | Emails | Failed checks |`,
  `|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.result.outcome} | ${r.emails} | ${r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.why}`).join("; ") || "none"} |`),
];
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/latest.md", import.meta.url), lines.join("\n") + "\n");
writeFileSync(new URL("./results/latest.json", import.meta.url), JSON.stringify(rows.map((r) => ({ id: r.id, group: r.group, outcome: r.result.outcome, emails: r.emails, hours: r.hours, judge: r.judge, checks: r.checks, messages: r.result.messagesToBooker })), null, 1));
console.log(lines.slice(0, 7).join("\n"));
for (const r of rows.filter((x) => !x.checks.every((c) => c.pass))) console.log(`  FAIL ${r.id}: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.why})`).join("; ")}`);
if (inv.some((c) => !c.pass)) process.exitCode = 1;
