// Metamorphic testing for the request parser: no labels needed, only relations between inputs.
//
// Every real-user sentence and every scenario request is rewritten in ways a person might type it:
//   same meaning   "Hi! ...", "...please", "Can you book ...", ALL CAPS, doubled spaces, trailing "thanks!"  -> the parse must not change
//   new headcount  the number of guests changed                                                           -> the headcount must follow it
// A failure is a sentence where politeness or casing changed what would be booked. No model, no network.
import type { BookingRequest } from "../src/domain/types.ts";
import { parseRules } from "../src/parse/request.ts";
import { SCENARIOS } from "./scenarios.ts";
import { REAL_USER_REQUESTS, TODAY } from "./user-requests.ts";

export const SAME_MEANING: [string, (t: string) => string][] = [
  ["greeting", (t) => `Hi! ${t}`],
  ["please", (t) => `${t} please`],
  ["can you book", (t) => `Can you book ${t}?`],
  ["thanks", (t) => `${t}. Thanks!`],
  ["all caps", (t) => t.toUpperCase()],
  ["all lowercase", (t) => t.toLowerCase()],
  ["pasted with line breaks", (t) => t.replace(/, /g, ",\n")],
  ["doubled spaces", (t) => t.replace(/ /g, "  ")],
  ["capitalised", (t) => t[0].toUpperCase() + t.slice(1)],
  ["trailing period", (t) => `${t}.`],
  ["need help", (t) => `Need help with something: ${t}`],
];

/** What would change the booking. Notes and wording-only fields are left out on purpose. */
const key = (r: BookingRequest) => JSON.stringify({
  n: r.partySizeStated ? r.partySize : null, date: r.date, time: r.time, kind: r.kind, client: r.clientName?.toLowerCase() ?? null,
  private: r.privateRoom, where: r.neighborhood, cuisine: r.cuisine, cap: r.maxPerHeadCents, diet: [...r.dietary].sort(),
});

export interface MetaFailure { sentence: string; rewrite: string; variant: string; before: string; after: string }
export interface MetaReport { sentences: number; checks: number; failures: MetaFailure[] }

export function metamorphic(): MetaReport {
  const texts = [...new Set([...REAL_USER_REQUESTS.map((r) => r[0]), ...SCENARIOS.map((s) => s.text)])];
  const failures: MetaFailure[] = [];
  let checks = 0;
  for (const text of texts) {
    const today = SCENARIOS.find((s) => s.text === text)?.today ?? (REAL_USER_REQUESTS.some((r) => r[0] === text) ? TODAY : "2026-11-09");
    const base = parseRules(text, today), k0 = key(base);
    for (const [name, f] of SAME_MEANING) {
      const v = f(text), k = key(parseRules(v, today)); checks++;
      if (k !== k0) failures.push({ sentence: text, rewrite: name, variant: v, before: k0, after: k });
    }
    // Change the headcount: "for 6" -> "for 9". The parse must follow it, whatever else it says.
    const m = text.match(/\bfor (\d{1,2})\b(?! ?(?:am|pm|:|\.\d|per|pp|a head))/i);
    if (m && base.partySizeStated && base.partySize === Number(m[1])) {
      const n = Number(m[1]) + 3, v = text.replace(m[0], `for ${n}`), r = parseRules(v, today); checks++;
      if (r.partySize !== n) failures.push({ sentence: text, rewrite: "headcount +3", variant: v, before: String(base.partySize), after: String(r.partySize) });
    }
  }
  return { sentences: texts.length, checks, failures };
}
