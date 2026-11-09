// npm run evals            replay recorded model outputs (no key, no cost); unrecorded calls use the deterministic fallbacks
// npm run evals:live       call the model and record every output, so CI can replay them
// node evals/run.ts --only v03,r05
import { mkdirSync, writeFileSync } from "node:fs";
import type { RunResult } from "../src/agents/concierge.ts";
import { llmFromEnv } from "../src/llm/client.ts";
import type { Check } from "./graders.ts";
import { judgeMessage } from "./judge.ts";
import { runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";

const only = process.argv.includes("--only") ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(",")) : null;
const llm = llmFromEnv();

interface Row { id: string; group: string; checks: Check[]; result: RunResult; emails: number; hours: number; judge: number | null }
const rows: Row[] = [];

for (const s of SCENARIOS) {
  if (only && !only.has(s.id)) continue;
  const r = await runScenario(s, llm);
  const proposalMsg = r.result.messagesToBooker.find((m) => /Reply approve or reject/.test(m));
  const judged = proposalMsg && llm.mode !== "off" ? await judgeMessage(llm, s.text, proposalMsg) : null;
  rows.push({ id: s.id, group: s.group, checks: r.checks, result: r.result, emails: r.emails, hours: r.hours, judge: judged?.score ?? null });
  process.stderr.write(`${r.checks.every((c) => c.pass) ? "✓" : "✗"} ${s.id.padEnd(6)} ${r.result.outcome.padEnd(20)} parse: ${r.result.parseDecidedBy}${judged ? ` · judge ${judged.score}/5` : ""}\n`);
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
  `Offer extraction decided by: ${["model", "rules"].map((k) => `${k} ${rows.flatMap((r) => r.result.trace).filter((e) => e.kind === "offer" && e.text.endsWith(`(${k})`)).length}`).join(", ")}.`,
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
