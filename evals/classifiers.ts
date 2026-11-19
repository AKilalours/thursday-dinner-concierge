// Classifier benchmark: precision, recall and a confusion matrix for every label, against emails whose true label is known.
//
//   generated  every email the venue world can write, for every venue and several party sizes and dates. The label is
//              the behavior that wrote it, so it is ground truth, not a guess.
//   dev        hand-labelled replies in phrasing the simulator never uses; used to fix the rules, so optimistic.
//   held-out   hand-labelled replies never used to change a rule. This is the number to trust.
//
// The same report decides whether a model may replace the rules: `promotionGate` lets a classifier go from shadow to
// live only if the model beats the rules on accuracy and never does worse on the labels where a mistake costs money
// or safety. No file system, so tests and CI run the exact same code.
import { buildVenues } from "../data/seed.ts";
import { injection, replyTriage } from "../src/judgments/judgments.ts";
import type { Injection, Triage } from "../src/judgments/judgments.ts";
import type { Mode } from "../src/judgments/classifier.ts";
import type { LLM } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { DEV_SET, HELD_OUT } from "./classifier-set.ts";

export interface LabelStats { precision: number; recall: number; support: number }
export interface Report<L extends string> {
  n: number; accuracy: number;
  /** 95% Wilson interval for accuracy: on 60 emails, one number alone overstates what is known. */
  ci: [number, number];
  labels: Record<L, LabelStats>;
  /** confusion[truth][predicted] = count */
  confusion: Record<L, Record<L, number>>;
  misses: { text: string; truth: L; got: L }[];
  /** Misses where the agent would act on the wrong label, instead of handing the email to a person. */
  wrongAction: number;
}

const KINDS: [Behavior | "auto_reply" | "question", Triage, Injection][] = [
  ["accept", "offer", "clean"], ["decline", "decline", "clean"], ["counter_capacity", "counter", "clean"],
  ["counter_price", "counter", "clean"], ["counter_date", "counter", "clean"], ["auto_reply", "auto_reply", "clean"],
  ["question", "question", "clean"], ["injection", "offer", "injection"],
];

/** Every venue x every kind of email x a few requests: about 1,000 labelled emails. */
export function generatedSet(): [string, Triage, Injection][] {
  const venues = buildVenues(), out: [string, Triage, Injection][] = [];
  const metas = [
    { date: "2026-11-19", time: "7:00 PM", partySize: 6, privateRoom: true },
    { date: "2026-11-20", time: "7:30 PM", partySize: 12, privateRoom: false },
    { date: "2026-12-02", time: "6:30 PM", partySize: 20, privateRoom: true },
    { date: "2026-12-08", time: "8:00 PM", partySize: 4, privateRoom: false },
  ];
  const world = new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z", 7);
  for (const v of venues) for (const m of metas) for (const [k, t, i] of KINDS) out.push([world.sample(v.id, k, m), t, i]);
  return out;
}

function score<L extends string>(labels: readonly L[], rows: { text: string; truth: L; got: L }[], safe: (r: { truth: L; got: L }) => boolean): Report<L> {
  const confusion = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))])) as Record<L, Record<L, number>>;
  for (const r of rows) confusion[r.truth][r.got]++;
  const stats = Object.fromEntries(labels.map((l) => {
    const tp = confusion[l][l];
    const predicted = labels.reduce((a, t) => a + confusion[t][l], 0);
    const support = labels.reduce((a, p) => a + confusion[l][p], 0);
    return [l, { precision: predicted ? tp / predicted : 1, recall: support ? tp / support : 1, support }];
  })) as Record<L, LabelStats>;
  const right = rows.filter((r) => r.truth === r.got).length;
  return { n: rows.length, accuracy: rows.length ? right / rows.length : 1, ci: wilson(right, rows.length), labels: stats, confusion, misses: rows.filter((r) => r.truth !== r.got), wrongAction: rows.filter((r) => r.truth !== r.got && !safe(r)).length };
}

export interface Benchmark { mode: Mode; generated: { triage: Report<Triage>; injection: Report<Injection> }; dev: { triage: Report<Triage>; injection: Report<Injection> }; heldOut: { triage: Report<Triage>; injection: Report<Injection> } }

/** `generatedEvery` samples the generated set (every k-th email) so a paid model run stays small; the gate compares like with like. */
export async function benchmark(llm: LLM, mode: Mode = "rules", opts: { generatedEvery?: number } = {}): Promise<Benchmark> {
  const tri = replyTriage(llm, mode), inj = injection(llm, mode);
  const run = async (set: [string, Triage, Injection][]) => {
    const t: { text: string; truth: Triage; got: Triage }[] = [], j: { text: string; truth: Injection; got: Injection }[] = [];
    for (const [text, truth, bad] of set) {
      t.push({ text, truth, got: (await tri.classify(text)).label });
      j.push({ text, truth: bad, got: (await inj.classify(text)).label });
    }
    // A triage miss that lands on needs_human or question reaches a person; an injection flagged on a clean email only
    // escalates. Every other miss is an action on the wrong reading.
    return {
      triage: score(tri.spec.labels, t, (r) => r.got === "needs_human" || r.got === "question"),
      injection: score(inj.spec.labels, j, (r) => r.got === "injection"),
    };
  };
  const k = opts.generatedEvery ?? 1;
  return { mode, generated: await run(generatedSet().filter((_, i) => i % k === 0)), dev: await run(DEV_SET), heldOut: await run(HELD_OUT) };
}

/**
 * May a model replace the rules? Only if, on both sets, it is at least as accurate overall, catches every injection the
 * rules catch (recall), and never confuses a decline or a payment request for an offer more often than the rules do.
 * Those are the mistakes that book a room nobody offered or send money on a venue's say-so.
 */
export function promotionGate(rules: Benchmark, model: Benchmark): { promote: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const set of ["generated", "dev", "heldOut"] as const) {
    const r = rules[set], m = model[set];
    if (m.triage.accuracy < r.triage.accuracy) reasons.push(`${set}: triage accuracy ${pct(m.triage.accuracy)} < rules ${pct(r.triage.accuracy)}`);
    if (m.injection.labels.injection.recall < r.injection.labels.injection.recall) reasons.push(`${set}: injection recall ${pct(m.injection.labels.injection.recall)} < rules ${pct(r.injection.labels.injection.recall)}`);
    for (const l of ["decline", "payment_request"] as const) {
      if (m.triage.confusion[l].offer > r.triage.confusion[l].offer) reasons.push(`${set}: ${m.triage.confusion[l].offer} ${l} emails read as offers (rules: ${r.triage.confusion[l].offer})`);
    }
  }
  return { promote: reasons.length === 0, reasons };
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
