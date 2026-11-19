// Bug replay: would the evals catch each bug we already fixed, if it came back?
//
// Every fixed bug that changed agent behavior has a legacy switch (Ctx["legacy"]) that turns the old code path back on.
// This re-runs the scenario suite, the real-user sweep and the ranking eval with each switch flipped and records which
// layer notices. A bug no layer catches means the evals have a blind spot, so it fails the run. The question it answers
// is the one a reviewer asks about any eval suite: is it sensitive to the failures you actually had?
import { offline } from "../src/llm/client.ts";
import type { Ctx } from "../src/tools/registry.ts";
import { runRankingSuite } from "./ranking.ts";
import { runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios.ts";
import { checkUserRow, REAL_USER_REQUESTS } from "./user-requests.ts";

type Flag = keyof NonNullable<Ctx["legacy"]>;
export const FIXED_BUGS: [Flag, string][] = [
  ["r7", "\"japanese dinner\" booked a Korean room"],
  ["r8", "dietary needs sent to the venue but never confirmed to the booker"],
  ["r10", "\"somewhere in SoHo\" booked Williamsburg"],
  ["r11", "memory made the first pick worse than no memory"],
  ["r12", "\"dinner for 2, somewhere private\" emailed nobody"],
  ["r13", "notice measured when venues replied, not when the booker asked"],
  ["r15", "a budget nothing meets was a dead end"],
];

export interface Replay { flag: Flag; bug: string; scenarios: string[]; users: string[]; ranking: string | null; caught: boolean }

export async function replayBugs(onBug?: (r: Replay) => void): Promise<Replay[]> {
  const fixed = await runRankingSuite(offline);
  const out: Replay[] = [];
  for (const [flag, bug] of FIXED_BUGS) {
    const legacy = { [flag]: true };
    const scenarios: string[] = [], users: string[] = [];
    for (const s of SCENARIOS) if ((await runScenario(s, offline, undefined, legacy)).checks.some((c) => !c.pass)) scenarios.push(s.id);
    for (const row of REAL_USER_REQUESTS) if ((await checkUserRow(row, legacy)).why) users.push(row[0]);
    const r = await runRankingSuite(offline, { legacy });
    const ranking = r.warm.hit1 < fixed.warm.hit1 || r.warm.hit3 < fixed.warm.hit3 || r.hurt > fixed.hurt
      ? `warm hit@1 ${pct(r.warm.hit1)} vs ${pct(fixed.warm.hit1)} fixed` : null;
    const rep = { flag, bug, scenarios, users, ranking, caught: scenarios.length > 0 || users.length > 0 || ranking !== null };
    out.push(rep); onBug?.(rep);
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
