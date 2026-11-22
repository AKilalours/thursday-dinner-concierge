// Requests written the way real people type them, each with the outcome a person would expect.
// Shared by `npm run evals:users` and the scheduled monitor. No file system, no network.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Outcome } from "../src/domain/types.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Ctx } from "../src/tools/registry.ts";
import { REPORTED } from "./reported.ts";

export const TODAY = "2026-11-11";
/** [what they typed, the outcome a person expects, optionally something the booker must be told]. */
export type UserRow = [string, Outcome, RegExp?];
const TYPED: UserRow[] = [
  ["dinner for 2 next Friday, somewhere private", "booked"],
  ["lunch with a client tomorrow, 3 people", "booked"],
  ["book a table for 5 on Saturday night", "booked"],
  ["team dinner for 15 next Wednesday", "booked"],
  ["anniversary dinner for 2 on Dec 12, something nice", "booked"],
  ["dinner for 6 with Acme on Monday at 8", "booked"],
  ["drinks after work for 10 people this Thursday", "booked"],
  ["happy hour for 25 on Friday", "booked"],
  ["team lunch for 12 next Tuesday near the office", "booked"],
  ["client dinner for 4 with Globex, Italian, next Thursday", "booked"],
  ["sushi dinner for 3 on Nov 20", "booked"],
  ["dinner for 30 people for our holiday party on Dec 17", "booked"],
  ["private dinner for 8 with Initech next Friday in Chelsea", "booked"],
  ["dinner for two tonight", "escalated"],
  ["dinner for 4 at 9pm on Nov 19", "booked"],
  ["steak dinner for 6 with Hooli on Dec 1, private room", "booked"],
  ["book dinner for 7 people next Thursday, 2 vegetarians and 1 gluten free", "booked", /vegetarian.*gluten|gluten.*vegetarian/i],
  ["need a place for 40 people on Dec 10 for a team offsite dinner", "booked"],
  ["breakfast meeting for 4 tomorrow at 8am", "escalated"],
  ["dinner for 10 with the Stark team, somewhere in Williamsburg, Nov 24", "booked"],
  ["dinner for 5 on 12/3", "booked"],
  ["korean bbq for 8 next Friday", "booked", /Korean, as asked/],
  ["farewell dinner for Sam, 9 people, next Wednesday", "booked"],
  ["dinner for 6 under $60 a head this Friday", "needs_clarification"],
  ["dinner for 12 on Christmas Eve", "booked"],
  ["dinner for 6 around 7 on Friday", "booked"],
  ["diner for 5 on friday", "booked"],
  ["dinner for a dozen next Friday", "booked"],
  ["dinner for 4 tmrw at 7", "booked"],
  ["lunch for 6 on Wed", "booked"],
  ["dinner for 4, sat at 8", "booked"],
  ["dinner for 5 next fri around 7pm", "booked"],
  ["team dinner for 9 on Thursday the 19th", "booked"],
  ["dinner for me and 3 clients next Thursday", "booked"],
  ["lunch for myself and 5 people on Dec 2", "booked"],
  ["dinner for 6, $50pp, this Friday", "needs_clarification"],
  ["dinner for 4 next Thursday, 40 per person", "needs_clarification"],
  ["client dinner for 4 with Globex on Dec 2, $150pp", "booked"],
  ["team dinner for 8 on Dec 3, budget $120 per person", "booked"],
  ["lunch for 3 next Tuesday, 80pp", "booked"],
  ["dinner for 4 on Friday at 7.30pm", "booked"],
  ["lunch for 4 at noon on Friday", "booked"],
  ["dinner for 4 on Friday, no shellfish", "booked"],
  ["lunch for 5 on Dec 2, one is allergic to nuts and one is dairy free", "booked"],
  ["drinks for 8 on Friday around 6", "booked", /at 6 pm/],
  ["dinner for 4 on Friday, 8ish", "booked", /at 8 pm/],
  ["dinner for 4 on Dec 3 about 7:30ish", "booked", /at 7:30 pm/],
  ["dinner for 6 next Fri at half past 7", "booked", /at 7:30 pm/],
  ["dinner for 4 on Friday at quarter to 8", "booked", /at 7:45 pm/],
  ["dinner for 6 this Friday, $300 total", "needs_clarification"],
  ["team dinner for 8 on Dec 3, budget 2k", "booked"],
  ["dinner for 10 on Dec 2, $1,500 all in", "booked"],
  ["dinner for me, Sam and Priya on Friday", "booked", /Fri Nov 13 at 7 pm, 3 guests/],
  ["drinks for me, Sam, Priya and Lee on Dec 3", "booked", /4 guests/],
  ["dinner for me and my boss on Friday", "booked", /2 guests/],
  ["lunch for me and a client on Dec 3", "booked", /2 guests/],
  ["dinner for 4 on 3 Dec at 7", "booked", /Thu Dec 3 at 7 pm, 4 guests/],
  ["dinner for 4 on Sept 31 at 7", "needs_clarification", /Which date/],
  ["lunch for 6 on 2/30", "needs_clarification", /Which date/],
  ["team lunch for 8 on the 10th of December", "booked", /Dec 10/],
  ["dinner for 6 the day after tomorrow", "booked", /Fri Nov 13 at 7 pm, 6 guests/],
  ["lunch for 3 day after tmrw at noon", "booked", /Fri Nov 13 at 12 pm, 3 guests/],
  ["dinner for 4 a week from today", "booked", /Wed Nov 18 at 7 pm, 4 guests/],
  ["lunch for 3 in 3 days", "booked", /Sat Nov 14/],
  ["drinks for 8 a week from Friday at 6", "booked", /Fri Nov 20 at 6 pm, 8 guests/],
  // Checked for what the booker is told, not just the outcome: the cuisine and dietary needs must be confirmed back.
  ["japanese dinner for 4 next Thursday", "booked", /Japanese, as asked/],
  ["dinner for 6 in SoHo next Friday", "booked", /Kiso House|Nakamura Counter|Fenwick Chophouse|Hollow Oak Tavern/],
  ["dinner for 5 on Dec 3, two of us are vegetarian", "booked", /Dietary needs sent to .*vegetarian/],
  ["dinner for 4 next thursday, one guest has a nut allergy", "booked", /Dietary needs sent to .*nut/],
  ["team dinner for 8 in the West Village on Dec 10", "booked", /Halden & Vine|Juniper Hall|The Velvet Ledger|Rue Margaux/],
  ["thai food for 6 next wednesday", "needs_clarification", /No venue in the network serves Thai/],
  ["mexican dinner for 10 on Dec 4", "needs_clarification", /serves Mexican/],
  ["team lunch for 12 on Dec 2, $40 a head", "booked", /before tax and tip, within your \$40/],
];

/** Typed by me and testers, plus every sentence real people reported from the app (evals/reported.ts). */
export const REAL_USER_REQUESTS: UserRow[] = [...TYPED, ...REPORTED.map(([t, o, m]) => [t, o, m] as UserRow)];

/** Runs one row and says why it failed, or null. Shared by the sweep, the monitor, the bug replay and the tests. */
export async function checkUserRow([text, want, mustSay]: UserRow, legacy?: Ctx["legacy"]): Promise<{ outcome: Outcome; why: string | null; last: string | undefined }> {
  const r = await runUserRequest(text, legacy);
  const said = r.messagesToBooker.join("\n");
  const why = r.outcome !== want ? `${r.outcome}, expected ${want}` : mustSay && !mustSay.test(said) ? `never told the booker ${mustSay}` : null;
  return { outcome: r.outcome, why, last: r.messagesToBooker.at(-1) };
}

export async function runUserRequest(text: string, legacy?: Ctx["legacy"]) {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  const actor = user("usr_priya");
  return runConcierge({
    text, actor, principal: user("usr_dana"), today: TODAY, store, venues, llm: offline, company: COMPANY, legacy,
    world: new VenueWorld(venues, () => "accept", `${TODAY}T15:00:00.000Z`),
    approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
  });
}
