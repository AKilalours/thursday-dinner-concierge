// Flexible nights: when the same private room lists a lower minimum on a nearby night, the proposal says how much less.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY } from "../data/seed.ts";
import { flexNight } from "../src/agents/concierge.ts";
import { parseRules } from "../src/parse/request.ts";
import { estimate, perHeadFor } from "../src/policy/policy.ts";
import type { Ctx } from "../src/tools/registry.ts";

const ctx = { world: { now: "2026-11-09T15:00:00.000Z" }, company: COMPANY } as unknown as Ctx;
const venues = buildVenues();

describe("flexible nights", () => {
  it("a private room on a Saturday points to a cheaper weeknight in the same room, with the saving", () => {
    const req = parseRules("private dinner for 12 on Saturday Nov 14", "2026-11-09");
    const v = venues.find((x) => x.rooms.some((r) => r.private && r.listedCapacity >= 12) && !x.closedDays.length)!;
    const room = v.rooms.find((r) => r.private && r.listedCapacity >= 12)!;
    const all = estimate(12, perHeadFor(v, req.kind), room.minSpendCents[6], v.preferredRatePct).allInCents;
    const note = flexNight(ctx, req, v, room, all);
    assert.match(note, new RegExp(`^Flexible on the date\\? ${room.name} on (Mon|Tue|Wed|Thu) .* lists a lower minimum: about \\$[\\d,]+ less all-in`));
  });
  it("says nothing for the dining room, or when no nearby night is cheaper enough", () => {
    const req = parseRules("dinner for 6 on Wednesday Nov 11", "2026-11-09");
    const v = venues[0], main = v.rooms.find((r) => !r.private)!, pdr = v.rooms.find((r) => r.private)!;
    assert.equal(flexNight(ctx, req, v, main, 100_000), "");
    const wed = estimate(6, perHeadFor(v, req.kind), pdr.minSpendCents[3], v.preferredRatePct).allInCents;
    assert.equal(flexNight(ctx, req, v, pdr, wed), "", "Wednesday is already the low-minimum night");
  });
  it("never suggests a night inside the notice window", () => {
    const req = parseRules("private dinner for 12 on Friday Nov 13", "2026-11-09");
    const near = { ...ctx, world: { now: "2026-11-12T15:00:00.000Z" } } as unknown as Ctx;
    const v = venues.find((x) => x.rooms.some((r) => r.private && r.listedCapacity >= 12) && !x.closedDays.length)!, room = v.rooms.find((r) => r.private && r.listedCapacity >= 12)!;
    const note = flexNight(near, req, v, room, estimate(12, perHeadFor(v, req.kind), room.minSpendCents[5], v.preferredRatePct).allInCents);
    assert.ok(!/Thu Nov 12|Wed Nov 11|Tue Nov 10/.test(note), note);
  });
});
