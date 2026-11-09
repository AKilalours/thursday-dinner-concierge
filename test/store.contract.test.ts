// The safety rules, tested identically against the in-memory store and real Postgres.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreError } from "../src/store/store.ts";
import type { Store } from "../src/store/store.ts";
import { proposal, storeFactories } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof StoreError && e.code === c;

async function fresh(make: () => Promise<Store>) {
  const s = await make();
  s.setNow("2026-11-09T15:00:00.000Z");
  await s.createRun({ id: "run_1", actorId: "usr_priya", principalId: "usr_dana", requestText: "dinner for 12" });
  return s;
}

const booking = { id: "bk_1", proposalId: "prop_1", venueId: "ven_02", roomId: "ven_02_pdr",
  startsAt: "2026-11-12T23:30:00.000Z", endsAt: "2026-11-13T02:30:00.000Z", partySize: 12 };

for (const [name, make] of storeFactories()) {
  describe(`store contract: ${name}`, () => {
    it("cannot book without an approved proposal", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await assert.rejects(s.book(booking), code("not_approved"));
    });

    it("the agent cannot approve its own proposal", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await assert.rejects(s.decide("prop_1", "agent", "booker", "approve"), code("agent_cannot_approve"));
    });

    it("needs every required role before it counts as approved", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal({ requiredRoles: ["booker", "manager"], amountCents: 400_000 }));
      let p = await s.decide("prop_1", "usr_priya", "booker", "approve");
      assert.equal(p.status, "pending");
      await assert.rejects(s.book(booking), code("not_approved"));
      p = await s.decide("prop_1", "usr_marcus", "manager", "approve");
      assert.equal(p.status, "approved");
      await s.book(booking);
    });

    it("rejects an approval from a role the proposal does not need", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await assert.rejects(s.decide("prop_1", "usr_jordan", "finance", "approve"), code("role_not_required"));
    });

    it("a booking must match exactly what the booker approved", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await assert.rejects(s.book({ ...booking, partySize: 14 }), code("mismatch"));
      await assert.rejects(s.book({ ...booking, roomId: "ven_02_main" }), code("mismatch"));
    });

    it("an expired approval cannot be used", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      s.setNow("2026-11-11T01:00:00.000Z");
      await assert.rejects(s.book(booking), code("expired"));
    });

    it("never double-books a room", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      await s.createProposal(proposal({ id: "prop_2" }));
      await s.decide("prop_2", "usr_sam", "booker", "approve");
      await assert.rejects(s.book({ ...booking, id: "bk_2", proposalId: "prop_2" }), code("double_booked"));
    });

    it("pays only the venue's payee on file, at most the approved amount, once", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      await s.createProposal(proposal({ id: "prop_pay", kind: "pay_deposit", amountCents: 36_000, payeeId: "payee_ven_02" }));
      await s.decide("prop_pay", "usr_priya", "booker", "approve");
      const pay = { id: "pay_1", idempotencyKey: "k1", proposalId: "prop_pay", bookingId: "bk_1", payeeId: "payee_ven_02", amountCents: 36_000 };
      await assert.rejects(s.pay({ ...pay, payeeId: "attacker_account" }), code("payee_mismatch"));
      await assert.rejects(s.pay({ ...pay, amountCents: 99_000 }), code("over_amount"));
      await s.pay(pay);
      await s.pay(pay); // retried with the same key: no second payment, no error
    });

    it("a payment proposal naming another payee is refused even if approved", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      await s.createProposal(proposal({ id: "prop_pay", kind: "pay_deposit", amountCents: 36_000, payeeId: "attacker_account" }));
      await s.decide("prop_pay", "usr_priya", "booker", "approve");
      await assert.rejects(s.pay({ id: "pay_1", idempotencyKey: "k1", proposalId: "prop_pay", bookingId: "bk_1", payeeId: "payee_ven_02", amountCents: 36_000 }), code("payee_mismatch"));
    });

    it("private memories are visible only to their owner", async () => {
      const s = await fresh(make);
      await s.remember({ companyId: "co_northwind", scope: "private", ownerUserId: "usr_priya", subject: "usr_dana", fact: "Dana prefers a quiet corner", source: "chat" });
      await s.remember({ companyId: "co_northwind", scope: "company", ownerUserId: "usr_priya", subject: "Acme", fact: "Acme's CFO is vegetarian", source: "chat" });
      assert.equal((await s.recall("co_northwind", "usr_priya")).length, 2);
      const sam = await s.recall("co_northwind", "usr_sam");
      assert.deepEqual(sam.map((m) => m.fact), ["Acme's CFO is vegetarian"]);
      assert.equal((await s.recall("co_other", "usr_priya")).length, 0);
    });

    it("keeps an ordered step journal and dedupes tool calls", async () => {
      const s = await fresh(make);
      await s.appendStep("run_1", "concierge", "parsed", { partySize: 12 });
      await s.appendStep("run_1", "sourcing", "searched", { n: 5 });
      assert.deepEqual((await s.steps("run_1")).map((x) => x.seq), [1, 2]);
      await s.saveToolCall({ key: "k", runId: "run_1", tool: "search_venues", actorId: "a", principalId: "p", input: {}, output: { first: true } });
      await s.saveToolCall({ key: "k", runId: "run_1", tool: "search_venues", actorId: "a", principalId: "p", input: {}, output: { first: false } });
      assert.deepEqual((await s.findToolCall("k"))?.output, { first: true });
    });
    it("an amendment needs approval, swaps the booking atomically, and frees the old slot", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      const later = { startsAt: "2026-11-13T00:30:00.000Z", endsAt: "2026-11-13T03:30:00.000Z" };
      await s.createProposal(proposal({ id: "prop_amend", kind: "amend", partySize: 14, ...later, replacesBookingId: "bk_1" }));
      await assert.rejects(s.amend("prop_amend", "bk_2"), code("not_approved"));
      await s.decide("prop_amend", "usr_priya", "booker", "approve");
      await s.amend("prop_amend", "bk_2");
      assert.equal((await s.getBooking("bk_1"))!.status, "cancelled");
      const nb = (await s.getBooking("bk_2"))!;
      assert.equal(nb.status, "confirmed"); assert.equal(nb.partySize, 14);
    });

    it("a failed amendment rolls back and the original booking survives", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      // Someone else holds the room at the new time.
      const other = { startsAt: "2026-11-14T00:00:00.000Z", endsAt: "2026-11-14T03:00:00.000Z" };
      await s.createProposal(proposal({ id: "prop_o", ...other }));
      await s.decide("prop_o", "usr_sam", "booker", "approve");
      await s.book({ ...booking, id: "bk_o", proposalId: "prop_o", ...other });
      await s.createProposal(proposal({ id: "prop_amend", kind: "amend", ...other, replacesBookingId: "bk_1" }));
      await s.decide("prop_amend", "usr_priya", "booker", "approve");
      await assert.rejects(s.amend("prop_amend", "bk_2"), code("double_booked"));
      assert.equal((await s.getBooking("bk_1"))!.status, "confirmed");
      assert.equal(await s.getBooking("bk_2"), null);
    });

    it("a cancellation needs its own approval and frees the room", async () => {
      const s = await fresh(make);
      await s.createProposal(proposal());
      await s.decide("prop_1", "usr_priya", "booker", "approve");
      await s.book(booking);
      await s.createProposal(proposal({ id: "prop_cancel", kind: "cancel", replacesBookingId: "bk_1" }));
      await assert.rejects(s.cancel("prop_cancel"), code("not_approved"));
      await s.decide("prop_cancel", "usr_priya", "booker", "approve");
      await s.cancel("prop_cancel");
      assert.equal((await s.getBooking("bk_1"))!.status, "cancelled");
      await s.createProposal(proposal({ id: "prop_3" }));
      await s.decide("prop_3", "usr_sam", "booker", "approve");
      await s.book({ ...booking, id: "bk_3", proposalId: "prop_3" });
    });
  });
}
