import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";

async function run(text: string, legacy?: { r12?: boolean }) {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  const actor = user("usr_priya");
  return runConcierge({
    text, actor, principal: user("usr_dana"), today: "2026-11-09", store, venues, llm: offline, company: COMPANY, legacy,
    world: new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z"),
    approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
  });
}

describe("a private room that can't fit the cap", () => {
  it("regression R12: 'dinner for 2, somewhere private' books a quiet table and says why, with the number", async () => {
    const r = await run("dinner for 2 next Friday, somewhere private");
    assert.equal(r.outcome, "booked");
    const proposal = r.messagesToBooker.find((m) => /Reply approve or reject/.test(m))!;
    assert.match(proposal, /quiet table/);
    assert.match(proposal, /a head for 2, over the \$250 cap/);
  });
  it("the pre-fix path really emailed nobody and escalated (so the test above means something)", async () => {
    const r = await run("dinner for 2 next Friday, somewhere private", { r12: true });
    assert.equal(r.outcome, "escalated");
  });
  it("never says 'I contacted 0 venues'", async () => {
    const r = await run("dinner for 2 next Friday, somewhere private", { r12: true });
    assert.ok(!r.messagesToBooker.some((m) => /contacted 0 venues/.test(m)), r.messagesToBooker.join(" | "));
  });
});
