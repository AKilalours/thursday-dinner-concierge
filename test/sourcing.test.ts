import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { source } from "../src/agents/sourcing.ts";
import type { BookingRequest } from "../src/domain/types.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

async function ctxFor(legacy?: { r10?: boolean }) {
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues);
  return { store, world: new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z"), llm: offline, company: COMPANY, venues, actor: user("usr_priya"), principal: user("usr_dana"), runId: "r", today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] as TraceEvent[], legacy };
}
const req = (neighborhood: string | null): BookingRequest => ({ partySize: 10, partySizeStated: true, date: "2026-11-13", dateAmbiguous: false, time: "19:00", kind: "client_dinner", clientName: "Globex", privateRoom: true, neighborhood, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" });
const NEAR_SOHO = ["soho", "tribeca", "west village", "flatiron"];

describe("sourcing: a named neighborhood", () => {
  it("regression R10: the model's 'SoHo' matches venues in 'soho', and only SoHo or next door is shortlisted", async () => {
    const out = await source(await ctxFor(), req("SoHo"), new Set());
    assert.ok(out.length > 0);
    for (const c of out) assert.ok(NEAR_SOHO.includes(c.venue.neighborhood.toLowerCase()), `${c.venue.name} is in ${c.venue.neighborhood}`);
    assert.equal(out[0].venue.neighborhood.toLowerCase() === "soho" || NEAR_SOHO.includes(out[0].venue.neighborhood.toLowerCase()), true);
  });
  it("the pre-fix path really did shortlist far-away venues (so the test above means something)", async () => {
    const out = await source(await ctxFor({ r10: true }), req("SoHo"), new Set());
    assert.ok(out.some((c) => !NEAR_SOHO.includes(c.venue.neighborhood.toLowerCase())));
  });
  it("no neighborhood: every area stays in play", async () => {
    const out = await source(await ctxFor(), req(null), new Set());
    assert.ok(new Set(out.map((c) => c.venue.neighborhood)).size > 3);
  });
});
