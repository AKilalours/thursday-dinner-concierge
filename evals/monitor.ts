// npm run monitor
// Agent Watch: what a production agent team runs on a schedule, not just on a pull request.
//
// Every run (3x a day in CI):
//   1. Live model check: a rotating slice of the eval scenarios runs against the live model, so the whole suite is
//      covered every few runs. Model drift shows up as a failed check or a fallback to rules, never silently.
//   2. Never-seen worlds: 500 random worlds seeded from the clock. No run repeats an earlier run's worlds, so every run
//      is new adversarial coverage (silent venues, price hikes, injections, double bookings).
//   3. Real-user sentences: the 25 requests typed the way people type.
// Each run appends one row to docs/monitor.json (charted on the site's Monitor page) and writes a full report to
// evals/history/. Any failure exits non-zero and writes evals/history/FAILURE.md, which CI turns into a GitHub issue.
//
// Without ANTHROPIC_API_KEY the model check replays recordings (no cost); with it, calls are capped per run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Completion, LLM } from "../src/llm/client.ts";
import { llmFromEnv } from "../src/llm/client.ts";
import { offline } from "../src/llm/client.ts";
import { fuzzOne, runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";
import { REAL_USER_REQUESTS, runUserRequest } from "./user-requests.ts";

const SLICE = Number(process.env.MONITOR_SCENARIOS ?? 12);
const WORLDS = Number(process.env.MONITOR_WORLDS ?? 500);
const MAX_CALLS = Number(process.env.MONITOR_MAX_CALLS ?? 120);
const ROOT = new URL("../", import.meta.url);
const HISTORY = new URL("evals/history/", ROOT);
const SERIES = new URL("docs/monitor.json", ROOT);

/** Counts every model call, its latency and tokens, and stops calling after a budget so a run can't run up a bill. */
class Metered implements LLM {
  calls = 0; failed = 0; tin = 0; tout = 0; ms: number[] = [];
  private inner: LLM;
  constructor(inner: LLM) { this.inner = inner; }
  get mode() { return this.inner.mode; }
  async complete(task: string, system: string, user: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<Completion> {
    if (this.calls >= MAX_CALLS) throw new Error("monitor call budget reached");
    this.calls++; const t0 = Date.now();
    try { const c = await this.inner.complete(task, system, user, opts); this.ms.push(Date.now() - t0); this.tin += c.inputTokens; this.tout += c.outputTokens; return c; }
    catch (e) { this.failed++; throw e; }
  }
}

interface Row {
  at: string; mode: string; model: string;
  scenarios: { ran: number; passed: number; ids: string[] };
  modelDecisions: { parse: number; offers: number; fellBack: number };
  worlds: { ran: number; checks: number; failed: number; firstSeed: number };
  users: { ran: number; asExpected: number };
  calls: number; p50ms: number; p95ms: number; tokens: number; costUsd: number;
  ok: boolean;
}

const series: Row[] = existsSync(SERIES) ? JSON.parse(readFileSync(SERIES, "utf8")) : [];
const at = new Date().toISOString();
const llm = new Metered(llmFromEnv());
const failures: string[] = [];

// 1. A rotating slice of the scenarios, so consecutive runs cover the whole suite.
const start = (series.length * SLICE) % SCENARIOS.length;
const slice = Array.from({ length: Math.min(SLICE, SCENARIOS.length) }, (_, i) => SCENARIOS[(start + i) % SCENARIOS.length]);
let passed = 0, parse = 0, offers = 0, fellBack = 0;
for (const s of slice) {
  const r = await runScenario(s, llm);
  const bad = r.checks.filter((c) => !c.pass);
  if (!bad.length) passed++; else failures.push(`scenario ${s.id} "${s.text}": ${bad.map((c) => `${c.name} (${c.why})`).join("; ")}`);
  if (r.result.parseDecidedBy === "model") parse++; else fellBack++;
  for (const e of r.result.trace.filter((e) => e.kind === "offer")) { if (e.text.endsWith("(model)")) offers++; else fellBack++; }
}

// 2. Worlds no earlier run has seen: seeds come from the clock (a fresh block of 1,000 seeds every minute).
const firstSeed = Math.floor(Date.parse(at) / 60_000) * 1000;
let checks = 0, worldFails = 0;
for (let i = 0; i < WORLDS; i++) {
  const f = await fuzzOne(firstSeed + i, offline);
  checks += f.checks.length;
  for (const c of f.checks.filter((c) => !c.pass)) { worldFails++; failures.push(`world seed ${firstSeed + i} "${f.text}": ${c.name}: ${c.why}`); }
}

// 3. The 25 real-user sentences.
let asExpected = 0;
for (const [text, want] of REAL_USER_REQUESTS) {
  const r = await runUserRequest(text);
  if (r.outcome === want) asExpected++; else failures.push(`real-user "${text}": ${r.outcome}, expected ${want}`);
}

const ms = [...llm.ms].sort((a, b) => a - b), q = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0);
const live = llm.mode === "live" || llm.mode === "record";
const row: Row = {
  at, mode: llm.mode, model: process.env.ANDE_MODEL ?? "claude-sonnet-4-5",
  scenarios: { ran: slice.length, passed, ids: slice.map((s) => s.id) },
  modelDecisions: { parse, offers, fellBack },
  worlds: { ran: WORLDS, checks, failed: worldFails, firstSeed },
  users: { ran: REAL_USER_REQUESTS.length, asExpected },
  calls: llm.calls, p50ms: live ? q(0.5) : 0, p95ms: live ? q(0.95) : 0, tokens: llm.tin + llm.tout,
  costUsd: live ? Math.round((llm.tin * 3e-6 + llm.tout * 15e-6) * 1000) / 1000 : 0,
  ok: failures.length === 0,
};

series.push(row);
mkdirSync(HISTORY, { recursive: true });
writeFileSync(SERIES, JSON.stringify(series.slice(-180)) + "\n");
const stamp = at.slice(0, 13).replace("T", "_");
writeFileSync(new URL(`${stamp}.json`, HISTORY), JSON.stringify({ ...row, failures }, null, 1) + "\n");
if (failures.length) {
  writeFileSync(new URL("FAILURE.md", HISTORY), [
    `Agent Watch found ${failures.length} failure(s) at ${at} (${row.mode}, ${row.model}).`, "",
    ...failures.slice(0, 30).map((f) => `- ${f}`), "",
    "Reproduce: `npm run monitor` locally; world seeds above replay exactly with `fuzzOne(seed)`.",
  ].join("\n") + "\n");
}

const totalWorlds = series.reduce((a, r) => a + r.worlds.ran, 0);
console.log(`Agent Watch ${at} · ${row.mode}`);
console.log(`  scenarios ${passed}/${slice.length} (${slice[0].id}..${slice.at(-1)!.id}) · model decided ${parse} parses, ${offers} offers, fell back ${fellBack}`);
console.log(`  never-seen worlds ${WORLDS} · ${checks} safety checks · ${worldFails} failed · ${totalWorlds.toLocaleString()} worlds since the first run`);
console.log(`  real-user sentences ${asExpected}/${REAL_USER_REQUESTS.length} · ${llm.calls} model calls · p50 ${row.p50ms} ms · $${row.costUsd}`);
if (failures.length) { console.log(`  FAILURES:\n${failures.slice(0, 10).map((f) => `   - ${f}`).join("\n")}`); process.exitCode = 1; }
