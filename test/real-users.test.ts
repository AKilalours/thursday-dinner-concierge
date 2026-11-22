// Bugs found by using the app the way a real booker would (R12-R15, R18, R19, R29, R30, R33, R34, R35, R36). Each has a test that fails on the old path.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { parseRules, partySizeFrom } from "../src/parse/request.ts";
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
  it("R33: day-first dates (\"3 Dec\", \"the 3rd of Jan\") resolve; a headcount before a month is not a day", async () => {
    const d = (text: string) => resolveDate(text, "2026-11-11").date;
    assert.equal(d("dinner for 4 on 3 Dec"), "2026-12-03");
    assert.equal(d("dinner on 3rd December at 7"), "2026-12-03");
    assert.equal(d("lunch on the 3rd of Jan"), "2027-01-03", "was the next 3rd (Dec 3)");
    assert.equal(d("dinner for 4 on 3 Dec 7 pm"), "2026-12-03", "not Dec 7");
    assert.equal(d("dinner for 4 Dec 3"), "2026-12-03", "4 is the headcount");
    assert.equal(d("dinner on 31 Sept"), null, "no such day: asked");
    const r = await run("dinner for 4 on 3 Dec", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.equal(r.request?.date, "2026-12-03");
    assert.equal(r.request?.partySize, 4);
  });
  it("R34: a day the calendar doesn't have (\"Sept 31\", \"Feb 30\", \"2/30\") is asked about, not booked", async () => {
    const d = (text: string) => resolveDate(text, "2026-11-11");
    assert.deepEqual(d("dinner on Sept 31"), { date: null, ambiguous: true, reason: "no such day" }, "was 2027-09-31");
    assert.equal(d("dinner on Feb 30").date, null);
    assert.equal(d("dinner on 2/30").date, null);
    assert.equal(d("dinner on 2027-02-30").date, null);
    assert.equal(d("dinner on Dec 31").date, "2026-12-31");
    assert.equal(d("dinner on 12/31").date, "2026-12-31");
    const r = await run("dinner for 4 on Sept 31 at 7", "2026-11-11");
    assert.equal(r.outcome, "needs_clarification", "the old path booked Sep 31 and paid a deposit");
  });
  it("R35: \"the day after tomorrow\" books two days out, not tomorrow", async () => {
    const d = (text: string) => resolveDate(text, "2026-11-11");
    assert.deepEqual(d("dinner for 6 the day after tomorrow"), { date: "2026-11-13", ambiguous: false, reason: "day after tomorrow" }, "was 2026-11-12");
    assert.equal(d("lunch for 3 day after tmrw at noon").date, "2026-11-13");
    assert.equal(d("dinner for 4 tomorrow").date, "2026-11-12");
    assert.equal(parseRules("dinner for 6 with globex the day after tomorrow", "2026-11-11").clientName, "Globex", "lowercase read \"globex the\"");
    const r = await run("dinner for 6 the day after tomorrow", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.equal(r.request?.date, "2026-11-13", "the old path booked Thu Nov 12");
  });
  it("R36: \"a week from today\" and \"in 3 days\" count from their anchor, not today", async () => {
    const d = (text: string) => resolveDate(text, "2026-11-11");
    assert.deepEqual(d("dinner for 4 a week from today"), { date: "2026-11-18", ambiguous: false, reason: "offset from a date" }, "was today, 2026-11-11");
    assert.equal(d("lunch for 3 in 3 days").date, "2026-11-14", "asked which date");
    assert.equal(d("dinner in two weeks").date, "2026-11-25");
    assert.equal(d("drinks a week from Friday at 6").date, "2026-11-20");
    assert.equal(d("dinner two weeks from tomorrow").date, "2026-11-26");
    assert.equal(d("a week from Dec 3").date, "2026-12-10");
    assert.equal(d("a week from next Thursday").ambiguous, true, "an unclear anchor stays flagged");
    assert.equal(d("a week from whenever").date, null);
    assert.equal(parseRules("lunch in 3 days for 4", "2026-11-11").partySize, 4);
    assert.equal(parseRules("dinner for 6 with globex a week from today", "2026-11-11").clientName, "Globex", "lowercase read \"globex a\"");
    const r = await run("dinner for 4 a week from today", "2026-11-11");
    assert.equal(r.outcome, "booked", "the old path escalated it as same-day");
    assert.equal(r.request?.date, "2026-11-18");
  });
  it("R18: short weekdays, \"tmrw\" and \"Thursday the 19th\" resolve to the day the person meant", () => {
    const d = (text: string) => resolveDate(text, "2026-11-11");
    assert.equal(d("dinner for 4 tmrw at 7").date, "2026-11-12");
    assert.equal(d("lunch for 6 on Wed").date, "2026-11-18");
    assert.equal(d("dinner for 4, sat at 8").date, "2026-11-14");
    assert.equal(d("next thurs").date, "2026-11-12");
    assert.deepEqual(d("team dinner for 9 on Thursday the 19th"), { date: "2026-11-19", ambiguous: false, reason: "day of month" });
    assert.equal(d("Friday the 19th").ambiguous, true, "a weekday that doesn't match the date is confirmed, not guessed");
    assert.equal(d("dinner on the 5th").date, "2026-12-05", "a day already past rolls to next month");
    assert.equal(d("sunset dinner for 4").date, null);
  });
  it("R18: \"Thursday the 19th\" books the 19th, not this Thursday", async () => {
    const r = await run("team dinner for 9 on Thursday the 19th", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.at(-1)!, /Thu Nov 19/);
  });
  it("R19: \"me and 3 clients\" is a party of 4; the booker counts too", async () => {
    assert.equal(partySizeFrom("dinner for me and 3 clients next Thursday"), 4);
    assert.equal(partySizeFrom("lunch for myself and 5 people on Dec 2"), 6, "\"5 people\" alone booked 5");
    assert.equal(partySizeFrom("lunch for me + 2 colleagues"), 3);
    assert.equal(partySizeFrom("dinner for 4: me and 3 clients"), 4, "a stated total wins");
    assert.equal(partySizeFrom("dinner for me and my team"), null, "no number is asked, not guessed");
    const r = await run("dinner for me and 3 clients next Thursday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.equal(r.request?.partySize, 4);
  });
  it("R29: named guests are counted, the booker included", async () => {
    assert.equal(partySizeFrom("dinner for me, Sam and Priya on Friday"), 3);
    assert.equal(partySizeFrom("lunch for Sam, Priya and me"), 3);
    assert.equal(partySizeFrom("DINNER FOR ME, SAM, AND PRIYA"), 3, "casing and an Oxford comma change nothing");
    assert.equal(partySizeFrom("drinks for me & Jo"), 2);
    assert.equal(partySizeFrom("dinner for 4: me, Sam and Priya"), 4, "a stated total wins");
    assert.equal(partySizeFrom("dinner for me and the team"), null, "not a person: asked, not guessed");
    assert.equal(partySizeFrom("dinner for Sam and Priya"), null, "the booker may not be going: asked");
    const r = await run("dinner for me, Sam and Priya on Friday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.equal(r.request?.partySize, 3);
  });
  it("R30: a singular role (\"my boss\", \"a client\") is one guest; a group is still asked", async () => {
    assert.equal(partySizeFrom("dinner for me and my boss"), 2);
    assert.equal(partySizeFrom("lunch for me and a client on Friday"), 2);
    assert.equal(partySizeFrom("dinner for me, my manager and Sam"), 3);
    assert.equal(partySizeFrom("dinner for me and my clients"), null, "plural: asked, not guessed");
    assert.equal(partySizeFrom("dinner for me and a few clients"), null);
    assert.equal(partySizeFrom("dinner for my boss and Sam"), null, "the booker may not be going: asked");
    const r = await run("dinner for me and my boss on Friday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.equal(r.request?.partySize, 2);
  });
  it("R15: a budget nothing meets gets the closest real price, not a dead end", async () => {
    const r = await run("dinner for 6 under $60 a head this Friday", "2026-11-11");
    assert.equal(r.outcome, "needs_clarification");
    assert.match(r.messagesToBooker.at(-1)!, /Closest is .+ at about \$\d+ a head all-in/);
    assert.equal((await run("dinner for 6 under $60 a head this Friday", "2026-11-11", { r15: true })).outcome, "escalated");
  });
});
