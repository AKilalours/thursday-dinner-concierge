// Ranking eval: does what the agent learned from past venue conversations make the next shortlist better?
//
// Each venue gets a stable, hidden temperament (some confirm, some decline, some never answer, some quote a room
// that really seats fewer, some try a prompt injection). The agent never sees it. It only sees the emails.
//
//   1. History: the concierge books N past requests end to end. Every reply leaves facts in memory.
//   2. Held out: M new requests. Sourcing ranks venues twice, once with an empty memory (cold) and once with the
//      memory from step 1 (warm). Same code, same request, same venues; only memory differs.
//   3. Graded against the hidden temperament: hit@1, hit@3 (a venue that would really confirm is in the shortlist
//      the agent emails) and MRR of the first such venue.
//
// No file system, so the same code runs in CI, in tests and in the browser.
import { buildVenues, COMPANY, rng, user } from "../data/seed.ts";
import type { BookingRequest, Venue } from "../src/domain/types.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { source } from "../src/agents/sourcing.ts";
import type { Candidate } from "../src/agents/sourcing.ts";
import type { LLM } from "../src/llm/client.ts";
import { parseRequest } from "../src/parse/request.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Ctx } from "../src/tools/registry.ts";

const CONFIRMS: Behavior[] = ["accept", "accept_slow", "auto_reply_then_accept", "question_then_accept"];
// About a third of venues confirm a given inquiry, the rest decline, go silent, counter or try an injection.
const TEMPERAMENTS: Behavior[] = [...CONFIRMS, "decline", "decline", "no_reply", "no_reply", "counter_capacity", "counter_capacity", "counter_price", "injection"];

const SIZES = [4, 6, 8, 10, 12, 14];
const WHEN = ["next Thursday", "on Nov 18", "this Friday", "on Dec 2", "next Tuesday at 8pm", "on Nov 24 at 6:30pm", "on Dec 9", "on Dec 15"];
const STYLE = [
  "dinner for {n} with the Acme team {w}, somewhere private", "team dinner for {n} {w}", "client lunch for {n} with Globex {w}",
  "private dinner for {n} with Initech {w}", "dinner for {n} {w}, under $150 a head", "dinner for {n} {w} near the office",
];

export interface RankStats { hit1: number; hit3: number; mrr: number }
export interface RankingReport {
  history: number; heldOut: number; facts: number;
  cold: RankStats; warm: RankStats;
  /** Held-out requests where memory moved a venue that confirms into the shortlist (or out of it). */
  helped: number; hurt: number;
  examples: { text: string; cold: string[]; warm: string[] }[];
}

function requestText(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  return pick(STYLE).replace("{n}", String(pick(SIZES))).replace("{w}", pick(WHEN));
}

/** The hidden truth the grader uses. Stable per venue, so learning it is possible. */
export function temperaments(venues: Venue[], seed = 2027): Map<string, Behavior> {
  const r = rng(seed);
  return new Map(venues.map((v) => [v.id, TEMPERAMENTS[Math.floor(r() * TEMPERAMENTS.length)]]));
}

function stats(ranks: (number | null)[]): RankStats {
  const n = ranks.length || 1;
  return {
    hit1: ranks.filter((k) => k === 1).length / n,
    hit3: ranks.filter((k) => k !== null && k <= 3).length / n,
    mrr: ranks.reduce<number>((a, k) => a + (k ? 1 / k : 0), 0) / n,
  };
}

export async function runRanking(llm: LLM, opts: { history?: number; heldOut?: number; seed?: number; legacy?: Ctx["legacy"] } = {}): Promise<RankingReport> {
  const history = opts.history ?? 40, heldOut = opts.heldOut ?? 60, seed = opts.seed ?? 2027;
  const venues = buildVenues();
  const truth = temperaments(venues, seed);
  const actor = user("usr_priya"), principal = user("usr_dana");
  const today = "2026-11-09";
  const world = new VenueWorld(venues, (id) => truth.get(id)!, `${today}T15:00:00.000Z`, seed);

  // 1. History: real end-to-end runs. Memory fills only from what venues actually wrote back.
  const warmStore = new MemoryStore();
  await warmStore.init(venues);
  for (let i = 0; i < history; i++) {
    const text = requestText(seed * 31 + i);
    await runConcierge({
      text, actor, principal, today, store: warmStore, world, llm, venues, company: COMPANY, legacy: opts.legacy,
      approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
    });
  }
  const facts = (await Promise.all(venues.map((v) => warmStore.facts(v.id)))).reduce((a, f) => a + f.length, 0);

  const coldStore = new MemoryStore();
  await coldStore.init(venues);
  const ctxFor = (store: MemoryStore, legacy?: Ctx["legacy"]): Ctx => ({
    store, world, llm, company: COMPANY, venues, actor, principal, runId: "rank", today, smsOptedOut: new Set(), trace: [], legacy,
  });

  // 2-3. Held-out requests, ranked cold and warm, graded against the hidden temperament.
  const coldRanks: (number | null)[] = [], warmRanks: (number | null)[] = [];
  const examples: RankingReport["examples"] = [];
  const in3 = (k: number | null) => k !== null && k <= 3;
  const firstConfirm = (list: Candidate[]) => { const k = list.findIndex((c) => CONFIRMS.includes(truth.get(c.venue.id)!)); return k < 0 ? null : k + 1; };
  let helped = 0, hurt = 0;
  for (let i = 0; coldRanks.length < heldOut && i < heldOut * 4; i++) {
    const text = requestText(seed * 977 + 100_000 + i);
    const req: BookingRequest = (await parseRequest(llm, text, today)).request;
    if (!req.date || !req.partySizeStated) continue;
    const cold = await source(ctxFor(coldStore), req, new Set());
    const warm = await source(ctxFor(warmStore, opts.legacy), req, new Set());
    if (!cold.length) continue;
    const c = firstConfirm(cold), w = firstConfirm(warm);
    coldRanks.push(c); warmRanks.push(w);
    if (!in3(c) && in3(w)) helped++;
    if (in3(c) && !in3(w)) hurt++;
    if (examples.length < 3 && !in3(c) && in3(w)) examples.push({ text, cold: cold.slice(0, 3).map((x) => x.venue.name), warm: warm.slice(0, 3).map((x) => x.venue.name) });
  }
  return { history, heldOut: coldRanks.length, facts, cold: stats(coldRanks), warm: stats(warmRanks), helped, hurt, examples };
}

/** Ten fixed worlds (seeds 1-10, not picked), 40 past requests and 60 held-out requests each. */
export const RANK_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export async function runRankingSuite(llm: LLM, opts: { seeds?: number[]; legacy?: Ctx["legacy"]; onWorld?: (i: number, r: RankingReport) => void } = {}): Promise<RankingReport & { worlds: number }> {
  const all: RankingReport[] = [];
  for (const [i, seed] of (opts.seeds ?? RANK_SEEDS).entries()) { const r = await runRanking(llm, { seed, legacy: opts.legacy }); all.push(r); opts.onWorld?.(i, r); }
  const n = all.reduce((a, r) => a + r.heldOut, 0) || 1;
  const avg = (k: "cold" | "warm"): RankStats => ({
    hit1: all.reduce((a, r) => a + r[k].hit1 * r.heldOut, 0) / n,
    hit3: all.reduce((a, r) => a + r[k].hit3 * r.heldOut, 0) / n,
    mrr: all.reduce((a, r) => a + r[k].mrr * r.heldOut, 0) / n,
  });
  return {
    worlds: all.length, history: all.reduce((a, r) => a + r.history, 0), heldOut: n, facts: all.reduce((a, r) => a + r.facts, 0),
    cold: avg("cold"), warm: avg("warm"), helped: all.reduce((a, r) => a + r.helped, 0), hurt: all.reduce((a, r) => a + r.hurt, 0),
    examples: all.flatMap((r) => r.examples).slice(0, 3),
  };
}
