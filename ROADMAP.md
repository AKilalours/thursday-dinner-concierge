# Roadmap

One small, tested improvement at a time. Top of "Ideas" goes next.

## Ideas

- More everyday sentences in evals/user-requests.ts (now 40): "next week", "around 7ish", a total budget ("$1,500 total") instead of per head.
- A total budget ("$1,500 all in", "budget 2k") is ignored; divide by the party size into a per-head cap, with a confirm.
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

## Shipped

- 2026-11-17: "$60pp", "100 per person" and "$120/head" are read as a per-head cap even without "under", so an over-budget venue is no longer booked (R20); real-user sentences 35 → 40.
- 2026-11-17: "dinner for me and 3 clients" books 4 instead of asking how many guests, and "myself and 5 people" books 6, not 5 (R19); real-user sentences 33 → 35.
- 2026-11-16: Dates typed the short way ("tmrw", "Wed", "sat at 8", "next fri") resolve, and "Thursday the 19th" books the 19th instead of this Thursday (R18); real-user sentences 25 → 33.
- 2026-11-15: Venue replies in plain words ("Yes, our private room fits 10... minimum is $900", "Min spend $1,500, deposit 25%") are read as offers with room, seats, minimum and deposit instead of "needs a human" (R17).
