# Roadmap

One small, tested improvement at a time. Top of "Ideas" goes next.

## Ideas

- More everyday sentences in evals/user-requests.ts (aim for 40): "around 7", "next week", weekday plus date, typos, "for me and 3 clients", budgets written as "$100pp" or "100 per person".
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

## Shipped

- 2026-11-15: Venue replies in plain words ("Yes, our private room fits 10... minimum is $900", "Min spend $1,500, deposit 25%") are read as offers with room, seats, minimum and deposit instead of "needs a human" (R17).
