// End-to-end runs of the concierge, on the memory store and (with ANDE_PSQL) on real Postgres.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { checkPolicy } from "../src/policy/policy.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { call, canActFor, ToolDenied } from "../src/tools/registry.ts";
import type { Ctx } from "../src/tools/registry.ts";
import { book } from "../src/tools/tools.ts";
import { storeFactories } from "./helpers.ts";

const venues = buildVenues();
const priya = user("usr_priya");
const TEXT = "dinner for 12 with the Acme team next Thursday, somewhere private";

async function run(make: () => Promise<any>, order: Behavior[] = []) {
  const store = await make();
  const seen = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z");
  const res = await runConcierge({ text: TEXT, actor: priya, principal: user("usr_dana"), today: "2026-11-09", store, world, llm: offline, venues, company: COMPANY,
    approver: carefulApprover(priya, { partySize: 12, date: "2026-11-12", privateRoom: true }) });
  return { store, world, res };
}

for (const [name, make] of storeFactories()) {
  describe(`concierge end to end: ${name}`, () => {
    it("books, pays the payee on file, and journals every step", async () => {
      const { store, res } = await run(make);
      assert.equal(res.outcome, "booked");
      assert.ok(res.bookingId);
      const steps = await store.steps(res.runId);
      assert.ok(steps.some((s: any) => s.kind === "proposed") && steps.some((s: any) => s.kind === "booked"));
      const audit = await store.auditLog(res.runId);
      assert.ok(audit.some((a: any) => a.action === "tool:book" && a.detail.consequential === true));
    });

    it("an injected email never changes who gets paid, and the booker is told", async () => {
      const { res } = await run(make, ["injection", "decline", "decline"]);
      assert.equal(res.outcome, "booked");
      assert.ok(res.messagesToBooker.some((m) => /ignored them/.test(m)));
      const dep = res.proposals.find((p) => p.kind === "pay_deposit");
      if (dep) assert.match(dep.payeeId!, /^payee_ven_/);
    });
  });
}

describe("acting on behalf of someone", () => {
  it("an EA may act for their executive; a colleague may not", () => {
    assert.equal(canActFor(user("usr_priya"), user("usr_dana")), true);
    assert.equal(canActFor(user("usr_sam"), user("usr_dana")), false);
  });
  it("tools refuse to run for a principal the actor cannot act for", async () => {
    const ctx = { actor: user("usr_sam"), principal: user("usr_dana") } as unknown as Ctx;
    await assert.rejects(call(ctx, "test", book, { proposalId: "x" }), ToolDenied);
  });
});

describe("policy", () => {
  const req = { partySize: 12, partySizeStated: true, date: "2026-11-12", dateAmbiguous: false, time: "19:00", kind: "client_dinner" as const, clientName: "Acme", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" };
  const v = venues[1];
  it("over the manager threshold needs a manager too", () => {
    const r = checkPolicy(COMPANY, { ...req, partySize: 20 }, v, { minSpendCents: 300_000, perHeadCents: null, depositPct: 20, capacity: null }, 72);
    assert.ok(r.requiredRoles.includes("manager"));
  });
  it("short notice and blocked venues are violations", () => {
    assert.ok(!checkPolicy(COMPANY, req, v, { minSpendCents: 100_000, perHeadCents: null, depositPct: 20, capacity: null }, 10).onPolicy);
    assert.ok(!checkPolicy(COMPANY, req, venues[19], { minSpendCents: 100_000, perHeadCents: null, depositPct: 20, capacity: null }, 72).onPolicy);
  });
});
