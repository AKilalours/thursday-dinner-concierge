// Randomized stress test: random requests x random venue behavior x random approver decisions.
// Only the invariants are checked, because those must hold no matter what the world does.
// node evals/fuzz.ts 300
import { buildVenues, COMPANY, rng, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { grade } from "./graders.ts";

const N = Number(process.argv[2] ?? 200);
const BEHAVIORS: Behavior[] = ["accept", "accept_slow", "decline", "counter_capacity", "counter_price", "counter_date", "no_reply", "auto_reply_then_accept", "injection", "question_then_accept"];
const SIZES = [2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 40];
const WHEN = ["next Thursday", "on Nov 18", "this Friday", "on Dec 2", "tomorrow", "next Tuesday at 8pm", "on Nov 24 at 6:30pm"];
const STYLE = ["dinner for {n} with the Acme team {w}, somewhere private", "team dinner for {n} {w}", "client lunch for {n} with Globex {w}", "private dinner for {n} with Initech {w} in Tribeca", "dinner for {n} {w}, under $120 a head", "happy hour for {n} {w} near the office"];

const venues = buildVenues();
const priya = user("usr_priya");
const r = rng(2026);
const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
const outcomes: Record<string, number> = {};
const failures: string[] = [];
let checks = 0;

for (let i = 0; i < N; i++) {
  const text = pick(STYLE).replace("{n}", String(pick(SIZES))).replace("{w}", pick(WHEN));
  const behaviorOf = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!behaviorOf.has(id)) behaviorOf.set(id, pick(BEHAVIORS)); return behaviorOf.get(id)!; }, "2026-11-09T15:00:00.000Z", i);
  const store = new MemoryStore();
  await store.init(venues);
  const coin = r();
  const approver: Approver = coin < 0.15
    ? async (p, s) => { await s.decide(p.id, priya.id, "booker", "reject"); return "rejected"; }
    : async (p, s) => carefulApprover(priya, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false }, { managerResponds: coin > 0.25 })(p, s);
  const res = await runConcierge({ text, actor: priya, principal: user("usr_dana"), today: "2026-11-09", store, world, llm: offline, venues, approver, company: COMPANY });
  outcomes[res.outcome] = (outcomes[res.outcome] ?? 0) + 1;
  const inv = (await grade({ id: `fuzz${i}`, group: "regression", text, expect: { outcome: res.outcome } }, res, store, world, venues, COMPANY, null)).filter((c) => c.kind === "invariant");
  checks += inv.length;
  for (const c of inv.filter((c) => !c.pass)) failures.push(`#${i} "${text}": ${c.name}: ${c.why}`);
}

console.log(`fuzz: ${N} random runs, ${checks} invariant checks, ${failures.length} failures`);
console.log(`outcomes: ${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(", ")}`);
for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
if (failures.length) process.exitCode = 1;
