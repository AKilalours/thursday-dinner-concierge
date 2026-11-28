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

- The site check's flows run on the real clock, so a sentence can pass on one weekday and fail on another (R48 was found that way); also run the flows once with ?today= pinned, and say which date failed.
- "dinner with my boss on Friday" (no "for", booker implied) still asks how many; decide whether "with <one person>" means a party of 2.
- Scenarios in evals/scenarios.ts grade party size and date but not the booked time; add an optional `time` expectation so a dropped time fails a scenario too.
- "Feb 29" in a year that has none is now asked about; when the booker clearly means a leap year ("Feb 29, 2028"), check the year they typed is honoured.
- "in a couple of days" and "a fortnight from Friday" still ask which date.
- A headcount range is now asked with a plain "How many guests?"; offer the range's numbers as one-tap choices.
- "dinner Friday 4-6 people" (range after a day, no "for") keeps the default time but asks a plain "how many?"; a range followed by "people"/"guests" should be asked as a range.
- "dinner for 2 with Sam on Friday" names a colleague "Sam" as the client; a first name alone could be read as a guest, not a company.
- "dinner tonight's fine, 4 of us" and "tonight-ish" are untested; check a possessive or suffixed "tonight" still reads as today.
- All caps "LUNCH W/ ACME FOR 6 ON FRIDAY" names the client "ACME FOR" (lowercase and "WITH" are fine); "for" after an all-caps name should end it.
- "the day after thanksgiving" and "thanksgiving week" still ask which date; the day after could book the Friday.
- "$500 split 6 ways" and "$500 to share" are untested as a total; check whether they should cap the spend too.
- "w/o meat" and "without pork" are not read as vegetarian or a dietary need; decide which "without X" a venue should hear.
- "friday 18h" and "Friday 1930" (24-hour without a colon) still book the default time; decide whether a 4-digit time after a day word is safe to read.
- "under 80 bucks a head" is read, but "8 bucks a head" (one digit) is not; decide whether a one-digit per-head figure should be asked about.

## Shipped

- 2026-11-28: "dinner for 4 on Friday 19:30" booked the default 7 pm (and "Friday 7:30", "Dec 3 12:45", "friday 17:45" did the same); a colon time with no "at" is now the time booked, while a dot ("$19.30") is still money (R54); real-user sentences 105 → 107.

- 2026-11-27: "dinner for 4 on thanksgiving" asked "Which date should I book?"; Thanksgiving is now the 4th Thursday of November (Nov 26, 2026; next year's once it has passed), "with acme thanksgiving" keeps the client as Acme, and "the day after thanksgiving" is still asked (R53); real-user sentences 103 → 105.
- 2026-11-27: "dinner for 6 on Friday, $500 between us" booked Lantern Row at about $791 all-in and paid the deposit (and "$500 for the 6 of us", "$300 between the four of us", "$400 for us all" did the same); these are now a total divided by the headcount ($83 a head here, Rue Margaux), while "for us" with no money sets no cap (R52); real-user sentences 101 → 103.
- 2026-11-27: "dinner tonite for 2" asked "Which date should I book?" (and "2nite", "tnite" did the same); they are now read as tonight in the case typed, so the request is escalated for short notice like "dinner for two tonight", and an all-caps "DINNER TONITE ... WITH ACME" keeps Acme (R51); real-user sentences 99 → 101.
- 2026-11-26: "dinner for 4 on Friday w/o nuts" booked with no dietary need sent to the venue (and "without gluten", "W/O dairy" did the same); "w/o" and "without" before a diet word are now read as "no", so the nut allergy reaches the proposal and the venue email, while "without a view" is not a diet (R50); real-user sentences 97 → 99.
- 2026-11-26: "dinner for 4 on Friday w/ Acme" dropped Acme from the proposal and the venue email (and "w/hooli", "W/ Initech" did the same); "w/" is now read as "with", while "w/o" is left alone (R49); real-user sentences 95 → 97.
- 2026-11-26: "dinner for 12 with the Acme team next Thursday" typed on a Wednesday booked tomorrow, 21 h away, and was escalated for notice (it failed the site check); "next <weekday>" is now at least 2 days out (Wed "next Thursday" is the Thursday after, Mon "next Tuesday" is a week out), Mon-Wed readings stay flagged, and the confirmation names the other reading ("reject if you meant Thu Nov 26") (R48).
- 2026-11-25: "dinner for 6 on Friday, $500 for the group" booked Lantern Row at about $791 all-in and paid the deposit; "$N for the group/table/team/party" and "$N for everyone" are now a total divided by the headcount ($83 a head here, Rue Margaux), while "for the group" with no money sets no cap (R47); real-user sentences 93 → 95.
- 2026-11-25: "dinner for 6 on Friday, 80 bucks a head" booked with no spend cap (and "$80 a pop", "40 dollars per person", "30 bucks each" did the same); slang per-head figures with "bucks", "dollars" or "$ ... a pop" are now a per-head cap, while "dinner for 10 bucks" is not money (R46); real-user sentences 91 → 93.
- 2026-11-25: "dinner for 6 on Friday, budget $80 each" booked $132 a head and paid the deposit; "$80 each" and "budget 80 each" are now a per-head cap, while "for 10 each" is not money (R45); real-user sentences 89 → 91.
- 2026-11-24: "dinner for 3 next week Thursday" (typed on a Wednesday) booked tomorrow, Thu Nov 12, and paid the deposit; "next week Thursday", "Thursday next week", "next week on Mon" and "Friday of next week" now book that weekday in the week starting next Monday, while "next week" alone is still asked (R44); real-user sentences 87 → 89.
- 2026-11-24: "dinner for 4 with acme corp on Friday" dropped Acme Corp from the proposal and the venue email; a capitalised weekday or month no longer counts as a booker who capitalises names, and "with outdoor seating", "with live music" and similar amenities are never a client in any case (was "Outdoor Seating" when typed in lowercase) (R43); real-user sentences 85 → 87.
- 2026-11-24: "Drinks for 6 with hooli friday" dropped Hooli from the proposal and the venue email; a sentence whose only capitals start a sentence (or are "I", "PM", "Dinner") is read as one-case, so the lowercase client is kept, while "with the team" and "with something" are never a client (R42); real-user sentences 83 → 85.
- 2026-11-23: "Dinner for 4 with Initech Friday at 7" told the booker and the venue "4 guests with Initech Friday"; a weekday, month, "tmrw" or "two weeks" after a client name is now read as the date, not part of the name, in any case, while "Acme Corp" and "Capital One" stay whole (R41); real-user sentences 81 → 83.
- 2026-11-23: "drinks for 8 on Dec 3 6-8" booked the default 5:30 pm; a bare range right after a calendar date ("Dec 3 6-8", "December 3rd, 8-10", "3 Dec", "12/3", "the 19th") now books its start, and "for 4-6" stays a headcount (R40); real-user sentences 79 → 81.
- 2026-11-23: "drinks for 10 friday 6-8" booked the default 5:30 pm; a bare range right after a day word ("friday 6-8", "Friday, 7-9", "tomorrow 7 to 9") now books its start, a word after a range ("6-8 please") no longer drops the time, and "for 4-6" stays a headcount (R39); real-user sentences 77 → 79.
- 2026-11-22: "dinner for 4 on Friday 7-9pm" booked 9 pm; a time range ("7-9pm", "from 7 to 9pm", "between 6 and 8pm", "7:30-9:30pm") now books its start, borrowing the end's am/pm unless it wraps ("11-1pm" is 11 am), while "for 4-6 people" stays a headcount (R38); real-user sentences 75 → 77.
- 2026-11-22: "dinner for 4-6 people on Friday" booked a table for 4 and paid the deposit; a headcount range ("4-6 people", "for 4 to 6", "for 8 or 10") is now asked about, while a time range ("between 7-9") still is not a headcount (R37); real-user sentences 73 → 75.
- 2026-11-22: "dinner for 4 a week from today" was read as today and escalated, and "lunch for 3 in 3 days" asked which date; "a week from today/Friday/Dec 3", "two weeks from tomorrow" and "in N days/weeks" now count from their anchor, an unclear anchor stays flagged, and lowercase "with globex a week ..." no longer names the client "Globex A" (R36); real-user sentences 70 → 73.
- 2026-11-21: "dinner for 6 the day after tomorrow" booked tomorrow; it now books two days out ("day after tmrw" too), and a lowercase "with globex the ..." no longer names the client "Globex The" (R35); real-user sentences 68 → 70.
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
