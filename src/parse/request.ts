// One sentence -> a typed BookingRequest. The model reads the language; code owns the calendar and
// checks the model never invents a party size that is not in the sentence.
import { z } from "zod";
import { BookingRequest, EventKind } from "../domain/types.ts";
import { structured } from "../llm/client.ts";
import type { LLM } from "../llm/client.ts";
import { resolveDate } from "../time.ts";

const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, dozen: 12, thirty: 30,
};
export const NEIGHBORHOODS = ["flatiron", "midtown", "tribeca", "west village", "soho", "chelsea", "financial district", "williamsburg"];
const CUISINES = ["italian", "steakhouse", "steak", "japanese", "sushi", "omakase", "new american", "french", "mediterranean", "korean", "seafood"];
const DIETARY = ["vegetarian", "vegan", "gluten-free", "gluten free", "kosher", "halal", "nut allergy", "shellfish allergy"];

export function partySizeFrom(text: string): number | null {
  const t = text.toLowerCase();
  // Regression R4: a bare "<number> at" also matched dates ("Nov 18 at 7:30pm" became 18 guests), so a
  // headcount needs "for N", "party of N" or "N people/guests"; anything else is asked, not guessed.
  const n = t.match(/\b(?:for|party of|group of|table for)\s+(\d{1,3})\b(?!\s*(?:am|pm|:\d))/) ?? t.match(/\b(\d{1,3})\s*(?:people|guests|pax|of us|ppl|attendees|folks|covers)\b/);
  if (n) return Number(n[1]);
  const w = t.match(/\b(?:for|party of|group of|table for|a)\s+(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty|dozen)\b/)
    ?? t.match(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty)\s+(?:people|guests|of us)\b/);
  return w ? WORDS[w[1]] : null;
}

function timeFrom(text: string, kind: EventKind): string {
  const m = text.toLowerCase().match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? text.toLowerCase().match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (m) {
    let h = Number(m[1]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (!m[3] && h < 11) h += 12; // "at 7" for a dinner means 7 pm
    return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
  }
  return kind === "client_lunch" ? "12:30" : kind === "happy_hour" ? "17:30" : "19:00";
}

/** The deterministic parser: always available, and the fallback when the model times out or is off. */
export function parseRules(text: string, today: string): BookingRequest {
  const t = text.toLowerCase();
  const kind: EventKind = /\blunch\b/.test(t) ? "client_lunch"
    : /happy hour|\bdrinks\b/.test(t) ? "happy_hour"
    : /\b(our|my) team\b|team dinner|offsite|team outing|celebrat/.test(t) && !/client|customer|prospect/.test(t) ? "team_dinner"
    : "client_dinner";
  const client = text.match(/\bwith (?:the )?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)?)(?:\s+(?:team|folks|group|execs|leadership|crew))?/);
  const clientName = client && !/^(Our|My|The|A|An|Some)$/.test(client[1]) ? client[1] : null;
  const perHead = t.match(/(?:under|below|max(?:imum)?|no more than|up to)\s+\$?(\d{2,4})\s*(?:\/|a|per)?\s*(?:head|person|pp|guest)/);
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
    maxPerHeadCents: perHead ? Number(perHead[1]) * 100 : null,
    dietary: DIETARY.filter((x) => t.includes(x)).map((x) => x.replace(" ", "-")),
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
  const request = BookingRequest.parse({
    ...base,
    partySize: partySize ?? 2,
    partySizeStated: partySize !== null,
    kind: v.kind,
    clientName: v.clientName,
    privateRoom: v.privateRoom,
    neighborhood: v.neighborhood?.toLowerCase() ?? base.neighborhood,
    cuisine: v.cuisine?.toLowerCase() ?? base.cuisine,
    maxPerHeadCents: v.maxPerHeadDollars !== null ? Math.round(v.maxPerHeadDollars * 100) : base.maxPerHeadCents,
    time: v.time24h ?? base.time,
    dietary: v.dietary,
    notes: v.notes,
  });
  return { request, decidedBy: "model", note: v.partySize !== partySize ? `model party size ${v.partySize} overruled` : null };
}
