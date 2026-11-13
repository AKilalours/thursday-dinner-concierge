// 25 requests written the way real people type them, each with the outcome a person would expect.
// Shared by `npm run evals:users` and the scheduled monitor. No file system, no network.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Outcome } from "../src/domain/types.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";

export const TODAY = "2026-11-11";
export const REAL_USER_REQUESTS: [string, Outcome][] = [
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
  ["book dinner for 7 people next Thursday, 2 vegetarians and 1 gluten free", "booked"],
  ["need a place for 40 people on Dec 10 for a team offsite dinner", "booked"],
  ["breakfast meeting for 4 tomorrow at 8am", "escalated"],
  ["dinner for 10 with the Stark team, somewhere in Williamsburg, Nov 24", "booked"],
  ["dinner for 5 on 12/3", "booked"],
  ["korean bbq for 8 next Friday", "booked"],
  ["farewell dinner for Sam, 9 people, next Wednesday", "booked"],
  ["dinner for 6 under $60 a head this Friday", "needs_clarification"],
  ["dinner for 12 on Christmas Eve", "booked"],
];

export async function runUserRequest(text: string) {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  const actor = user("usr_priya");
  return runConcierge({
    text, actor, principal: user("usr_dana"), today: TODAY, store, venues, llm: offline, company: COMPANY,
    world: new VenueWorld(venues, () => "accept", `${TODAY}T15:00:00.000Z`),
    approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
  });
}
