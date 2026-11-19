// One sentence -> a typed BookingRequest. The model reads the language; code owns the calendar and
// checks the model never invents a party size that is not in the sentence.
import { z } from "zod";
import { BookingRequest, ClockTime, EventKind } from "../domain/types.ts";
import { structured } from "../llm/client.ts";
import type { LLM } from "../llm/client.ts";
import { resolveDate } from "../time.ts";

const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, dozen: 12, thirty: 30,
};
export const NEIGHBORHOODS = ["flatiron", "midtown", "tribeca", "west village", "soho", "chelsea", "financial district", "williamsburg"];
// The network's cuisines plus ones people ask for that it may not have: a cuisine we don't serve must be heard, not dropped.
const CUISINES = ["italian", "steakhouse", "steak", "japanese", "sushi", "omakase", "new american", "french", "mediterranean", "korean", "seafood",
  "thai", "mexican", "indian", "chinese", "vietnamese", "greek", "spanish", "tapas", "ethiopian", "lebanese", "turkish", "peruvian", "bbq"];
// Regression R22: "no shellfish", "allergic to nuts" and "dairy free" were dropped, so the venue was never told.
// People rarely type the label itself, so each need lists the ways it is actually written.
const DIETARY: [string, RegExp][] = [
  ["vegetarian", /\bvegetarians?\b/], ["vegan", /\bvegans?\b/], ["kosher", /\bkosher\b/], ["halal", /\bhalal\b/],
  ["gluten-free", /\bgluten[- ]?free\b|\bno gluten\b|\bc(?:o)?eliac\b/],
  ["dairy-free", /\bdairy[- ]?free\b|\bno dairy\b|\blactose\b/],
  ["nut-allergy", /\b(?:tree[- ])?nut[- ](?:free|allerg\w*)|\bno (?:tree )?nuts\b|\ballergic to (?:tree )?nuts?\b/],
  ["shellfish-allergy", /\bshellfish\b/],
];

export function partySizeFrom(text: string): number | null {
  const t = text.toLowerCase();
  // Regression R4: a bare "<number> at" also matched dates ("Nov 18 at 7:30pm" became 18 guests), so a
  // headcount needs "for N", "party of N" or "N people/guests"; anything else is asked, not guessed.
  const forN = t.match(/\b(?:for|party of|group of|table for)\s+(\d{1,3})\b(?!\s*(?:am|pm|:\d))/);
  if (forN) return Number(forN[1]);
  // Regression R19: "for me and 3 clients" asked how many guests, and "myself and 5 people" booked 5; the booker counts too.
  const me = t.match(/\b(?:me|myself)\s*(?:and|\+|plus|&)\s*(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?:am|pm|:\d))/);
  if (me) return (WORDS[me[1]] ?? Number(me[1])) + 1;
  const names = namedGuests(t);
  if (names) return names;
  const n = t.match(/\b(\d{1,3})\s*(?:people|guests|pax|of us|ppl|attendees|folks|covers)\b/);
  if (n) return Number(n[1]);
  const w = t.match(/\b(?:for|party of|group of|table for|a)\s+(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty|dozen)\b/)
    ?? t.match(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty)\s+(?:people|guests|of us)\b/);
  return w ? WORDS[w[1]] : null;
}

// Regression R29: "dinner for me, Sam and Priya" asked how many guests. A list of single names that includes the
// booker is a headcount; anything that is not clearly a person ("my boss", "the team") is still asked, not guessed.
const NOT_A_GUEST = /^(the|my|our|a|an|some|us|them|you|everyone|team|clients?|colleagues?|friends?|family|guests?|people|kids|on|at|in|next|this|tomorrow|tonight|lunch|dinner|drinks)$/;

function namedGuests(t: string): number | null {
  const m = t.match(/\bfor ((?:[a-z][a-z'-]*\s*,\s*)*[a-z][a-z'-]*\s*,?\s*(?:and|&)\s+[a-z][a-z'-]*)\b/);
  if (!m) return null;
  const people = m[1].split(/\s*,\s*(?:and\s+|&\s+)?|\s+(?:and|&)\s+/).map((p) => p.trim());
  if (!people.some((p) => p === "me" || p === "myself")) return null;
  if (people.some((p) => NOT_A_GUEST.test(p) || /\s/.test(p))) return null;
  return new Set(people).size === people.length && people.length <= 12 ? people.length : null;
}

export function dietaryFrom(text: string): string[] {
  const t = text.toLowerCase();
  const known = DIETARY.filter(([, re]) => re.test(t)).map(([label]) => label);
  // Any other "allergic to X" is still passed on, so a venue hears about sesame even without a rule for it.
  const other = [...t.matchAll(/\ballergic to ([a-z]+)/g)].map((m) => m[1].replace(/s$/, ""))
    .filter((x) => !["nut", "tree", "shellfish"].includes(x)).map((x) => `${x}-allergy`);
  return [...new Set([...known, ...other])];
}

// Regression R23: "$1,500 all in" and "budget 2k" were ignored, so nothing capped the spend. A total only means
// something per head once the headcount is known, so it is divided by a stated party size and ignored otherwise.
export function totalBudgetCents(text: string): number | null {
  const t = text.toLowerCase();
  // After "total"/"all in" the figure needs a "$" or "k", so "dinner for 120 total" stays a headcount.
  const money = String.raw`(\$\d{1,3}(?:,\d{3})+|\$\d{3,6}|\$?\d{1,3}(?:\.\d)?k)(?![\d,])`;
  const bare = String.raw`\$?(\d{1,3}(?:,\d{3})+|\d{3,6}|\d{1,3}(?:\.\d)?k)(?![\d,])`;
  const m = t.match(new RegExp(String.raw`${money}\s*(?:total|all[- ]in|in total|overall)\b`))
    ?? t.match(new RegExp(String.raw`\b(?:total budget|budget|spend)\s*(?:of|is|:|around|about|max)?\s*${bare}(?!\s*(?:\/|a |per |pp|each))`));
  if (!m) return null;
  const k = m[1].endsWith("k");
  const n = Number(m[1].replace(/[$,k]/g, ""));
  return Math.round((k ? n * 1000 : n) * 100);
}

function timeFrom(text: string, kind: EventKind): string {
  const t = text.toLowerCase();
  // Regression R21: "at 7.30pm" read "30pm" as the hour (42:00) and crashed the booking; "7.30" booked 7:00 and
  // "noon" booked 12:30. A dot separates minutes too, and an impossible time falls back to the default, never a crash.
  if (/\b(?:noon|midday)\b/.test(t)) return "12:00";
  const m = t.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/) ?? t.match(/\bat\s+(\d{1,2})(?:[:.](\d{2}))?\b/);
  if (m) {
    let h = Number(m[1]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (!m[3] && h < 11) h += 12; // "at 7" for a dinner means 7 pm
    if (h <= 23 && Number(m[2] ?? 0) < 60) return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
  }
  return kind === "client_lunch" ? "12:30" : kind === "happy_hour" ? "17:30" : "19:00";
}

/** The deterministic parser: always available, and the fallback when the model times out or is off. */
const NOT_A_NAME = /^(on|next|this|at|in|for|tomorrow|tonight|team|folks|group|execs|leadership|crew|and|to|near|from|around|somewhere|private|under|people|guests)\b/;

export function parseRules(raw: string, today: string): BookingRequest {
  // Regression R26 (found by metamorphic testing): text pasted from Slack or email with doubled spaces or line breaks
  // lost allergies, the neighborhood, "Christmas Eve" and the kind of event. Whitespace is normalized first.
  const text = raw.replace(/\s+/g, " ").trim();
  const t = text.toLowerCase();
  // Regression R27 (found by metamorphic testing): a request typed in ALL CAPS or all lowercase lost the client, which
  // is read from a capitalised name. In a one-case sentence the word after "with" is the name, unless it's "a", "my"...
  const named = /[a-z]/.test(text) && /[A-Z]/.test(text) ? text
    : t.replace(/\bwith (the )?([a-z][\w&.'-]*)( [a-z][\w&.'-]*)?/, (_m, the: string | undefined, w: string, w2: string | undefined) => {
      if (/^(a|an|our|my|some|me|us|them|you|everyone|clients?|colleagues|friends|family|kids|vegetarians|vegans|dietary|\d.*)$/.test(w)) return _m;
      const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
      const second = w2 && !/[,.]$/.test(w) && !NOT_A_NAME.test(w2.trim()) ? ` ${cap(w2.trim())}` : (w2 ?? "");
      return `with ${the ?? ""}${cap(w)}${second}`;
    });
  const kind: EventKind = /\blunch\b/.test(t) ? "client_lunch"
    : /happy hour|\bdrinks\b/.test(t) ? "happy_hour"
    : /\b(our|my) team\b|team dinner|offsite|team outing|celebrat/.test(t) && !/client|customer|prospect/.test(t) ? "team_dinner"
    : "client_dinner";
  const client = named.match(/\bwith (?:the )?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)?)(?:\s+(?:team|folks|group|execs|leadership|crew))?/);
  // "with Acme. Thanks!" is Acme: a name ends at a full stop.
  const clientName = client && !/^(Our|My|The|A|An|Some)$/.test(client[1]) ? client[1].replace(/\.(\s.*)?$/, "") || null : null;
  // Regression R20: "$60pp" and "100 per person" without "under" were ignored, so an over-budget venue got booked.
  // A per-head figure in a booking request is the booker's ceiling, so it reads as a cap with or without "under".
  const perHead = t.match(/(?:under|below|max(?:imum)?|no more than|up to)\s+\$?(\d{2,4})\s*(?:\/|a|per)?\s*(?:head|person|pp|guest)/)
    ?? t.match(/\$(\d{2,4})\s*(?:\/|a|per)?\s*(?:head|person|pp|guest)\b/)
    ?? t.match(/\b(\d{2,4})\s*(?:(?:\/|a|per)\s*(?:head|person|guest)|pp)\b/);
  const total = totalBudgetCents(text), party = partySizeFrom(text);
  const fromTotal = !perHead && total !== null && party ? Math.floor(total / party) : null;
  const d = resolveDate(text, today);
  return {
    partySize: partySizeFrom(text) ?? 2,
    partySizeStated: partySizeFrom(text) !== null,
    date: d.date,
    dateAmbiguous: d.ambiguous,
    time: timeFrom(text, kind),
    kind,
    clientName: kind === "team_dinner" ? null : clientName,
    privateRoom: /\bprivate\b|privately|\bpdr\b|buyout|private dining|our own room|somewhere quiet|closed[- ]door/.test(t),
    neighborhood: NEIGHBORHOODS.find((n) => t.includes(n)) ?? (/near (the )?office|close to (the )?office/.test(t) ? "office" : null),
    cuisine: CUISINES.find((c) => new RegExp(`\\b${c}\\b`).test(t))?.replace(/^steak$/, "steakhouse").replace(/^(sushi|omakase)$/, "japanese") ?? null,
    maxPerHeadCents: perHead ? Number(perHead[1]) * 100 : fromTotal,
    dietary: dietaryFrom(t),
    notes: "",
  };
}

const ModelOut = z.object({
  partySize: z.number().int().min(1).max(500).nullable(),
  kind: EventKind,
  clientName: z.string().nullable(),
  privateRoom: z.boolean(),
  neighborhood: z.string().nullable(),
  cuisine: z.string().nullable(),
  maxPerHeadDollars: z.number().nullable(),
  time24h: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  dietary: z.array(z.string()),
  notes: z.string().max(300),
});

const SYSTEM = `You turn a corporate booker's one-line request into JSON for a dining concierge.
Fields: partySize (null if not stated), kind (client_dinner | team_dinner | client_lunch | happy_hour),
clientName (the external company they are hosting, null if none), privateRoom, neighborhood (NYC neighborhood or "office" for "near the office"),
cuisine, maxPerHeadDollars, time24h (null if not stated), dietary, notes (anything else that matters to a venue).
Never guess a value that is not in the request. Do not resolve dates. JSON only.`;

export interface ParseResult { request: BookingRequest; decidedBy: "model" | "rules"; note: string | null }

export async function parseRequest(llm: LLM, text: string, today: string): Promise<ParseResult> {
  const base = parseRules(text, today);
  const m = await structured(llm, "parse_request", ModelOut, SYSTEM, `Request: ${text}`);
  if (!m.value) return { request: base, decidedBy: "rules", note: m.error };
  const v = m.value;
  // Code checks the model: a party size must be literally in the sentence, or we ask instead of guessing.
  const literal = partySizeFrom(text);
  const partySize = v.partySize !== null && literal !== null && v.partySize === literal ? v.partySize : literal;
  const timeOk = v.time24h !== null && ClockTime.safeParse(v.time24h).success;
  const request = BookingRequest.parse({
    ...base,
    partySize: partySize ?? 2,
    partySizeStated: partySize !== null,
    kind: v.kind,
    clientName: v.clientName,
    privateRoom: v.privateRoom,
    neighborhood: v.neighborhood?.toLowerCase() ?? base.neighborhood,
    cuisine: v.cuisine?.toLowerCase() ?? base.cuisine,
    // A cap code derived from a total wins: the model may report the total itself as the per-head figure.
    maxPerHeadCents: v.maxPerHeadDollars !== null && totalBudgetCents(text) === null ? Math.round(v.maxPerHeadDollars * 100) : base.maxPerHeadCents,
    // Regression R24: an impossible model time ("25:00") is dropped for the sentence's own, never booked.
    time: timeOk ? v.time24h! : base.time,
    dietary: v.dietary,
    notes: v.notes,
  });
  const notes = [
    v.partySize !== partySize ? `model party size ${v.partySize} overruled` : null,
    v.time24h !== null && !timeOk ? `model time ${v.time24h} overruled` : null,
  ].filter(Boolean);
  return { request, decidedBy: "model", note: notes.length ? notes.join("; ") : null };
}
