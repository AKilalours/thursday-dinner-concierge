// A person standing in for a venue (the partner portal): the agent reads their email like any other.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";

async function play(reply: (w: VenueWorld, venueId: string, meta: { date: string; time: string; partySize: number; privateRoom: boolean }) => string | null, others: Behavior = "decline") {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  const world = new VenueWorld(venues, () => others, "2026-11-09T15:00:00.000Z");
  let asked = "";
  world.playFirstVenue(async (venueId, inquiry, meta) => { asked = inquiry.body; return reply(world, venueId, meta); });
  const actor = user("usr_priya");
  const res = await runConcierge({
    text: "private dinner for 10 with Globex next Friday", actor, principal: user("usr_dana"), today: "2026-11-09", store, venues, llm: offline, company: COMPANY, world, shortlistSize: 3,
    approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
  });
  return { res, world, asked };
}

describe("a person plays the venue", () => {
  it("their yes wins the booking when every other venue declines", async () => {
    const { res, world, asked } = await play((w, id, m) => w.draft(id, "accept", m));
    assert.match(asked, /10 guests/);
    assert.equal(res.outcome, "booked");
    assert.equal(res.chosenVenueId, world.playedVenue());
  });
  it("their no is respected, and silence gets a follow-up, never a booking", async () => {
    const no = await play((w, id, m) => w.draft(id, "decline", m));
    assert.notEqual(no.res.chosenVenueId, no.world.playedVenue());
    const silent = await play(() => null);
    assert.notEqual(silent.res.chosenVenueId, silent.world.playedVenue());
    assert.ok(silent.res.trace.some((e) => e.kind === "followed_up"));
  });
  it("a scam typed by the person is flagged, and money still only goes to the payee on file", async () => {
    const { res, world } = await play((w, id, m) => w.draft(id, "injection", m));
    assert.ok(res.trace.some((e) => e.kind === "injection_flagged"));
    if (res.paymentId) assert.equal(res.chosenVenueId, world.playedVenue());
    assert.ok(res.messagesToBooker.some((m) => /ignored/.test(m)));
  });
});
