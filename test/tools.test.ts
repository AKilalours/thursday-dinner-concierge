import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { call } from "../src/tools/registry.ts";
import type { TraceEvent } from "../src/tools/registry.ts";
import { amendBooking, book, cancelBooking, createProposal } from "../src/tools/tools.ts";

async function setup() {
  const now = "2026-11-09T15:00:00.000Z";
  const venues = buildVenues(), store = new MemoryStore(); await store.init(venues); store.setNow(now);
  const priya = user("usr_priya"), dana = user("usr_dana"), world = new VenueWorld(venues, () => "accept", now);
  await store.createRun({ id: "r1" });
  const ctx = { store, world, llm: offline, company: COMPANY, venues, actor: priya, principal: dana, runId: "r1", today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] as TraceEvent[] };
  const v = venues.find((x) => x.rooms.some((r) => r.private && r.listedCapacity >= 12))!, room = v.rooms.find((r) => r.private && r.listedCapacity >= 12)!;
  const base = { runId: "r1", actorId: priya.id, principalId: dana.id, venueId: v.id, roomId: room.id, startsAt: "2026-11-12T00:00:00.000Z", endsAt: "2026-11-12T03:00:00.000Z", partySize: 12, amountCents: 200_000, payeeId: null, requiredRoles: ["booker" as const], summary: "s", expiresAt: "2026-11-11T23:00:00.000Z" };
  const { proposalId } = await call(ctx, "t", createProposal, { ...base, kind: "book" });
  await store.decide(proposalId, priya.id, "booker", "approve");
  const { bookingId } = await call(ctx, "t", book, { proposalId });
  return { ctx, store, base, bookingId, priya, v };
}

describe("typed tools: changes after booking", () => {
  it("amend_booking refuses until the change is approved, then swaps the booking", async () => {
    const { ctx, store, base, bookingId, priya } = await setup();
    const { proposalId } = await call(ctx, "t", createProposal, { ...base, kind: "amend", partySize: 14, replacesBookingId: bookingId });
    await assert.rejects(call(ctx, "t", amendBooking, { proposalId }), /approved/);
    await store.decide(proposalId, priya.id, "booker", "approve");
    const out = await call(ctx, "t", amendBooking, { proposalId }, "amend-2");
    assert.equal(out.replaced, bookingId);
    assert.equal((await store.getBooking(bookingId))!.status, "cancelled");
    assert.equal((await store.getBooking(out.bookingId))!.partySize, 14);
  });
  it("cancel_booking reports a refundable deposit inside the venue's window and a forfeited one after it", async () => {
    for (const [now, refundable] of [["2026-11-09T15:00:00.000Z", true], ["2026-11-11T20:00:00.000Z", false]] as const) {
      const { ctx, store, base, bookingId, priya } = await setup();
      store.setNow(now); ctx.world.now = now;
      const { proposalId } = await call(ctx, "t", createProposal, { ...base, kind: "cancel", replacesBookingId: bookingId });
      await store.decide(proposalId, priya.id, "booker", "approve");
      const out = await call(ctx, "t", cancelBooking, { proposalId });
      assert.equal(out.depositRefundable, refundable);
      assert.equal((await store.getBooking(bookingId))!.status, "cancelled");
    }
  });
});
