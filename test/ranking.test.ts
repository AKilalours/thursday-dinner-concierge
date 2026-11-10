import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { source } from "../src/agents/sourcing.ts";
import type { BookingRequest, Offer } from "../src/domain/types.ts";
import { offline } from "../src/llm/client.ts";
import { factsFrom, knowledge } from "../src/memory/supply.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { TraceEvent } from "../src/tools/registry.ts";
import { runRanking } from "../evals/ranking.ts";

const venues = buildVenues();
const v29 = venues.find((v) => v.id === "ven_29")!; // Wine Cellar seats 16, Garden Room seats 8
const WED = 3;
const reply: Message = { id: "m1", threadId: "t1", venueId: "ven_29", direction: "in", at: "2026-11-09T18:00:00.000Z", subject: "Re", body: "Happy to hold the Wine Cellar." };
const offer: Offer = { venueId: "ven_29", available: true, roomName: "Wine Cellar", date: "2026-12-09", time: "19:00", capacity: 16, minSpendCents: 218000, perHeadCents: null, depositPct: 20, holdExpiresHours: 48, contractRequired: false, requestedPaymentDestination: null, alternativeDates: [], sourceMessageId: "m1" };
const req: BookingRequest = { partySize: 6, partySizeStated: true, date: "2026-12-09", dateAmbiguous: false, time: "19:00", kind: "client_dinner", clientName: "Initech", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" };

async function ctxWithQuote(legacy?: { r11?: boolean }) {
  const store = new MemoryStore(); await store.init(venues);
  for (const f of factsFrom(v29, reply, offer, "2026-11-09T15:00:00.000Z", WED, {})) await store.addFact({ venueId: v29.id, ...f });
  return { store, world: new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z"), llm: offline, company: COMPANY, venues, actor: user("usr_priya"), principal: user("usr_dana"), runId: "r", today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] as TraceEvent[], legacy };
}

describe("memory and ranking", () => {
  it("regression R11: a quote is remembered for the room it was for, not the whole venue", async () => {
    const ctx = await ctxWithQuote();
    const k = await knowledge(ctx.store, "ven_29");
    assert.equal(k.quotedMin.get(`ven_29_pdr:${WED}`), 218000);
    assert.equal(k.quotedMin.get(`ven_29_pdr2:${WED}`), undefined);
    assert.ok((await source(ctx, req, new Set())).some((c) => c.venue.id === "ven_29" && c.roomId === "ven_29_pdr2"), "the 8-seat room keeps its own minimum");
  });
  it("the pre-fix path really dropped the venue as over budget (so the test above means something)", async () => {
    assert.ok(!(await source(await ctxWithQuote({ r11: true }), req, new Set())).some((c) => c.venue.id === "ven_29"));
  });
  it("an offer made as asked counts for the venue next time", async () => {
    const k = await knowledge((await ctxWithQuote()).store, "ven_29");
    assert.equal(k.offers, 1);
  });
  it("memory never makes a shortlist worse than no memory, and improves the first choice", async () => {
    const r = await runRanking(offline, { seed: 7 });
    assert.equal(r.hurt, 0);
    assert.ok(r.warm.mrr > r.cold.mrr, `warm ${r.warm.mrr} vs cold ${r.cold.mrr}`);
  });
});
