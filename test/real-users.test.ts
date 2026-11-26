// Bugs found by using the app the way a real booker would (R12-R15, R18, R19, R29, R30, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R47, R48, R49). Each has a test that fails on the old path.
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
  it("R37: a headcount range (\"4-6 people\", \"for 8 or 10\") is asked about, not booked at the low end", async () => {
    assert.equal(partySizeFrom("dinner for 4-6 people on Friday"), null, "was 4");
    assert.equal(partySizeFrom("dinner for 4 to 6 on Friday"), null);
    assert.equal(partySizeFrom("team lunch for 8 or 10 on Dec 2"), null);
    assert.equal(partySizeFrom("drinks, 10–12 people, Friday"), null);
    assert.equal(partySizeFrom("dinner for 6 on Friday between 7-9"), 6, "a time range is not a headcount");
    assert.equal(partySizeFrom("dinner for 4 on Friday 7-9pm"), 4);
    assert.equal(partySizeFrom("dinner for 4 on Dec 3"), 4);
    const r = await run("dinner for 4-6 people on Friday", "2026-11-11");
    assert.equal(r.outcome, "needs_clarification", "the old path booked 4 and paid a deposit");
    assert.match(r.messagesToBooker.at(-1)!, /How many guests/);
  });
  it("R38: a time range (\"7-9pm\", \"from 7 to 9pm\") books its start, not its end", async () => {
    const time = (s: string) => parseRules(s, "2026-11-11").time;
    assert.equal(time("dinner for 4 on Friday 7-9pm"), "19:00", "was 21:00");
    assert.equal(time("dinner for 4 on Friday from 7 to 9pm"), "19:00");
    assert.equal(time("drinks for 8 between 6 and 8pm on Friday"), "18:00");
    assert.equal(time("dinner for 4 on Friday 7:30-9:30pm"), "19:30");
    assert.equal(time("lunch for 6 on Friday 11-1pm"), "11:00", "a range that wraps noon starts in the morning");
    assert.equal(time("lunch for 4 on Friday 12-2pm"), "12:00");
    assert.equal(partySizeFrom("dinner for 4-6 people on Friday"), null, "a headcount range is still not a time");
    const r = await run("dinner for 4 on Friday 7-9pm", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /at 7 pm/);
  });
  it("R39: a bare range right after a day (\"friday 6-8\") books its start, not the default", async () => {
    const time = (s: string) => parseRules(s, "2026-11-11").time;
    assert.equal(time("drinks for 10 friday 6-8"), "18:00", "was 17:30");
    assert.equal(time("dinner for 6 on Friday, 7-9"), "19:00");
    assert.equal(time("dinner tomorrow 7 to 9 for 4"), "19:00");
    assert.equal(time("lunch for 6 on wed 12-2"), "12:00");
    assert.equal(time("drinks for 10 friday 6-8 please"), "18:00", "a word after the range must not swallow the time");
    assert.equal(partySizeFrom("dinner for 4-6 on friday"), null, "after \"for\" a range is still a headcount");
    const r = await run("drinks for 10 friday 6-8", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /at 6 pm/);
  });
  it("R40: a bare range right after a calendar date (\"Dec 3 6-8\") books its start, not the default", async () => {
    const time = (s: string) => parseRules(s, "2026-11-11").time;
    assert.equal(time("drinks for 8 on Dec 3 6-8"), "18:00", "was 17:30");
    assert.equal(time("dinner for 4 on December 3rd, 8-10"), "20:00", "was 19:00");
    assert.equal(time("drinks for 6 on 3 Dec 6-8"), "18:00");
    assert.equal(time("dinner for 6 on 12/3 8 to 10"), "20:00");
    assert.equal(time("dinner for 5 on the 19th 8-10"), "20:00");
    assert.equal(time("drinks for 8 on Dec 3, 2026 6-8"), "18:00");
    assert.equal(parseRules("drinks for 8 on Dec 3 6-8", "2026-11-11").date, "2026-12-03", "the date is kept");
    assert.equal(partySizeFrom("dinner for 4-6 on Dec 3"), null, "after \"for\" a range is still a headcount");
    const r = await run("drinks for 8 on Dec 3 6-8", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /at 6 pm/);
  });
  it("R41: a weekday, month or \"two weeks\" after a client is when, not part of the name", async () => {
    const client = (s: string) => parseRules(s, "2026-11-11").clientName;
    assert.equal(client("Dinner for 4 with Initech Friday at 7"), "Initech", "was Initech Friday");
    assert.equal(client("dinner for 4 with hooli friday 6-8"), "Hooli", "was Hooli Friday");
    assert.equal(client("dinner for 4 with globex two weeks from friday"), "Globex", "was Globex Two");
    assert.equal(client("lunch for 3 with acme dec 3"), "Acme");
    assert.equal(client("drinks for 6 with initech tmrw"), "Initech");
    assert.equal(client("dinner for 4 with Globex December 3"), "Globex");
    assert.equal(client("dinner for 4 with Acme Corp on Friday"), "Acme Corp", "a real two-word name is kept");
    assert.equal(client("dinner for 4 with Capital One on Friday"), "Capital One", "\"One\" alone is not a date");
    const r = await run("Dinner for 4 with Initech Friday at 7", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /4 guests with Initech\./);
  });
  it("R42: a lowercase client in a sentence capitalised only at the start is still the client", async () => {
    const client = (s: string) => parseRules(s, "2026-11-11").clientName;
    assert.equal(client("Drinks for 6 with hooli friday"), "Hooli", "was dropped");
    assert.equal(client("I need dinner for 4 with globex at 7PM"), "Globex", "\"I\" and \"PM\" don't count as capitalising");
    assert.equal(client("Dinner for 6 with the team friday"), null, "the team is not a client");
    assert.equal(client("Dinner for 4 with outdoor seating on Friday"), null, "a booker who capitalises Friday would capitalise a name");
    assert.equal(client("Dinner for 4 with my boss friday"), null);
    const r = await run("Drinks for 6 with hooli friday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /6 guests with Hooli\./);
  });
  it("R43: a capitalised weekday or month alone doesn't make a lowercase client disappear", async () => {
    const client = (s: string) => parseRules(s, "2026-11-11").clientName;
    assert.equal(client("dinner for 4 with acme corp on Friday"), "Acme Corp", "was dropped");
    assert.equal(client("lunch with globex on Dec 3"), "Globex", "was dropped");
    assert.equal(client("dinner for 4 with Acme on Friday"), "Acme");
    assert.equal(client("dinner for 4 with outdoor seating on Friday"), null, "an amenity is not a client");
    assert.equal(client("dinner for 4 with outdoor seating on friday"), null, "was Outdoor Seating");
    assert.equal(client("dinner for 4 with live music on Friday"), null);
    const r = await run("dinner for 4 with acme corp on Friday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /4 guests with Acme Corp\./);
  });
  it("R44: \"next week Thursday\" is next week's Thursday, not this week's", async () => {
    const d = (text: string, today = "2026-11-11") => resolveDate(text, today).date;
    assert.equal(d("dinner for 3 next week Thursday"), "2026-11-19", "was Nov 12, tomorrow");
    assert.equal(d("drinks Thursday next week"), "2026-11-19");
    assert.equal(d("lunch next week, on Mon"), "2026-11-16");
    assert.equal(d("dinner on Friday of next week at 8"), "2026-11-20");
    assert.equal(d("thursday next week", "2026-11-15"), "2026-11-19", "on a Sunday the week starts tomorrow");
    assert.equal(d("thursday next week", "2026-11-16"), "2026-11-26", "on a Monday it's a week out");
    assert.equal(d("dinner for 6 next week"), null, "no weekday is still asked");
    const r = await run("dinner for 3 next week Thursday", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.at(-1)!, /Thu Nov 19/);
  });
  it("R45: \"budget $80 each\" is a per-head cap", async () => {
    const cap = (s: string) => parseRules(s, "2026-11-11").maxPerHeadCents;
    assert.equal(cap("dinner for 6 on Friday, budget $80 each"), 8000, "was null, so $132 a head got booked");
    assert.equal(cap("lunch for 4 on Dec 3, $40 each"), 4000);
    assert.equal(cap("dinner for 5 next fri, budget 90 each"), 9000);
    assert.equal(cap("dinner for 10 each Friday"), null, "a bare number before \"each\" is not money");
    const r = await run("dinner for 6 on Friday, budget $80 each", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /within your \$80/);
  });
  it("R46: \"80 bucks a head\" and \"$80 a pop\" are a per-head cap", async () => {
    const cap = (s: string) => parseRules(s, "2026-11-11").maxPerHeadCents;
    assert.equal(cap("dinner for 6 on Friday, 80 bucks a head"), 8000, "was null, so $132 a head got booked");
    assert.equal(cap("dinner for 6 on Friday, $80 a pop"), 8000);
    assert.equal(cap("lunch for 4 on Dec 3, 40 dollars per person"), 4000);
    assert.equal(cap("drinks for 6 on Friday, 30 bucks each"), 3000);
    assert.equal(cap("dinner for 10 bucks"), null, "a headcount is not money");
    const r = await run("dinner for 6 on Friday, 80 bucks a head", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /within your \$80/);
  });
  it("R47: \"$500 for the group\" is a total, divided by the headcount", async () => {
    const cap = (s: string) => parseRules(s, "2026-11-11").maxPerHeadCents;
    assert.equal(cap("dinner for 6 on Friday, $500 for the group"), 8333, "was null, so $132 a head got booked");
    assert.equal(cap("lunch for 4 on Dec 3, $300 for everyone"), 7500);
    assert.equal(cap("dinner for 8 next fri, $1,200 for the whole team"), 15000);
    assert.equal(cap("dinner for 6 for the group on Friday"), null, "no money, no cap");
    const r = await run("dinner for 6 on Friday, $500 for the group", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /within your \$83/);
  });
  it("R48: \"next Thursday\" typed on a Wednesday is next week's Thursday, not tomorrow", async () => {
    const d = (text: string, today: string) => resolveDate(text, today);
    assert.deepEqual(d("dinner for 4 next Thursday", "2026-11-25"), { date: "2026-12-03", ambiguous: true, reason: "'next' could mean this week or next" }, "was Nov 26, 21 h away");
    assert.equal(d("lunch next sat", "2026-11-13").date, "2026-11-21", "Friday: the day after is \"tomorrow\"");
    assert.equal(d("next Thursday", "2026-11-26").date, "2026-12-03", "same weekday stays a week out");
    assert.equal(d("next Thursday", "2026-11-23").date, "2026-11-26", "Monday: this week's, still flagged");
    assert.equal(d("next Thursday", "2026-11-23").ambiguous, true);
    assert.equal(d("this Thursday", "2026-11-25").date, "2026-11-26", "\"this\" is unchanged");
    const r = await run("dinner for 12 with the Acme team next Thursday, somewhere private", "2026-11-25");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /as Thu Dec 3; reject if you meant Thu Nov 26/, "the other reading is the earlier one");
  });
  it("R49: \"w/ Acme\" is \"with Acme\"; \"w/o\" is not", async () => {
    const client = (s: string) => parseRules(s, "2026-11-11").clientName;
    assert.equal(client("dinner for 4 on Friday w/ Acme"), "Acme", "was null, so the venue never heard who was coming");
    assert.equal(client("Dinner for 4 W/ Initech on Friday"), "Initech");
    assert.equal(client("drinks for 6 w/hooli friday"), "Hooli");
    assert.equal(client("lunch for 3 w/o shellfish on Dec 3"), null, "without is not with");
    const r = await run("dinner for 4 on Friday w/ Acme", "2026-11-11");
    assert.equal(r.outcome, "booked");
    assert.match(r.messagesToBooker.join("\n"), /4 guests with Acme\./);
  });
  it("R18: short weekdays, \"tmrw\" and \"Thursday the 19th\" resolve to the day the person meant", () => {
    const d = (text: string) => resolveDate(text, "2026-11-11");
    assert.equal(d("dinner for 4 tmrw at 7").date, "2026-11-12");
    assert.equal(d("lunch for 6 on Wed").date, "2026-11-18");
    assert.equal(d("dinner for 4, sat at 8").date, "2026-11-14");
    assert.equal(d("next thurs").date, "2026-11-19", "R48: was tomorrow (Nov 12); \"next\" on the day before means next week's");
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
