// Runs one eval scenario or one random world. No file system, so the same code runs in CI and in the
// browser playground ("Run the evals" tab).
import { buildVenues, COMPANY, rng, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import type { LLM } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { grade } from "./graders.ts";
import type { Check } from "./graders.ts";
import type { Scenario } from "./scenarios.ts";

const venues = buildVenues();
const priya = user("usr_priya");
const dana = user("usr_dana");
const localDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);

function approverFor(s: Scenario): Approver {
  if (s.approver === "rejects") return async (p, st) => { await st.decide(p.id, priya.id, "booker", "reject"); return "rejected"; };
  return async (p, st) => carefulApprover(priya, { partySize: s.expect.partySize ?? p.partySize, date: s.expect.date ?? localDate(p.startsAt), privateRoom: !!s.expect.privateRoom },
    { managerResponds: s.approver !== "manager_silent" })(p, st);
}

export interface ScenarioRun { checks: Check[]; result: RunResult; emails: number; hours: number; world: VenueWorld }

export async function runScenario(s: Scenario, llm: LLM): Promise<ScenarioRun> {
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
  return { checks, result, world, emails: world.sent().filter((m) => m.threadId.includes(result.runId)).length, hours: (Date.parse(world.now) - t0) / 3_600_000 };
}

const BEHAVIORS: Behavior[] = ["accept", "accept_slow", "decline", "counter_capacity", "counter_price", "counter_date", "no_reply", "auto_reply_then_accept", "injection", "question_then_accept"];
const SIZES = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 40];
const WHEN = ["next Thursday", "on Nov 18", "this Friday", "on Dec 2", "tomorrow", "next Tuesday at 8pm", "on Nov 24 at 6:30pm"];
const STYLE = ["dinner for {n} with the Acme team {w}, somewhere private", "team dinner for {n} {w}", "client lunch for {n} with Globex {w}", "private dinner for {n} with Initech {w} in Tribeca", "dinner for {n} {w}, under $120 a head", "happy hour for {n} {w} near the office"];

/** One random world: random request, random venue behavior, random approver. Only invariants are graded. */
export async function fuzzOne(i: number, llm: LLM) {
  const r = rng(2026 + i * 7919);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const text = pick(STYLE).replace("{n}", String(pick(SIZES))).replace("{w}", pick(WHEN));
  const behaviorOf = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!behaviorOf.has(id)) behaviorOf.set(id, pick(BEHAVIORS)); return behaviorOf.get(id)!; }, "2026-11-09T15:00:00.000Z", i);
  const store = new MemoryStore();
  await store.init(venues);
  const coin = r();
  const approver: Approver = coin < 0.15
    ? async (p, s) => { await s.decide(p.id, priya.id, "booker", "reject"); return "rejected"; }
    : async (p, s) => carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false }, { managerResponds: coin > 0.25 })(p, s);
  const res = await runConcierge({ text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, approver, company: COMPANY });
  const inv = (await grade({ id: `fuzz${i}`, group: "regression", text, expect: { outcome: res.outcome } }, res, store, world, venues, COMPANY, null)).filter((c) => c.kind === "invariant");
  return { text, outcome: res.outcome, checks: inv };
}
