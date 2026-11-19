// npm run evals:replay
// Turns each fixed bug back on and checks the evals catch it again. Exits non-zero if any bug would slip through.
import { replayBugs } from "./mutations.ts";

const rows = await replayBugs((r) => {
  const by = [r.scenarios.length && `${r.scenarios.length} scenario${r.scenarios.length > 1 ? "s" : ""}`, r.users.length && `${r.users.length} real-user sentence${r.users.length > 1 ? "s" : ""}`, r.ranking && `ranking (${r.ranking})`].filter(Boolean);
  console.log(`${r.caught ? "✓" : "✗"} ${r.flag.toUpperCase().padEnd(4)} ${r.bug}\n       ${r.caught ? `caught by ${by.join(", ")}` : "NOT CAUGHT: the evals have a blind spot here"}`);
});
const caught = rows.filter((r) => r.caught).length;
console.log(`\nbug replay: ${caught}/${rows.length} fixed bugs would be caught if they came back`);
if (caught < rows.length) process.exitCode = 1;
