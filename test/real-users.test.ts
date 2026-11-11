// Bugs found by using the app the way a real booker would (R12-R15). Each has a test that fails on the old path.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { resolveDate } from "../src/time.ts";

async function run(text: string, today: string, legacy?: { r13?: boolean; r15?: boolean }) {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  const actor = user("usr_priya");
  return runConcierge({
    text, actor, principal: user("usr_dana"), today, store, venues, llm: offline, company: COMPANY, legacy,
    world: new VenueWorld(venues, () => "accept", `${today}T15:00:00.000Z`),
    approver: async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: false })(p, s),
  });
}

describe("found by testing as real users", () => {
  it("R13: notice is measured from when the booker asked, not when venues reply", async () => {
    assert.equal((await run("lunch with a client tomorrow, 3 people", "2026-11-11")).outcome, "booked");
    assert.equal((await run("lunch with a client tomorrow, 3 people", "2026-11-11", { r13: true })).outcome, "escalated", "the old path emailed venues for nothing");
  });
  it("R13: under 24 h is still escalated before any venue is emailed", async () => {
    const r = await run("dinner for 6 with Acme tonight", "2026-11-11");
    assert.equal(r.outcome, "escalated");
    assert.ok(!r.trace.some((e) => e.agent === "coordination"), "no venue should be contacted");
  });
  it("R14: US month/day and holiday evenings resolve to a date", () => {
    assert.equal(resolveDate("dinner for 5 on 12/3", "2026-11-11").date, "2026-12-03");
    assert.equal(resolveDate("dinner on 1/15", "2026-11-11").date, "2027-01-15");
    assert.equal(resolveDate("dinner for 12 on Christmas Eve", "2026-11-11").date, "2026-12-24");
    assert.equal(resolveDate("support 24/7", "2026-11-11").date, null);
    assert.equal(resolveDate("under $90/head on Dec 3", "2026-11-11").date, "2026-12-03");
  });
  it("R15: a budget nothing meets gets the closest real price, not a dead end", async () => {
    const r = await run("dinner for 6 under $60 a head this Friday", "2026-11-11");
    assert.equal(r.outcome, "needs_clarification");
    assert.match(r.messagesToBooker.at(-1)!, /Closest is .+ at about \$\d+ a head all-in/);
    assert.equal((await run("dinner for 6 under $60 a head this Friday", "2026-11-11", { r15: true })).outcome, "escalated");
  });
});
