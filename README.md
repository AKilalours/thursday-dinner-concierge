<h1 align="center">Thursday Dinner Concierge</h1>

<p align="center"><b>One sentence in. A booked, paid, on-policy dinner out. Nothing happens until you approve.</b><br><sub>Built for the Ande AI Engineer role · independent project · fictional venues and people</sub></p>


<p align="center">
  <a href="https://akilalours.github.io/thursday-dinner-concierge/"><img src="https://img.shields.io/badge/▶_Open_the_live_app-7b1e3a?style=for-the-badge" alt="Open the live app"></a>
  <a href="docs/img/thursday-home-4k.mp4"><img src="https://img.shields.io/badge/▶_57s_video_·_4K-2b1d24?style=for-the-badge" alt="4K video"></a>
  <a href="https://ande-thursday-dinner-concierge.streamlit.app"><img src="https://img.shields.io/badge/Streamlit-FF4B4B?style=for-the-badge&logo=streamlit&logoColor=white" alt="Streamlit"></a>
</p>
<p align="center">
  <a href="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/ci.yml"><img src="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/pages.yml"><img src="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/pages.yml/badge.svg" alt="deploy"></a>
  <a href="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/agent-watch.yml"><img src="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/agent-watch.yml/badge.svg" alt="agent watch"></a>
</p>

<p align="center"><a href="docs/img/thursday-home-4k.mp4"><img src="docs/img/home-tour.gif" width="900" alt="Welcome back and book again, a colour street map with live pins, a venue sheet with the real price and similar places, the agent emailing venues and ignoring a scam, slide to book, every page on one request, the inbox, Agent Watch"></a><br><sub>Filmed on the app itself, frame by frame · <a href="docs/img/thursday-home-4k.mp4"><b>Watch in 4K</b></a></sub></p>

<table align="center"><tr>
<td align="center"><h3>68/68</h3>eval<br>scenarios</td>
<td align="center"><h3>0 / 2,035</h3>safety checks failed<br>in 300 random worlds</td>
<td align="center"><h3>161</h3>tests</td>
<td align="center"><h3>59/59</h3>real-user<br>sentences</td>
<td align="center"><h3>92.5%</h3>unseen venue emails<br>read right · 7/7 scams</td>
<td align="center"><h3>R1–R30</h3>bugs found →<br>permanent tests</td>
</tr></table>

## See it

<table>
<tr>
<td width="33%" align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/v3-reorder.jpg" alt="Welcome back: book your last dinner again"></a><br><b>Welcome back</b> · book it again</td>
<td width="33%" align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/v3-map.jpg" alt="Live map: hover a pin to see the place"></a><br><b>Tap any place</b> on a real map</td>
<td width="33%" align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/v3-sheet.jpg" alt="Venue sheet with rooms, price and similar places"></a><br><b>Real price</b> · policy · similar places</td>
</tr>
<tr>
<td align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/v3-booked.jpg" alt="Booked after the person slides to approve"></a><br><b>Slide to book</b> · nothing books before</td>
<td align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#bookings"><img src="docs/img/v3-orders.jpg" alt="Orders: past and upcoming dinners"></a><br><b>Your orders</b> · on every device</td>
<td align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/#lab"><img src="docs/img/v3-inbox.jpg" alt="Inbox lab: a scam email is read as data"></a><br><b>Scam email</b> · read as data</td>
</tr>
</table>

## What's real

| Real | Simulated, and labelled so |
|---|---|
| The agent: concierge + sourcing, comparison and coordination subagents, typed tools, policy, memory | **The restaurants** are invented (names, rooms, prices), so no real business is quoted |
| Claude: live through the project's server, every answer recorded and replayed in CI | **Their email replies** come from a simulator with 7 behaviours, including scams |
| Approvals, payee and double-booking rules enforced by **Postgres** (tested on real Postgres) | |
| Each person's **sign-in, orders and history**, kept across devices (name + PIN) | |
| **Today's date**, **OpenStreetMap streets**, **photographs** (Unsplash License) | |
| **Confirmation emails** with a calendar invite, sent to an address you type | |
| **Agent Watch**: the whole suite re-run 3 times a day by GitHub Actions | |

## More videos

<table><tr>
<td width="25%"><a href="docs/img/real-users.mp4"><img src="docs/img/real-users.gif" alt="Real users"></a><br><b>Real people, real bugs</b></td>
<td width="25%"><a href="docs/img/can-you-trick-it.mp4"><img src="docs/img/can-you-trick-it.gif" alt="Can you trick it"></a><br><b>Can you trick it?</b> · 4K</td>
<td width="25%"><a href="docs/img/the-finance-view.mp4"><img src="docs/img/the-finance-view.gif" alt="Finance view"></a><br><b>The finance view</b> · 4K</td>
<td width="25%"><a href="docs/img/both-sides.mp4"><img src="docs/img/both-sides.gif" alt="Both sides"></a><br><b>Both sides of the table</b> · 4K</td>
</tr><tr>
<td><a href="docs/img/thursday-checks-on-the-checks.mp4"><img src="docs/img/checks-on-the-checks.jpg" alt="Checks on the checks"></a><br><b>I tested my tests</b></td>
<td><a href="docs/img/thursday-12-bookings.mp4"><img src="docs/img/twelve-bookings.jpg" alt="12 bookings"></a><br><b>12 bookings, 12 reasons</b></td>
<td><a href="docs/img/demo.mp4"><img src="docs/img/demo.gif" alt="First demo"></a><br><b>The first demo</b></td>
<td></td>
</tr></table>

## The details

<details><summary><b>Real people, real bugs</b></summary>

<p align="center"><a href="docs/img/real-users.mp4"><img src="docs/img/real-users.gif" width="900" alt="Akilan and Mamatha Challa each sign in and book a dinner in one sentence"></a><br><sub><a href="docs/img/real-users.mp4">Watch in HD (1440p)</a></sub></p>

Evals only test what you thought of. So I gave the app to a real person. **Akilan** used it with no instructions beyond "type a dinner the way you'd text a friend", and broke it on his first sentence. Then I walked through it as a second user, a team lead (**Mamatha Challa** in the video), plus 35 requests typed the way people type. Every failure became a fix and a permanent test the same day. The video re-enacts both sessions on the fixed build:

| Who | What they typed | What went wrong | Now |
|---|---|---|---|
| Akilan | "dinner for 2 next Friday, somewhere private" | Every private room's minimum split over 2 guests broke the $250 cap, so it emailed nobody and said "I contacted 0 venues" (R12) | Books a quiet table and says why: "private rooms start at about $721 a head for 2" |
| Mamatha | "lunch with a client tomorrow, 3 people" | Asked 27 h ahead, but notice was measured when venues replied, so 8 venues were emailed and it gave up (R13) | Notice is measured from when the booker asked |
| Mamatha | "team dinner for 8 on 12/3" · "dinner on Christmas Eve" | Asked "which date?" (R14) | US dates and holiday evenings resolve |
| Mamatha | "dinner for 6 under $60 a head" | Dead end: "no venue could host" (R15) | Asks, with the closest real price: "about $88 a head all-in, book that?" |
| Mamatha | booked Dec 3, opened Calendar | The calendar showed a fixed 3 weeks, so her dinner was invisible (R16) | Calendar grows to the last booked dinner |

`npm run evals:users` replays 55 requests typed the way people type, in CI, on every push: **55/55** now do what a person would expect (47 book, 2 correctly wait for a manager because they're under 24 h notice, 6 ask: about budget, or about a cuisine no venue serves). 10 of them are also graded on what the booker is told, not just the outcome: a booking that drops "Japanese, as asked" or the dietary confirmation fails. Found something it gets wrong? The app has a **Report it** link under every result that opens a prefilled issue ([template](.github/ISSUE_TEMPLATE/real-user.md)); each report becomes a permanent row: `npm run users:import` reads every issue labelled real-user and appends it to [`evals/reported.ts`](evals/reported.ts) with the outcome the reporter ticked.

</details>

<details><summary><b>Agent Watch: the agent is tested 3 times a day, not just when I push</b></summary>

<a href="https://akilalours.github.io/thursday-dinner-concierge/#monitor">Open the live Monitor page ↗</a>

A scheduled job (`npm run monitor`, [workflow](.github/workflows/agent-watch.yml)) does what a production agent team would do between releases:

| Every run | Why |
|---|---|
| A rotating slice of the eval scenarios against **live Claude** when the `ANTHROPIC_API_KEY` secret is set (recorded model outputs until then; every run so far has used recordings, and the Monitor page shows which) | Model drift shows up as a failed check or a fallback to rules, never silently. The whole suite is covered every few runs |
| **500 random worlds no earlier run has seen** (seeds from the clock) | Silent venues, price hikes, injections, double bookings: new adversarial coverage every run, checked against the safety invariants |
| The **55 real-user sentences** | The requests real people actually type keep working, and the booker is told what was asked |

Each run appends a row to [`docs/monitor.json`](docs/monitor.json), charted on the Monitor page (pass rate, worlds tested, live p50/p95 latency, cost per day), with the full report in `evals/history/`. If anything fails, the run **opens a GitHub issue by itself** with the failing seed, which replays exactly. Live model calls are capped per run (about $0.10–0.20 a run).

</details>

<details><summary><b>Office catering, and cheaper nights</b></summary>

- **Catering:** "catered lunch for 30 at the office Thursday" or "boxed lunches for 40" goes to caterers, never to a restaurant, and a team dinner never goes to a caterer. Caterers have their own per-head limit ($40) and a minimum order; the same reply triage, injection checks and payee-on-file rule apply. Four eval scenarios and six tests cover it.
- **Cheaper nights:** a private-room minimum often depends on the weekday. The venue sheet prices every night for the room and party size you picked and outlines the cheapest; when a proposal's room is meaningfully cheaper a few days either side (at least $150 and 12%), the booker's proposal says so, with the date and the saving.

</details>

<details><summary><b>Sign in as yourself, come back to your own history</b></summary>

Sign in from the top-left and pick your name (or type one). Everything you do as that person is kept in your browser under your name: bookings, approvals, deposits, cost-center codes and every agent run. Sign in again tomorrow and it's all still there, marked **earlier visit**, and still live: you can change or cancel an earlier booking, and the change goes through the same approval rules. Switching people reloads the app from the next person's own history, so nobody sees anyone else's. Nothing leaves the browser.

- **Invoice:** month tabs, tap a budget to filter, drag a dinner onto another budget, tap a line for its receipt (minimum, preferred rate, tax, service, deposit, payee on file, approvals) and jump to the agent run behind it.
- **Traces:** search every run, filter by outcome or by agent, and press ▶ to replay a run span by span.
- **Monitor:** every scheduled run as a strip you can tap, charts with per-run points, 10/30/all ranges, a countdown to the next run, and each run's scenarios, model decisions and full report.

Restoring is a store snapshot (`MemoryStore.snapshot()` / `restore()`), tested so a restored booking can't be booked twice.

</details>

<details><summary><b>Are the evals any good? Four checks on the checks</b></summary>

A green eval suite only matters if it would go red on the bugs you actually have. All four run in CI, and three run in your browser on the [Evals page](https://akilalours.github.io/thursday-dinner-concierge/#evals).

**1. Bug replay** (`npm run evals:replay`). Every fixed bug that changed agent behavior has a switch that turns the old code back on. The replay flips each one and re-runs every scenario, the real-user sweep and the ranking eval. **8/8 fixed bugs are caught again**, by different layers: R7 and R8 by real-user rows that check what the booker is told, R11 only by the ranking eval (warm hit@1 drops from 60% to 54%), R25 only by real-user rows. A bug no layer catches fails the build.

**2. Metamorphic testing** (`npm run evals:metamorphic`). No labels needed, only relations: every real-user and scenario sentence is retyped 11 ways a person might type it (ALL CAPS, all lowercase, pasted line breaks, doubled spaces, "please", "thanks!") and must make the same booking; a changed headcount must be followed. **1,078 checks.** On its first run it failed 91 of them and found two bugs:

| | What broke | Now |
|---|---|---|
| R26 | Text pasted from Slack or email with doubled spaces lost allergies, the neighborhood, "Christmas Eve" and the kind of event | Whitespace is normalized before parsing |
| R27 | "DINNER FOR 6 WITH ACME" and "dinner with acme" lost the client; "with Acme." kept the full stop | One-case sentences read the name after "with"; a name ends at a full stop |

**3. Classifier benchmark: rules vs the live model vs two hybrids** (`npm run evals:classifiers`). Precision, recall, a confusion matrix and 95% intervals for reply triage and injection detection:

Second live run, claude-sonnet-4-5, every model call answered ([`docs/classifiers.json`](docs/classifiers.json)). Reply-type accuracy with 95% intervals, and injections caught:

| Set | Emails | Rules | Model alone | Hybrid | **Hybrid strict (in production)** |
|---|---|---|---|---|---|
| Generated: label = the behavior that wrote it | 960 (others: 120 sampled) | 100% · 120/120 | 99.2% · 12/12 | 100% · 12/12 | **100%** · 12/12 |
| Dev: used to fix the rules | 36 | 100% · 6/6 | 86.1% · 6/6 | 100% · 6/6 | **100%** · 6/6 |
| Held-out: never used to change a rule | 62 | 40.3% (29–53) · 4/10 | 85.5% (75–92) · 10/10 | 79.0% (67–87) · 10/10 | **79.0%** (67–87) · 9/10 |
| **Fresh: written after the first hybrid run, never run before this one** | 40 | 55.0% (40–69) · 6/7 | 90.0% (77–96) · 7/7 | 92.5% (80–97) · 7/7 | **92.5%** (80–97) · 7/7 |
| Wrong actions on held-out | | 6 | 5 | **9** | **6** |
| Promotion gate | | baseline | stay in shadow | **stay in shadow** | **promote** |

**The promotion gate** moves a classifier from shadow to live only if the model answered at least 95% of what it was asked, and on every set it is at least as accurate as the rules, acts on a wrong reading no more often, catches every injection they catch, and never reads a decline or a payment request as an offer more often.

**How it got here, in order.** The first hybrid (rules decide what they are sure of, the model the rest) passed the original gate and went live. But on held-out it acted on a wrong reading 8–9 times against the rules' 6, because it decides emails the rules would hand to a person. So I added that rule to the gate, *before* the next run, and wrote down a stricter variant in advance: the model's answer counts only at 0.9 confidence or more. Because that variant was designed after the held-out set had been seen, I also wrote 40 **fresh** emails before running anything on them. On the second run, the tightened gate **demoted the first hybrid back to shadow** and promoted **hybrid strict**, which is now the agent's default: it keeps the rules' 100% where they are strong, roughly doubles accuracy on unseen emails (40% → 79% held-out, 55% → 92.5% fresh), and acts wrongly no more often than the rules. For scams, a flag from the rules always stands and the model can only add one. The model alone reads unseen emails best, but loses to the rules on the emails they were built from, so it stays in shadow. Numbers move a little between runs (model alone on held-out was 87.1% on the first run, 85.5% on this one), which is why every row has an interval.

The benchmark also found two bugs in emails the simulator itself writes ("we have no availability" wasn't a decline; "the minimum has gone up" wasn't a counter), now fixed, and three that only live runs could show:

- **The gate passed a model that never answered.** With a key that didn't work, every model call failed, fell back to the rules, scored exactly like them, and the gate said "promote". Now the model must have answered, a run where it answered nothing publishes no model numbers, and a test with a model that always errors keeps it that way.
- **The injection check threw away half the model's answers.** Its time limit was 3 s and the model answers in 2.7–3.2 s, so about half the time the rules decided instead, silently. Measured, then fixed (8 s; venue emails arrive over hours, so seconds don't matter). Model decisions went from 53 of 218 to 218 of 218.
- **An API hiccup mid-run.** One run lost every call after the first 81. The guard above refused to publish it, and the report now counts why each model call failed, so the next one is diagnosed, not guessed.

**4. Real users**, above: graded on outcome and on what they are told, with a one-click report from the app.

</details>

<details><summary><b>Try a sentence (each link runs it live)</b></summary>

- [“dinner for 12 with the Acme team next Thursday, somewhere private”](https://akilalours.github.io/thursday-dinner-concierge/?ask=dinner%20for%2012%20with%20the%20Acme%20team%20next%20Thursday%2C%20somewhere%20private#home)
- [“private dinner for 20 with Globex next Friday”](https://akilalours.github.io/thursday-dinner-concierge/?ask=private%20dinner%20for%2020%20with%20Globex%20next%20Friday#home)
- [“japanese dinner for 8 with Wayne Enterprises next Tuesday, private”](https://akilalours.github.io/thursday-dinner-concierge/?ask=japanese%20dinner%20for%208%20with%20Wayne%20Enterprises%20next%20Tuesday%2C%20private#home)
- [“team dinner for 8 this Friday under $100 a head”](https://akilalours.github.io/thursday-dinner-concierge/?ask=team%20dinner%20for%208%20this%20Friday%20under%20%24100%20a%20head#home)

</details>

<details><summary><b>Click any screen to open it</b></summary>

<table>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#partner"><img src="docs/img/partner.png" alt="Venue side"></a><br><b>Venue side</b> · you're the restaurant: answer the agent, win or lose the booking <a href="https://akilalours.github.io/thursday-dinner-concierge/#partner">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#invoice"><img src="docs/img/invoice.png" alt="Invoice"></a><br><b>Invoice</b> · one statement, pre-coded; drag a dinner onto a budget <a href="https://akilalours.github.io/thursday-dinner-concierge/#invoice">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/home.png" alt="Home"></a><br><b>Home</b> · one sentence → booked <a href="https://akilalours.github.io/thursday-dinner-concierge/#home">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#explore"><img src="docs/img/explore.png" alt="Explore"></a><br><b>Explore</b> · real NYC map → shortlist → RFP <a href="https://akilalours.github.io/thursday-dinner-concierge/#explore">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#chat"><img src="docs/img/chat.png" alt="Chat"></a><br><b>Chat</b> · “move it to Friday” <a href="https://akilalours.github.io/thursday-dinner-concierge/#chat">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#desk"><img src="docs/img/desk.png" alt="Live desk"></a><br><b>Live desk</b> · requests flow, you approve <a href="https://akilalours.github.io/thursday-dinner-concierge/#desk">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#compare"><img src="docs/img/compare.png" alt="Compare"></a><br><b>Compare</b> · every offer side by side <a href="https://akilalours.github.io/thursday-dinner-concierge/#compare">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#traces"><img src="docs/img/traces.png" alt="Traces"></a><br><b>Traces</b> · every agent step and Claude call <a href="https://akilalours.github.io/thursday-dinner-concierge/#traces">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#controls"><img src="docs/img/controls.png" alt="Controls"></a><br><b>Controls</b> · attack it; Postgres says no <a href="https://akilalours.github.io/thursday-dinner-concierge/#controls">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#fix"><img src="docs/img/fix.png" alt="Fix lab"></a><br><b>Fix lab</b> · a real failure, fixed, proven <a href="https://akilalours.github.io/thursday-dinner-concierge/#fix">open ↗</a></td></tr>
</table>

```bash
npm install && npm run demo        # or: npm test · npm run evals · npm run site:check
```


</details>
<details>
<summary><b>How it works</b></summary>

```mermaid
flowchart LR
  B["Booker's sentence"] --> C["Concierge<br/>parse · plan · recover"]
  C --> S["Sourcing<br/>filters + explained score"]
  S --> V["Coordination<br/>email · follow up · triage"]
  V --> M["Comparison<br/>policy · rank"]
  M --> P["Proposals"]
  P -- "approve (separate DB role)" --> A(("You"))
  A --> X["book · pay<br/>checked by Postgres"]
  V -. "venue emails (untrusted)" .-> W[("Simulated venues")]
```

| | |
|---|---|
| **Agents** | Concierge + sourcing, comparison, venue-coordination subagents. Follow up on silence, widen the search, re-plan, fall through after a double booking. |
| **Book again, like a delivery app** | Home greets the person, shows their past dinners as photo cards and asks a returning person "Book Kiso House again?". Any place opens a sheet: pick the room, guests and night, see the real all-in price against policy, and **similar places at about the same price that night**. Picking a place books that place: the concierge takes `preferVenueId`, puts it first when it fits, and says why when it cannot (2 new tests). Photos are real restaurant photographs (Unsplash License) standing in for the fictional venues. |
| **Orders and history** | Each person signs in by name and sees their own dinners like a delivery app's order history: upcoming, completed, cancelled, with the receipt and one-tap **Book again**. Add a 4-digit PIN and the same history follows them to any phone or laptop (kept on the server under a hash of name + PIN; 10 wrong PINs lock guessing out for an hour). Booking pages run on today's real date, so "tomorrow" means tomorrow. |
| **Changes after booking** | Amendments and cancellations are proposals too; an amendment swaps the booking atomically and rolls back if the new slot is taken. |
| **Spend control** | Policy as code: per-head caps, manager thresholds, notice; preferred corporate rates (12-15%) applied and reported. |
| **Typed tools** | zod in and out, run as the EA *for* the executive, idempotent, audited. `book`, `pay_deposit`, `amend_booking` and `cancel_booking` need an approved proposal. |
| **Evals** | 68 scenarios, invariant + expectation graders, LLM judge with calibration, recorded model calls replayed in CI, randomized fuzz. |
| **Memory** | Every venue reply leaves facts ("the Library really seats 10", "offered as asked", "declined"). Sourcing ranks on that track record next time. Private memories protected by row-level security. |
| **Both sides of the marketplace** | **Venue side**: a person stands in for the first venue the agent emails. Their reply (a quick reply or anything they type) goes through the same extraction, injection check and policy comparison as a simulated venue's, and they see what the agent read and why they won or lost. **Invoice**: every confirmed dinner on one statement, pre-coded to a cost center, PO and GL account, with PO balances that follow as you drag a line onto a budget, and a CSV export. |
| **Ranking eval** | `npm run evals:ranking`: 10 worlds where each venue has a hidden temperament, 400 past bookings, 600 held-out requests ranked with and without memory. First pick confirms 55% → 72%, MRR 0.72 → 0.82, hit@3 89% → 92%, 0 requests made worse. Gated in CI; runs live on the Memory page. |
| **Fast judgments** | Triage, SMS consent, urgency, injection. Threshold per label, timeout, safe fallback, `rules → shadow → live`. |
</details>

<details>
<summary><b>Safety, enforced by Postgres</b></summary>

| Rule | How |
|---|---|
| No booking or payment without every approval | `BEFORE INSERT` triggers |
| The agent can never approve | separate `ande_approver` role |
| Booking = exactly what was approved | trigger compares venue, room, party, time |
| Changes need approval, and never leave you with nothing | `amend_booking()` runs cancel + rebook in one transaction |
| No double booking | `EXCLUDE USING gist` |
| Pay only the payee on file, once | trigger + idempotency key |
| Private memories stay private | row-level security |
| History can't be rewritten | append-only audit log |
</details>

<details>
<summary><b>Bugs the evals caught</b></summary>

| | Bug |
|---|---|
| R1 | 7 pm dinner = midnight UTC → approver saw the wrong day |
| R2 | "the Library only seats 10" read as the offered room's capacity |
| R3 | Table for 4 priced as a private room → escalated as over budget |
| R4 | "Nov 18 at 7:30pm" parsed as a party of 18 |
| R5 | An offer carrying injected bank details was triaged as a payment request, losing the offer |
| R6 | **Found by the first live Claude run:** the extraction prompt didn't name the schema keys, so Claude returned its own field names and every offer silently fell back to rules |
| R7 | **Found by the LLM judge (1/5):** "japanese dinner" booked a Korean room; cuisine was a nudge, not a requirement. Now it books the cuisine or asks which constraint to relax |
| R8 | **Found by the LLM judge (4/5):** two vegetarians were sent to the venue but never confirmed to the booker |
| R9 | A model call that hit its timeout was retried, so a timeout cost twice the budget (an aborted fetch didn't say "timed out") |
| R10 | **Found on the live site with live Claude:** "somewhere in SoHo" booked Williamsburg. Claude returned "SoHo", venues say "soho", so the match never fired. Now normalized, a named area is a requirement, and the booker is told if nothing there fits |
| R11 | **Found by the ranking eval:** memory made the first pick slightly worse than no memory (54% vs 55%). A $2,180 quote for a 16-seat room was applied to the same venue's 8-seat room, dropping a venue that would confirm, and memory only kept bad news. Quotes now belong to their room, and offers made as asked count for a venue |
| R12 | **Found by the first real user:** "dinner for 2 next Friday, somewhere private" emailed nobody and said "I contacted 0 venues". Every private room's minimum spend split over 2 guests broke the $250 cap. Now it shortlists quiet tables and tells the booker why, with the number ("about $721 a head for 2"); the booker still approves |
| R13 | **Found testing as a real user:** "lunch with a client tomorrow, 3 people" (27 h ahead) emailed 8 venues then escalated: notice was measured when venues replied, not when the booker asked |
| R14 | **Found testing as a real user:** "12/3" and "Christmas Eve" weren't understood as dates |
| R15 | **Found testing as a real user:** a per-head budget nothing meets was a dead end; now it asks with the closest real price |
| R16 | **Found testing as a real user:** a dinner booked for Dec 3 never appeared, because the calendar showed a fixed 3 weeks |
| R17 | Venue replies in plain words ("Yes, our private room fits 10... minimum is $900") fell to the rules as "needs a human"; now read as offers with room, seats, minimum and deposit |
| R18 | **Real-user sweep:** "tmrw", "Wed", "sat at 8", "next fri" didn't resolve, and "Thursday the 19th" booked this Thursday |
| R19 | **Real-user sweep:** "dinner for me and 3 clients" asked how many guests; now 4, because the booker counts too |
| R20 | **Real-user sweep:** "$60pp" and "100 per person" without "under" were ignored, so an over-budget venue was booked |
| R21 | **Real-user sweep:** "7.30pm" crashed the parser (read as 42:00); "noon" booked 12:30 |
| R22 | **Real-user sweep:** allergies typed plainly ("no shellfish", "allergic to nuts") never reached the venue |
| R23 | **Real-user sweep:** a total budget ("$300 total", "budget 2k") was ignored; now divided into a per-head cap |
| R24 | An impossible model time ("25:00") could reach the booking; every time is now a real clock time |
| R25 | **Real-user sweep, graded on what the booker is told:** "thai food for 6" booked a Japanese room without saying there is no Thai venue; now it asks, listing what it can book |
| R26 | **Metamorphic testing:** text pasted with doubled spaces or line breaks lost allergies, the neighborhood, "Christmas Eve" and the kind of event |
| R27 | **Metamorphic testing:** ALL CAPS or all-lowercase requests lost the client; "with Acme." kept the full stop |
| R28 | **Found filming 12 bookings:** "$40 a head" proposed "$48 a head" and looked over budget (a stated budget is before tax and tip); the proposal now says "about $37 a head before tax and tip, within your $40" |
</details>

<details>
<summary><b>Live model</b></summary>

- Claude (`claude-sonnet-4-5`) parses requests, extracts offers from venue email and judges proposal messages. Every output is recorded under `evals/recordings/` and replayed in CI and on the live site, so anyone sees exactly what Claude answered, with no key.
- First full live run: 45/45 scenarios, Claude decided 45/45 request parses and 117/117 offer extractions. The judge scored every proposal message 5/5 except two (4/5 and 1/5); both were real bugs (R7, R8), now fixed and graded deterministically.
- Put your key in `.env` once (`ANTHROPIC_API_KEY=...`); `npm run llm:check` verifies it, `npm run evals:live` re-measures and rebuilds the site.
- The LLM judge is calibrated with `node evals/calibrate.ts --export` plus human labels.
</details>

<details>
<summary><b>Live mode: real Claude and real email</b></summary>

The page works with no server: it replays answers Claude really gave and uses your mail app for email. Deploy the small server in `server/` and the same page calls Claude live and sends real confirmation emails with a calendar invite.

```bash
npx wrangler login                               # free Cloudflare account
npx wrangler secret put ANTHROPIC_API_KEY --config server/wrangler.toml
npx wrangler secret put RESEND_API_KEY --config server/wrangler.toml   # free resend.com account
npm run server:deploy                            # prints https://thursday-dinner-api.<you>.workers.dev
```

Put that URL in `docs/config.js` (`window.TDC_API = "https://…workers.dev";`) and push. Claude then answers live on the site.
The server only accepts the agent's own tasks, caps tokens, rate-limits per visitor, and builds emails from booking fields only, so it is not an open model proxy or a spam relay (`test/worker.test.ts`). If a live call fails, the page falls back to the recording and says so.
</details>

<details>
<summary><b>Commands</b></summary>

```bash
npm run demo -- --ask "private dinner for 20 with Globex next Friday"   # you approve
npm test                                       # unit + contract + end to end
ANDE_PSQL="-h localhost -U postgres" npm test  # also on real Postgres
npm run evals && npm run fuzz
npm run llm:check                              # one real model call: is the key working?
npm run build:web                              # rebuild the live playground in docs/
npm run site:check                             # real-browser check of every page at 3 screen sizes + main flows
```
</details>

The site deploys through `.github/workflows/pages.yml`: it is rebuilt from source and published only after typecheck, tests, evals and the browser check pass.

<sub>All venues, companies and people are fictional. Independent project.</sub>
