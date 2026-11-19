// Parses a "Report it" GitHub issue into a real-user eval row. Pure, so it is tested without the network.
import type { Outcome } from "../src/domain/types.ts";

export interface Issue { number: number; title: string; body: string | null }
export type Parsed = { ok: true; text: string; outcome: Outcome } | { ok: false; why: string };

const TICKS: [RegExp, Outcome][] = [
  [/\[x\]\s*it should have booked/i, "booked"],
  [/\[x\]\s*it should have asked/i, "needs_clarification"],
  [/\[x\]\s*it should have passed it to a manager/i, "escalated"],
];

export function parseReport(issue: Issue): Parsed {
  const body = issue.body ?? "";
  const typed = body.match(/\*\*What I typed\*\*\s*```[a-z]*\s*\n([\s\S]*?)\n?```/i)?.[1]?.trim()
    ?? issue.title.match(/^Real user:\s*"(.+)"\s*$/)?.[1]?.trim();
  if (!typed) return { ok: false, why: "no sentence under 'What I typed'" };
  if (typed.length > 300) return { ok: false, why: "sentence longer than 300 characters" };
  const ticked = TICKS.filter(([re]) => re.test(body));
  if (ticked.length === 1) return { ok: true, text: typed, outcome: ticked[0][1] };
  // The app's prefilled form has a free-text "What I expected"; read plain words when no box is ticked.
  const said = body.match(/\*\*What I expected\*\*([\s\S]*?)(\n\*\*|<details|$)/i)?.[1]?.replace(/<!--[\s\S]*?-->/g, "").trim().toLowerCase() ?? "";
  const words: [RegExp, Outcome][] = [[/\bbook(ed|ing)?\b|\breserve/, "booked"], [/\bask|question|clarif|which/, "needs_clarification"], [/manager|escalat|approv/, "escalated"]];
  const hits = words.filter(([re]) => re.test(said));
  if (hits.length === 1) return { ok: true, text: typed, outcome: hits[0][1] };
  return { ok: false, why: ticked.length > 1 || hits.length > 1 ? "more than one expected outcome" : "no expected outcome given" };
}
