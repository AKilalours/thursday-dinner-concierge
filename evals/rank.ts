// npm run evals:ranking
// Does memory make the next shortlist better? Same sourcing code, same held-out requests, ranked with an empty
// memory (cold) and with what 40 past bookings taught it (warm), graded against each venue's hidden temperament.
// Also replays the pre-R11 memory so the fix is measured, not asserted.
import { mkdirSync, writeFileSync } from "node:fs";
import { offline } from "../src/llm/client.ts";
import { runRankingSuite } from "./ranking.ts";
import type { RankStats } from "./ranking.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const row = (name: string, s: RankStats) => `| ${name} | ${pct(s.hit1)} | ${pct(s.hit3)} | ${s.mrr.toFixed(2)} |`;

const before = await runRankingSuite(offline, { legacy: { r11: true } });
const after = await runRankingSuite(offline);

const lines = [
  `# Ranking eval`,
  ``,
  `${after.worlds} worlds · ${after.history} past bookings · ${after.heldOut} held-out requests · ${after.facts} facts learned from venue replies.`,
  `A hit is a venue that would really confirm. hit@3 = one is in the shortlist the agent emails.`,
  ``,
  `| Ranking | hit@1 | hit@3 | MRR |`,
  `|---|---|---|---|`,
  row("Cold (no memory)", after.cold),
  row("Warm, memory before R11", before.warm),
  row("Warm, memory now", after.warm),
  ``,
  `Memory moved a confirming venue into the shortlist on ${after.helped} requests and out of it on ${after.hurt}.`,
  `Before R11 (memory kept only bad news, and a quote for one room leaked onto the venue's other rooms), warm hit@1 was ${pct(before.warm.hit1)} against ${pct(after.cold.hit1)} with no memory at all.`,
  ...after.examples.map((e) => `- "${e.text}": cold ${e.cold.join(", ")} → warm ${e.warm.join(", ")}`),
];
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL("./results/ranking.md", import.meta.url), lines.join("\n") + "\n");
console.log(lines.join("\n"));
// Memory must never make the shortlist worse than no memory.
if (after.hurt > 0 || after.warm.hit3 < after.cold.hit3 || after.warm.mrr < after.cold.mrr) process.exitCode = 1;
