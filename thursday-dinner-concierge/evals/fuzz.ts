// Randomized stress test: random requests x random venue behavior x random approver decisions.
// Only the invariants are checked, because those must hold no matter what the world does.
// node evals/fuzz.ts 300
import { offline } from "../src/llm/client.ts";
import { fuzzOne } from "./runner.ts";

const N = Number(process.argv[2] ?? 200);
const outcomes: Record<string, number> = {};
const failures: string[] = [];
let checks = 0;
for (let i = 0; i < N; i++) {
  const f = await fuzzOne(i, offline);
  outcomes[f.outcome] = (outcomes[f.outcome] ?? 0) + 1;
  checks += f.checks.length;
  for (const c of f.checks.filter((c) => !c.pass)) failures.push(`#${i} "${f.text}": ${c.name}: ${c.why}`);
}

console.log(`fuzz: ${N} random runs, ${checks} invariant checks, ${failures.length} failures`);
console.log(`outcomes: ${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(", ")}`);
for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
if (failures.length) process.exitCode = 1;
