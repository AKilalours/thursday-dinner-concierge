// npm run evals:users
// 25 requests written the way real people type them (no templates), each with the outcome a person would expect.
// This sweep found R13-R15; R12 was found by the first real user. Rules parsing, no key needed.
import { REAL_USER_REQUESTS, runUserRequest } from "./user-requests.ts";

let ok = 0;
for (const [text, want] of REAL_USER_REQUESTS) {
  const r = await runUserRequest(text);
  const pass = r.outcome === want; if (pass) ok++;
  console.log(`${pass ? "✓" : "✗"} ${r.outcome.padEnd(20)} ${text}${pass ? "" : `   (expected ${want}: ${r.messagesToBooker.at(-1)})`}`);
}
console.log(`\nreal-user sweep: ${ok}/${REAL_USER_REQUESTS.length} as a person would expect`);
if (ok < REAL_USER_REQUESTS.length) process.exitCode = 1;
