// npm run users:import
// Reads GitHub issues labelled real-user and appends each new one to evals/reported.ts as a permanent eval row.
// Public repo, so no token is needed (set GITHUB_TOKEN to raise the rate limit). Prints what it skipped and why.
import { readFileSync, writeFileSync } from "node:fs";
import { REPORTED } from "./reported.ts";
import { parseReport } from "./reports.ts";
import type { Issue } from "./reports.ts";

const REPO = process.env.REPORTS_REPO ?? "AKilalours/thursday-dinner-concierge";
const res = await fetch(`https://api.github.com/repos/${REPO}/issues?labels=real-user&state=all&per_page=100`, {
  headers: { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
});
if (!res.ok) { console.log(`GitHub returned HTTP ${res.status}`); process.exit(1); }
const issues = await res.json() as Issue[];
const have = new Set(REPORTED.map((r) => r[0].toLowerCase()));
const FILE = new URL("./reported.ts", import.meta.url);
let src = readFileSync(FILE, "utf8"), added = 0;
for (const issue of issues.sort((a, b) => a.number - b.number)) {
  const p = parseReport(issue);
  if (!p.ok) { console.log(`skip #${issue.number}: ${p.why}`); continue; }
  if (have.has(p.text.toLowerCase())) continue;
  src = src.replace("\n];", `\n  [${JSON.stringify(p.text)}, ${JSON.stringify(p.outcome)}, undefined, ${issue.number}],\n];`);
  have.add(p.text.toLowerCase()); added++;
  console.log(`added #${issue.number}: "${p.text}" -> ${p.outcome}`);
}
if (added) writeFileSync(FILE, src);
console.log(`${issues.length} reports, ${added} new eval rows. Run npm run evals:users to see which ones fail today.`);
