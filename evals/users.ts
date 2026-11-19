// npm run evals:users
// Requests written the way real people type them (no templates), each with the outcome a person would expect.
// This sweep found R13-R15, R18 and R19; R12 was found by the first real user. Rules parsing, no key needed.
import { checkUserRow, REAL_USER_REQUESTS } from "./user-requests.ts";

let ok = 0;
for (const row of REAL_USER_REQUESTS) {
  const r = await checkUserRow(row);
  if (!r.why) ok++;
  console.log(`${r.why ? "✗" : "✓"} ${r.outcome.padEnd(20)} ${row[0]}${r.why ? `   (${r.why}: ${r.last})` : ""}`);
}
console.log(`\nreal-user sweep: ${ok}/${REAL_USER_REQUESTS.length} as a person would expect`);
if (ok < REAL_USER_REQUESTS.length) process.exitCode = 1;
