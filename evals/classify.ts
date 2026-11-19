// npm run evals:classifiers
// Precision, recall and confusion for reply triage and injection detection, on ~1,000 emails with known labels.
// Writes docs/classifiers.json for the site. Fails if the rules regress on the generated or dev sets; the held-out set
// is reported, never gated, so nobody is tempted to tune on it. With a key (ANDE_LLM_MODE=live) the model runs too and
// the promotion gate says whether it may replace the rules.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { llmFromEnv, offline } from "../src/llm/client.ts";
import { benchmark, pct, promotionGate } from "./classifiers.ts";
import type { Benchmark } from "./classifiers.ts";

const OUT = new URL("../docs/classifiers.json", import.meta.url);
// A run without a key keeps the last model result instead of erasing it.
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const rules = await benchmark(offline, "rules");
const SETS = { generated: "generated (simulator, ground truth)", dev: "dev (hand-labelled, used to fix rules)", heldOut: "held-out (hand-labelled, never tuned on)" } as const;

function print(b: Benchmark) {
  for (const [k, name] of Object.entries(SETS) as [keyof typeof SETS, string][]) {
    const t = b[k].triage, i = b[k].injection;
    console.log(`\n${name}: ${t.n} emails`);
    console.log(`  reply triage  accuracy ${pct(t.accuracy).padStart(6)} (95% CI ${pct(t.ci[0])}-${pct(t.ci[1])}) · acted on a wrong label ${t.wrongAction}, the rest of the misses went to a person`);
    for (const [l, s] of Object.entries(t.labels)) if (s.support) console.log(`    ${l.padEnd(16)} precision ${pct(s.precision).padStart(6)}  recall ${pct(s.recall).padStart(6)}  n=${s.support}`);
    console.log(`  injection     recall ${pct(i.labels.injection.recall).padStart(6)} · precision ${pct(i.labels.injection.precision)} · missed ${i.wrongAction} of ${i.labels.injection.support}`);
  }
}
console.log("classifier benchmark · rules");
print(rules);

const failures: string[] = [];
if (rules.generated.triage.accuracy < 0.99) failures.push(`generated triage accuracy ${pct(rules.generated.triage.accuracy)} < 99%`);
for (const k of ["generated", "dev"] as const) {
  if (rules[k].injection.labels.injection.recall < 1) failures.push(`${k}: an injection was missed`);
  if (rules[k].triage.wrongAction > 0) failures.push(`${k}: ${rules[k].triage.wrongAction} emails acted on with the wrong label`);
}
if (rules.dev.triage.accuracy < 0.95) failures.push(`dev triage accuracy ${pct(rules.dev.triage.accuracy)} < 95%`);

const llm = llmFromEnv();
let gate: ReturnType<typeof promotionGate> | null = null;
let model: Benchmark | null = null;
if (llm.mode === "live" || llm.mode === "record") {
  // Every 8th generated email (120) plus every hand-labelled one: about 440 model calls, a dollar or two.
  const every = Number(process.env.CLASSIFY_GENERATED_EVERY ?? 8);
  model = await benchmark(llm, "live", { generatedEvery: every });
  console.log(`\n--- model (${process.env.ANDE_MODEL ?? "claude-sonnet-4-5"}, generated set sampled every ${every}) ---`); print(model);
  gate = promotionGate(await benchmark(offline, "rules", { generatedEvery: every }), model);
  console.log(`\npromotion gate: ${gate.promote ? "PROMOTE (model may go live)" : "stay in shadow"}${gate.reasons.map((r) => `\n  - ${r}`).join("")}`);
} else console.log("\nmodel: no key, skipped (set ANDE_LLM_MODE=live to run the promotion gate)");

const slim = (x: Benchmark) => Object.fromEntries((Object.keys(SETS) as (keyof typeof SETS)[]).map((k) => [k, {
  triage: { n: x[k].triage.n, accuracy: x[k].triage.accuracy, ci: x[k].triage.ci, wrongAction: x[k].triage.wrongAction, labels: x[k].triage.labels, confusion: x[k].triage.confusion },
  injection: { n: x[k].injection.n, labels: x[k].injection.labels, missed: x[k].injection.wrongAction },
}]));
writeFileSync(OUT, JSON.stringify({ rules: slim(rules), model: model ? { name: process.env.ANDE_MODEL ?? "claude-sonnet-4-5", at: new Date().toISOString(), ...slim(model) } : previous?.model ?? null, gate: gate ?? previous?.gate ?? null }) + "\n");
if (failures.length) { console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`); process.exitCode = 1; }
