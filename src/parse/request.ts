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
  // Regression R37: "dinner for 4-6 people" booked a table for 4, so two guests had no seat. A range is not a
  // headcount: it is asked, never rounded down (or up, which would pay a deposit for empty chairs).
  if (headcountRange(t)) return null;
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

function headcountRange(t: string): boolean {
  const range = String.raw`(\d{1,3})\s*(?:-|–|to|or)\s*(\d{1,3})`;
  const m = t.match(new RegExp(String.raw`\b(?:for|party of|group of|table for)\s+${range}\b(?!\s*(?:am|pm|:\d))`))
    ?? t.match(new RegExp(String.raw`\b${range}\s*(?:people|guests|pax|of us|ppl|attendees|folks|covers)\b`));
  return !!m && Number(m[2]) > Number(m[1]);
}

// Regression R29: "dinner for me, Sam and Priya" asked how many guests. A list of single names that includes the
// booker is a headcount; anything that is not clearly a person ("my boss", "the team") is still asked, not guessed.
const NOT_A_GUEST = /^(the|my|our|a|an|some|us|them|you|everyone|team|clients?|colleagues?|friends?|family|guests?|people|kids|on|at|in|next|this|tomorrow|tonight|lunch|dinner|drinks)$/;

// Regression R30: "for me and my boss" asked how many. A singular role ("my boss", "a client") is one person;
// a plural or a group ("my clients", "the team") is still asked.
const ONE_PERSON = /^(?:my|our|a|an|the) (?:boss|manager|ceo|cfo|cto|founder|director|vp|client|customer|colleague|coworker|co-worker|partner|wife|husband|spouse|assistant|investor|mentor|friend|guest|intern|candidate)$/;

function namedGuests(t: string): number | null {
  const item = String.raw`(?:(?:my|our|an?|the)\s+)?[a-z][a-z'-]*`;
  const m = t.match(new RegExp(String.raw`\bfor ((?:${item}\s*,\s*)*${item}\s*,?\s*(?:and|&)\s+${item})\b`));
  if (!m) return null;
  const people = m[1].split(/\s*,\s*(?:and\s+|&\s+)?|\s+(?:and|&)\s+/).map((p) => p.trim().replace(/\s+/g, " "));
  if (!people.some((p) => p === "me" || p === "myself")) return null;
  if (people.some((p) => (/\s/.test(p) ? !ONE_PERSON.test(p) : NOT_A_GUEST.test(p)))) return null;
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
  // Regression R47: "$500 for the group" booked $791 all-in; "for the group/table/team" and "for everyone" mark a total too.
  const whole = String.raw`for (?:the (?:whole )?|our (?:whole )?)?(?:group|table|team|party)|for (?:all of us|everyone|everybody)`;
  const m = t.match(new RegExp(String.raw`${money}\s*(?:total|all[- ]in|in total|overall|${whole})\b`))
    ?? t.match(new RegExp(String.raw`\b(?:total budget|budget|spend)\s*(?:of|is|:|around|about|max)?\s*${bare}(?!\s*(?:\/|a |per |pp|each))`));
  if (!m) return null;
  const k = m[1].endsWith("k");
  const n = Number(m[1].replace(/[$,k]/g, ""));
  return Math.round((k ? n * 1000 : n) * 100);
}

// Regression R38: "Friday 7-9pm" booked 9 pm, because only the end of the range carried "pm". A range books its
// start, which borrows the end's am/pm unless it wraps ("11-1pm" is 11 am). A bare "4-6" with no "from", "between",
// "at" or am/pm is left alone: after "for" it is a headcount (R37), and elsewhere it may be a date.
// Regression R39: "drinks for 10 friday 6-8" booked the default 5:30 pm. Right after a day word a bare range can only
// be a time, so it books its start too.
// Regression R40: "drinks for 8 on Dec 3 6-8" still booked 5:30 pm. A calendar date ("Dec 3", "3rd December",
// "12/3", "the 19th") is a day word too.
const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const ORD = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const AFTER_DAY = new RegExp(String.raw`\b(?:\w+day|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|tonight|tomorrow|tmrw|${MONTH}\s+${ORD}(?:,?\s+\d{4})?|${ORD}\s+(?:of\s+)?${MONTH}|the\s+\d{1,2}(?:st|nd|rd|th)|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b,?\s*$`);
const TIME_RANGE = /(?<![$\d\/-])(?<!\bfor )\b(from |between |at )?(\d{1,2})((?:[:.]\d{2})?)\s*(am|pm)?\s*(-|–|to|and|until|till)\s*(\d{1,2})(?:[:.]\d{2})?\s*(am|pm)?\b/g;

function rangeStart(all: string, pre: string | undefined, h: string, mm: string, ap: string | undefined, sep: string, h2: string, ap2: string | undefined, at: number, text: string): string {
  const afterDay = sep !== "and" && AFTER_DAY.test(text.slice(0, at));
  if ((!pre && !ap2 && !afterDay) || (sep === "and" && pre !== "between ")) return all;
  const wraps = Number(h) > Number(h2) && Number(h) !== 12;
  const meridiem = ap ?? (ap2 && wraps ? (ap2 === "pm" ? "am" : "pm") : ap2 ?? "");
  // The match can end in a space ("6-8 please"); keep it, or "at 6please" loses the time.
  return `at ${h}${mm}${meridiem}${all.endsWith(" ") ? " " : ""}`;
}

function timeFrom(text: string, kind: EventKind): string {
  // Regression R32: "at half past 7" fell through to the default 7 pm, and "half past 8" booked 7 pm too.
  // Spoken quarters and halves become clock times before the patterns below read them.
  const t = text.toLowerCase()
    .replace(/\bhalf past (\d{1,2})(?!\d|[:.]\d)/g, "at $1:30")
    .replace(/\b(?:a )?quarter past (\d{1,2})(?!\d|[:.]\d)/g, "at $1:15")
    .replace(/\b(?:a )?quarter (?:to|of) (\d{1,2})(?!\d|[:.]\d)/g, (_, h) => `at ${Number(h) === 1 ? 12 : Number(h) - 1}:45`)
    .replace(TIME_RANGE, rangeStart)
    .replace(/\bat at\b/g, "at");
  // Regression R21: "at 7.30pm" read "30pm" as the hour (42:00) and crashed the booking; "7.30" booked 7:00 and
  // "noon" booked 12:30. A dot separates minutes too, and an impossible time falls back to the default, never a crash.
  if (/\b(?:noon|midday)\b/.test(t)) return "12:00";
  // Regression R31: "around 6", "8ish" and "around 8ish pm" were dropped, so drinks "around 6" booked 5:30 pm and
  // dinner "8ish" booked 7 pm. "around/about/by" and a trailing "ish" mark a time, but never a headcount.
  const m = t.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:ish\s*)?(am|pm)\b/)
    ?? t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*ish\b/)
    ?? t.match(/\b(?:at|around|about|by)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:people|persons|guests|ppl|pax|folks|of\b|a head|each|pp|per\b|k\b|dollars|bucks|\/|%|[,.:]?\d))/);
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
const NOT_A_NAME = /^(on|next|this|the|a|an|at|in|for|tomorrow|tonight|team|folks|group|execs|leadership|crew|and|to|near|from|around|somewhere|private|under|people|guests)\b/;

// Regression R41: "with Hooli Friday at 7" named the client "Hooli Friday" (and "with globex two weeks from ..." was
// "Globex Two"). A weekday, month, "tmrw" or "two weeks" is when the dinner is, never the second word of a name.
const DATE_WORD = /^(?:mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|today|tonight|tomorrow|tmrw|tmr|(?:two|three|four|five|six) (?:days?|weeks?))\b/i;

function withoutDateWord(name: string, after: string): string {
  const [first, second] = name.split(/\s+/);
  return second && DATE_WORD.test(second + after) ? first : name;
}

export function parseRules(raw: string, today: string): BookingRequest {
  // Regression R26 (found by metamorphic testing): text pasted from Slack or email with doubled spaces or line breaks
  // lost allergies, the neighborhood, "Christmas Eve" and the kind of event. Whitespace is normalized first.
  // Regression R49: "dinner for 4 on Friday w/ Acme" lost Acme. "w/" is "with"; "w/o" (without) is left alone.
  const text = raw.replace(/\bw\/(?!o\b)\s*/gi, "with ").replace(/\s+/g, " ").trim();
  const t = text.toLowerCase();
  // Regression R27 (found by metamorphic testing): a request typed in ALL CAPS or all lowercase lost the client, which
  // is read from a capitalised name. In a one-case sentence the word after "with" is the name, unless it's "a", "my"...
  // Regression R42: "Drinks for 6 with hooli friday" lost Hooli. Capitals that start a sentence, "I", "PM" or "Dinner"
  // say nothing about names; with no other capital the booker doesn't capitalise names, so read it as one-case.
  // Regression R43: "with acme corp on Friday" lost Acme Corp. English capitalises weekdays and months, so they say
  // nothing about whether the booker capitalises names. They go first, so "Friday. Thanks" still ends a sentence.
  const capitalisesNames = /[A-Z]/.test(text
    .replace(/\b(?:Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|nesday|sday|urday)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/g, "")
    .replace(/(?:^|[.!?:])\s*[A-Z]/g, "")
    .replace(/\bI\b|(?<=\d ?)[AP]M\b|\b(?:Dinner|Lunch|Drinks|Breakfast|Brunch|Happy|Hour|Team)\b/g, ""));
  const named = /[a-z]/.test(text) && capitalisesNames ? text
    : t.replace(/\bwith (the )?([a-z][\w&.'-]*)( [a-z][\w&.'-]*)?/g, (_m, the: string | undefined, w: string, w2: string | undefined) => {
      if (/^(a|an|our|my|some|me|us|them|you|everyone|team|group|crew|something|someone|anything|it|this|that|clients?|colleagues|friends|family|kids|vegetarians|vegans|dietary|outdoor|indoor|seating|patio|terrace|garden|views?|wine|live|music|parking|wheelchair|step-free|good|great|nice|quiet|\d.*)$/.test(w)) return _m;
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
  const clientName = client && !/^(Our|My|The|A|An|Some)$/.test(client[1])
    ? withoutDateWord(client[1], named.slice(client.index! + client[0].indexOf(client[1]) + client[1].length)).replace(/\.(\s.*)?$/, "") || null
    : null;
  // Regression R20: "$60pp" and "100 per person" without "under" were ignored, so an over-budget venue got booked.
  // A per-head figure in a booking request is the booker's ceiling, so it reads as a cap with or without "under".
  const perHead = t.match(/(?:under|below|max(?:imum)?|no more than|up to)\s+\$?(\d{2,4})\s*(?:\/|a|per)?\s*(?:head|person|pp|guest)/)
    ?? t.match(/\$(\d{2,4})\s*(?:\/|a|per)?\s*(?:head|person|pp|guest)\b/)
    ?? t.match(/\b(\d{2,4})\s*(?:(?:\/|a|per)\s*(?:head|person|guest)|pp)\b/)
    // Regression R45: "budget $80 each" booked $132 a head. "each" needs a "$" or "budget", so "for 10 each" is not a cap.
    ?? t.match(/(?:\$|\bbudget\s*(?:of|is|:)?\s*\$?)(\d{2,4})\s*each\b/)
    // Regression R46: "80 bucks a head" and "$80 a pop" booked with no cap. Slang needs "bucks"/"dollars" or a "$".
    ?? t.match(/\b(\d{2,4})\s*(?:bucks|dollars)\s*(?:(?:\/|a|per)\s*(?:head|person|guest|pop)|pp|each)\b/)
    ?? t.match(/\$(\d{2,4})\s*a\s+pop\b/);
  const total = totalBudgetCents(text), party = partySizeFrom(text);
  const fromTotal = !perHead && total !== null && party ? Math.floor(total / party) : null;
  const d = resolveDate(text, today);
  // Catering: food brought to the office rather than a table somewhere. "near the office" is still a restaurant.
  const catering = /\bcater(?:ed|ing|er|ers)?\b|\bboxed (?:lunch|breakfast)|\bdeliver(?:ed|y)\b|\border (?:in )?(?:lunch|breakfast|food)\b|\b(?:lunch|breakfast|food) (?:in|at|to|for) the office\b|\bin-office (?:lunch|breakfast)\b/.test(t);
  const stated = timeFrom(text, kind), defaultTime = timeFrom("", kind);
  return {
    partySize: partySizeFrom(text) ?? 2,
    partySizeStated: partySizeFrom(text) !== null,
    date: d.date,
    dateAmbiguous: d.ambiguous,
    time: catering && stated === defaultTime ? (/breakfast/.test(t) ? "08:30" : "12:00") : stated,
    kind,
    clientName: kind === "team_dinner" ? null : clientName,
    privateRoom: !catering && /\bprivate\b|privately|\bpdr\b|buyout|private dining|our own room|somewhere quiet|closed[- ]door/.test(t),
    neighborhood: NEIGHBORHOODS.find((n) => t.includes(n)) ?? (/near (the )?office|close to (the )?office/.test(t) ? "office" : null),
    cuisine: CUISINES.find((c) => new RegExp(`\\b${c}\\b`).test(t))?.replace(/^steak$/, "steakhouse").replace(/^(sushi|omakase)$/, "japanese") ?? null,
    maxPerHeadCents: perHead ? Number(perHead[1]) * 100 : fromTotal,
    dietary: dietaryFrom(t),
    notes: "",
    ...(catering ? { category: "catering" as const, neighborhood: "office" } : {}),
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
    // A catering order is delivered; there is no room to make private.
    privateRoom: base.category === "catering" ? false : v.privateRoom,
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
