import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues } from "../data/seed.ts";
import type { LLM } from "../src/llm/client.ts";
import { offline } from "../src/llm/client.ts";
import { extractOffer, extractRules, OFFER_KEYS, offerSystemPrompt } from "../src/parse/offer.ts";
import { parseRequest, parseRules } from "../src/parse/request.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior } from "../src/sim/world.ts";
import { resolveDate } from "../src/time.ts";

const MON = "2026-11-09";
const fake = (text: string): LLM => ({ mode: "live", async complete() { return { text, inputTokens: 1, outputTokens: 1, model: "fake" }; } });

describe("dates", () => {
  it("'next Thursday' on a Monday is this week's Thursday, flagged as ambiguous", () => assert.deepEqual(resolveDate("next Thursday", MON), { date: "2026-11-12", ambiguous: true, reason: "'next' could mean this week or next" }));
  it("'next Monday' on a Monday is a week out and not ambiguous", () => assert.equal(resolveDate("next Monday", MON).date, "2026-11-16"));
  it("a month and day in the past rolls to next year", () => assert.equal(resolveDate("Jan 5", MON).date, "2027-01-05"));
  it("tomorrow", () => assert.equal(resolveDate("tomorrow", MON).date, "2026-11-10"));
  it("no date is reported, not guessed", () => assert.equal(resolveDate("next week sometime", MON).date, null));
});

describe("request parsing (rules)", () => {
  it("the canonical request", () => {
    const r = parseRules("dinner for 12 with the Acme team next Thursday, somewhere private", MON);
    assert.equal(r.partySize, 12); assert.equal(r.date, "2026-11-12"); assert.equal(r.privateRoom, true);
    assert.equal(r.clientName, "Acme"); assert.equal(r.kind, "client_dinner"); assert.equal(r.time, "19:00");
  });
  it("words, times, budgets and dietary needs", () => {
    const r = parseRules("dinner for a dozen with Umbrella on Nov 18 at 7:30pm, under $150 a head, two vegetarians", MON);
    assert.equal(r.partySize, 12); assert.equal(r.time, "19:30"); assert.equal(r.maxPerHeadCents, 15_000); assert.deepEqual(r.dietary, ["vegetarian"]);
  });
  it("a team dinner has no client", () => {
    const r = parseRules("team dinner for 8 on Nov 20", MON);
    assert.equal(r.kind, "team_dinner"); assert.equal(r.clientName, null);
  });
  it("a missing headcount is reported", () => assert.equal(parseRules("private dinner with Acme next Thursday", MON).partySizeStated, false));
});

describe("request parsing (model, checked by code)", () => {
  const out = (partySize: number | null) => JSON.stringify({ partySize, kind: "client_dinner", clientName: "Acme", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadDollars: null, time24h: null, dietary: [], notes: "" });
  it("uses the model when it agrees with the sentence", async () => {
    const r = await parseRequest(fake(out(12)), "dinner for 12 with Acme next Thursday, private", MON);
    assert.equal(r.decidedBy, "model"); assert.equal(r.request.partySize, 12);
  });
  it("overrules a model that invents a different headcount", async () => {
    const r = await parseRequest(fake(out(20)), "dinner for 12 with Acme next Thursday, private", MON);
    assert.equal(r.request.partySize, 12); assert.match(r.note!, /overruled/);
  });
  it("falls back to rules when the model is off", async () => {
    assert.equal((await parseRequest(offline, "dinner for 12 with Acme next Thursday", MON)).decidedBy, "rules");
  });
});

describe("offer extraction against every simulated email style", () => {
  const venues = buildVenues();
  const meta = { date: "2026-11-12", time: "19:00", partySize: 12, privateRoom: true };
  const emails = (b: Behavior, seed: number) => {
    const w = new VenueWorld(venues, () => b, "2026-11-09T15:00:00.000Z", seed);
    w.send("ven_02", "t", "Inquiry", "hello there, inquiry", "inquiry", meta);
    return w.advance(12);
  };
  for (let seed = 1; seed <= 12; seed++) {
    it(`accept email, wording seed ${seed}: room, minimum, deposit`, () => {
      const [m] = emails("accept", seed);
      const o = extractRules(m.body, venues[1], m.id, MON, true);
      assert.ok(o.roomName, "room");
      assert.ok(o.minSpendCents && o.minSpendCents > 0, "minimum");
      assert.equal(o.depositPct, venues[1].depositPct);
    });
  }
  it("a raised minimum reads the new number, not the listed one", () => {
    const [m] = emails("counter_price", 3);
    const listed = venues[1].rooms.find((r) => r.private)!.minSpendCents[4];
    assert.ok(extractRules(m.body, venues[1], m.id, MON, true).minSpendCents! > listed);
  });
  it("injected bank details are captured as data, for flagging", () => {
    const [m] = emails("injection", 2);
    assert.equal(extractRules(m.body, venues[1], m.id, MON, true).requestedPaymentDestination, "4400187733");
  });
  it("regression R2: a semi-private counter does not report the tight room's capacity", () => {
    const [m] = emails("counter_capacity", 2);
    const o = extractRules(m.body, venues[1], m.id, MON, true);
    assert.equal(o.roomName, "Main dining room"); assert.equal(o.capacity, null);
  });
  it("regression R6: the extraction prompt names every key the schema requires", () => {
    const prompt = offerSystemPrompt(venues[1], MON);
    for (const k of OFFER_KEYS) assert.ok(prompt.includes(`"${k}"`), `prompt is missing ${k}`);
  });
  it("a model amount that is not in the email is replaced by the rules' amount", async () => {
    const [m] = emails("accept", 5);
    const rules = extractRules(m.body, venues[1], m.id, MON, true);
    const lie = JSON.stringify({ ...rules, minSpendCents: 1, venueId: undefined, sourceMessageId: undefined });
    const r = await extractOffer(fake(lie), m.body, venues[1], m.id, MON, true);
    assert.equal(r.offer.minSpendCents, rules.minSpendCents); assert.match(r.note!, /not in the email/);
  });
});
