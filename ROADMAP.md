# Roadmap

One small, tested improvement at a time. Top of "Ideas" goes next.

## Ideas

- Real-user rows from the 15 named testers: run each person's own sentence under their sign-in (never invented), add any failure as a real-user row with their name.
- Saved history across devices: today it lives in the browser; a signed-in server copy (the Worker plus a KV store) would follow a person to their phone.
- Fresh classifier set: write the next 40 unseen emails before the next gate change, as was done for hybrid strict.
- Classifier held-out set (evals/classifier-set.ts HELD_OUT) scores 40% for reply triage (62 rows): fix one held-out miss at a time, move that row to DEV_SET and write a new unseen held-out row, so the held-out number stays honest. Start with the one wrong action: "pay the deposit ... to account" inside an offer was read as a payment request.
- Retry a model call once on HTTP 429/529 with backoff; the benchmark now counts why calls fail, so measure first.
- Metamorphic: add rewrites that change meaning on purpose (date, time, budget) and check the parse follows each one.
- R10 ("somewhere in SoHo" booked Williamsburg) is caught by only one scenario in the bug replay; add a real-user row that would catch it too.
- More everyday sentences in evals/user-requests.ts (now 62): "next week", "dinner for 6 sometime next week".
- Chat: understand "cancel it", "push it an hour later", "add a vegan" after a booking, each as a proposal the booker approves.
- Approvals inbox: a manager view of proposals waiting for sign-off, with the reason and a cheaper alternative.
- Invoice: month picker and a per-cost-center subtotal row in the CSV.
- Venue side: show the agent's follow-up email when the person stays silent, and let them answer it.
- Accessibility: keyboard focus order, aria-labels on icon buttons, colour contrast on pills.
- Mobile polish at 390px: Live desk columns, Compare table, Invoice lines.
- Memory page: show which learned fact changed the ranking for the last request.
- A second category beyond dinners (office catering) end to end: venues, policy cap, emails, evals, split over several runs.
- Venue side: read a stated time ("that Friday at 7") into the offer, so a different time is caught as a counter.
- `npm run build:web` on a fresh clone rewrites docs/app.js with different minified names; pin esbuild exactly so builds are reproducible.
- "dinner for 6 next week" asks which date; offer the 5 weekdays as one-tap choices instead of a free-text question.
- A total budget with no headcount ("dinner on Friday, $500 total") is dropped; keep it and apply it once the party size is answered.
- `npm run build:web` on a fresh clone rewrites docs/app.js even with no source change; once esbuild is pinned, make site:check fail when the committed docs/app.js is stale.

- "next Thursday" typed on a Wednesday books the next day (Nov 12 from Nov 11); many people mean the week after. Decide, then ask when it's ambiguous.
- "dinner with my boss on Friday" (no "for", booker implied) still asks how many; decide whether "with <one person>" means a party of 2.
- Scenarios in evals/scenarios.ts grade party size and date but not the booked time; add an optional `time` expectation so a dropped time fails a scenario too.
- "Feb 29" in a year that has none is now asked about; when the booker clearly means a leap year ("Feb 29, 2028"), check the year they typed is honoured.

## Shipped

- 2026-11-21: "dinner for 4 on Sept 31 at 7" confirmed "Fri Sep 31" and paid a deposit (and "Feb 30", "2/30" did the same); a day the calendar doesn't have is now asked about, in every date format (R34); real-user sentences 66 → 68.
- 2026-11-21: "dinner for 4 on 3 Dec" asked "Which date?" and "the 3rd of Jan" booked Dec 3; day-first dates ("3 Dec", "3rd December", "the 10th of December") now resolve, "for 4 Dec 3" stays a headcount, and "31 Sept" is asked about (R33); real-user sentences 64 → 66.
- 2026-11-20: "dinner for 6 next Fri at half past 7" booked 7 pm (and "half past 8" would too); "half past", "quarter past" and "quarter to/of" are now read as clock times (R32); real-user sentences 62 → 64.
- 2026-11-20: "drinks for 8 on Friday around 6" booked 5:30 pm and "dinner ... 8ish" booked 7 pm; "around/about/by N" and "Nish" are now read as the time, never as a headcount ("around 8 people") or a budget ("around 20 a head") (R31); real-user sentences 59 → 62.
- 2026-11-20: Home redesign: greeting, occasions, Book again photo cards, a "Book X again?" prompt for returning people, and a venue sheet with the real all-in price, policy check and similar places at about the same price; the concierge books a venue picked by name (`preferVenueId`, 2 tests). Real photos (Unsplash License) on Home, Explore, Availability, Compare, Orders, Calendar and Seating. Inbox lab is an inbox; Traces shows span durations; Monitor opens with a status card.
- 2026-11-20: Orders page (upcoming, completed, cancelled, receipt, Book again) and "Book again" on Home for returning people; history follows a person across devices with name + 4-digit PIN (server/worker.js, needs the HISTORY KV binding); booking pages use today's real date instead of a fixed Nov 9, and the calendar starts on this week's Monday.
- 2026-11-20: "dinner for me and my boss" books 2 instead of asking how many; a singular role ("my boss", "a client", "my manager") counts as one guest, while plurals and groups ("my clients", "my team") are still asked (R30); real-user sentences 57 → 59.
- 2026-11-19: "dinner for me, Sam and Priya" books 3 instead of asking how many guests; a list of names that includes the booker is counted, and "me and the team" or names without "me" are still asked (R29); real-user sentences 55 → 57.
- 2026-11-19: `npm run site:check` works on a fresh clone: it falls back to a global Playwright (NODE_PATH or `npm root -g`) instead of failing with ERR_MODULE_NOT_FOUND, and says how to install it when there is none.
- 2026-11-19: Gate tightened before the run it judged (no more wrong actions than the rules); it demoted the first hybrid to shadow and promoted hybrid strict (model counts only at 0.9 confidence): held-out 79% vs rules 40%, 40 fresh emails 92.5% vs 55%. Saved per-person history (sign in again and earlier bookings and runs are back, still changeable), 15 named team sign-ins, and interactive Invoice, Traces and Monitor pages.
- 2026-11-19: Hybrid reply triage passed the promotion gate on a live run (held-out 80.6% vs rules 40.3%, injections 10/10 vs 4/10, 100% on generated and dev) and is now the agent's default; R28 a stated per-head budget is explained in the booker's terms; `npm run users:import` turns Report it issues into permanent eval rows.
- 2026-11-19: First live classifier benchmark (claude-sonnet-4-5): held-out triage 88.7% vs rules 40.3%, injections 10/10 vs 4/10; gate says stay in shadow. Found and fixed an injection timeout (3 s vs 2.7-3.2 s model latency) that discarded half the model's answers.
- 2026-11-19: Metamorphic parsing eval (1,066 checks; found and fixed R26 doubled spaces and R27 one-case client names), R25 a cuisine no venue serves is asked about, held-out classifier set grown to 62 with 95% intervals, promotion gate can no longer be passed by a model that never answered, and an eval-quality card on the Evals page.
- 2026-11-19: Evals: bug replay (each fixed bug turned back on is caught again, 7/7), classifier benchmark with a held-out set and a shadow-to-live promotion gate, real-user rows graded on what the booker is told, and a Report it link in the app. The benchmark found and fixed two triage bugs; confirmations no longer promise dietary reminders when there are none.
- 2026-11-19: An impossible model time ("25:00", "19:75", "24:00") is dropped for the time the sentence gave instead of reaching the booking; every request's time must now be a real 00:00-23:59 clock time (R24).
- 2026-11-18: A total budget ("$300 total", "budget 2k", "$1,500 all in") is divided by the party size into a per-head cap, so a venue over it is no longer booked (R23); real-user sentences 44 → 47.
- 2026-11-18: Allergies typed plainly ("no shellfish", "allergic to nuts", "nut-free", "dairy free", "celiac", "allergic to sesame") now reach the venue email and the proposal instead of being dropped (R22); real-user sentences 42 → 44.
- 2026-11-17: "dinner for 4 on Friday at 7.30pm" no longer crashes (it read "30pm" as 42:00); "7.30" books 7:30 not 7:00, and "noon" books 12:00 not 12:30 (R21); real-user sentences 40 → 42.
- 2026-11-17: "$60pp", "100 per person" and "$120/head" are read as a per-head cap even without "under", so an over-budget venue is no longer booked (R20); real-user sentences 35 → 40.
- 2026-11-17: "dinner for me and 3 clients" books 4 instead of asking how many guests, and "myself and 5 people" books 6, not 5 (R19); real-user sentences 33 → 35.
- 2026-11-16: Dates typed the short way ("tmrw", "Wed", "sat at 8", "next fri") resolve, and "Thursday the 19th" books the 19th instead of this Thursday (R18); real-user sentences 25 → 33.
- 2026-11-15: Venue replies in plain words ("Yes, our private room fits 10... minimum is $900", "Min spend $1,500, deposit 25%") are read as offers with room, seats, minimum and deposit instead of "needs a human" (R17).
