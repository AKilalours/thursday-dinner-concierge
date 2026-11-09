// Calibrate the LLM judge against human labels before trusting its number.
//   node evals/calibrate.ts --export   write evals/judge_labels.jsonl from the latest eval run, human_score empty
//   (a person fills human_score 1-5 for each line, using the rubric in evals/judge.ts)
//   node evals/calibrate.ts            judge every labelled line and report agreement
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { llmFromEnv } from "../src/llm/client.ts";
import { judgeMessage, RUBRIC } from "./judge.ts";

const LABELS = new URL("./judge_labels.jsonl", import.meta.url);
const RESULTS = new URL("./results/latest.json", import.meta.url);

if (process.argv.includes("--export")) {
  const rows = JSON.parse(readFileSync(RESULTS, "utf8")) as { id: string; messages: string[] }[];
  const lines = rows.flatMap((r) => r.messages.filter((m) => /Reply approve or reject/.test(m)).map((message) => JSON.stringify({ id: r.id, request: r.id, message, human_score: null })));
  writeFileSync(LABELS, lines.join("\n") + "\n");
  console.log(`wrote ${lines.length} messages to label. Rubric:\n${RUBRIC}`);
  process.exit(0);
}

if (!existsSync(LABELS)) { console.log("no labels yet: run with --export, then fill human_score"); process.exit(0); }
const items = readFileSync(LABELS, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => typeof x.human_score === "number");
if (items.length < 20) console.log(`only ${items.length} labelled; label at least 50 for a number worth trusting`);
const llm = llmFromEnv();
const pairs: [number, number][] = [];
for (const it of items) {
  const v = await judgeMessage(llm, it.request, it.message);
  if (v) pairs.push([it.human_score, v.score]);
}
if (!pairs.length) { console.log(`no judge outputs (model mode ${llm.mode}); run with ANTHROPIC_API_KEY set`); process.exit(0); }
const exact = pairs.filter(([h, j]) => h === j).length / pairs.length;
const within1 = pairs.filter(([h, j]) => Math.abs(h - j) <= 1).length / pairs.length;
// Quadratic-weighted Cohen's kappa on the 1-5 scale.
const K = 5, O = Array.from({ length: K }, () => Array(K).fill(0));
for (const [h, j] of pairs) O[h - 1][j - 1]++;
const rowS = O.map((r) => r.reduce((a, b) => a + b, 0)), colS = O[0].map((_, j) => O.reduce((a, r) => a + r[j], 0));
let num = 0, den = 0;
for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
  const w = ((i - j) ** 2) / ((K - 1) ** 2);
  num += w * O[i][j];
  den += w * (rowS[i] * colS[j]) / pairs.length;
}
console.log(`judge vs human on ${pairs.length} messages: exact ${(exact * 100).toFixed(0)}%, within 1 point ${(within1 * 100).toFixed(0)}%, weighted kappa ${(1 - num / den).toFixed(2)}`);
console.log("ship on the judge's number only when kappa is high (around 0.7 or more) and stays there as labels grow.");
