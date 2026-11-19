# Roadmap

One small, tested improvement at a time. Top of "Ideas" goes next.

## Ideas

- Found by the stronger real-user sweep: "thai food for 6 next wednesday" books a Japanese room without saying there is no Thai venue on the list. Tell the booker the cuisine isn't available and ask (or name the closest), with a real-user row that checks the message.
- Classifier held-out set (evals/classifier-set.ts HELD_OUT) scores 41% for reply triage: fix one held-out miss at a time, move that row to DEV_SET and write a new unseen held-out row, so the held-out number stays honest. Start with the one wrong action: "pay the deposit ... to account" inside an offer was read as a payment request.
- Grow HELD_OUT to 60+ rows across all seven labels before trusting per-label recall.
- R10 ("somewhere in SoHo" booked Williamsburg) is caught by only one scenario in the bug replay; add a real-user row that would catch it too.
- More everyday sentences in evals/user-requests.ts (now 52): "next week", "around 7ish", "dinner for 6 sometime next week".
- Chat: understand "cancel it", "push it an hour later", "add a vegan" after a booking, each as a proposal the booker approves.
- Approvals inbox: a manager view of proposals waiting for sign-off, with the reason and a cheaper alternative.
- Invoice: month picker and a per-cost-center subtotal row in the CSV.
- Venue side: show the agent's follow-up email when the person stays silent, and let them answer it.
- Accessibility: keyboard focus order, aria-labels on icon buttons, colour contrast on pills.
- Mobile polish at 390px: Live desk columns, Compare table, Invoice lines.
- Memory page: show which learned fact changed the ranking for the last request.
- A second category beyond dinners (office catering) end to end: venues, policy cap, emails, evals, split over several runs.
- Venue side: read a stated time ("that Friday at 7") into the offer, so a different time is caught as a counter.
- "dinner for me, Sam and Priya" names guests without a number; count named people (with a confirm) instead of asking.
- `npm run build:web` on a fresh clone rewrites docs/app.js with different minified names; pin esbuild exactly so builds are reproducible.
- "dinner for 6 next week" asks which date; offer the 5 weekdays as one-tap choices instead of a free-text question.
- A total budget with no headcount ("dinner on Friday, $500 total") is dropped; keep it and apply it once the party size is answered.
- `npm run site:check` imports playwright but it is not in package.json; on a fresh clone it fails with ERR_MODULE_NOT_FOUND unless a global copy is linked.

## Shipped

- 2026-11-19: Evals: bug replay (each fixed bug turned back on is caught again, 7/7), classifier benchmark with a held-out set and a shadow-to-live promotion gate, real-user rows graded on what the booker is told, and a Report it link in the app. The benchmark found and fixed two triage bugs; confirmations no longer promise dietary reminders when there are none.
- 2026-11-19: An impossible model time ("25:00", "19:75", "24:00") is dropped for the time the sentence gave instead of reaching the booking; every request's time must now be a real 00:00-23:59 clock time (R24).
- 2026-11-18: A total budget ("$300 total", "budget 2k", "$1,500 all in") is divided by the party size into a per-head cap, so a venue over it is no longer booked (R23); real-user sentences 44 → 47.
- 2026-11-18: Allergies typed plainly ("no shellfish", "allergic to nuts", "nut-free", "dairy free", "celiac", "allergic to sesame") now reach the venue email and the proposal instead of being dropped (R22); real-user sentences 42 → 44.
- 2026-11-17: "dinner for 4 on Friday at 7.30pm" no longer crashes (it read "30pm" as 42:00); "7.30" books 7:30 not 7:00, and "noon" books 12:00 not 12:30 (R21); real-user sentences 40 → 42.
- 2026-11-17: "$60pp", "100 per person" and "$120/head" are read as a per-head cap even without "under", so an over-budget venue is no longer booked (R20); real-user sentences 35 → 40.
- 2026-11-17: "dinner for me and 3 clients" books 4 instead of asking how many guests, and "myself and 5 people" books 6, not 5 (R19); real-user sentences 33 → 35.
- 2026-11-16: Dates typed the short way ("tmrw", "Wed", "sat at 8", "next fri") resolve, and "Thursday the 19th" books the 19th instead of this Thursday (R18); real-user sentences 25 → 33.
- 2026-11-15: Venue replies in plain words ("Yes, our private room fits 10... minimum is $900", "Min spend $1,500, deposit 25%") are read as offers with room, seats, minimum and deposit instead of "needs a human" (R17).
