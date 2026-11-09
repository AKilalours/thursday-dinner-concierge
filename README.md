<h1 align="center">Thursday Dinner Concierge</h1>

<p align="center"><b>One sentence in. A booked, paid, on-policy dinner out. Nothing happens until you approve.</b><br><sub>Built for the Ande AI Engineer role · independent project · fictional venues and people</sub></p>

<p align="center">
  <a href="https://akilalours.github.io/thursday-dinner-concierge/"><img src="https://img.shields.io/badge/▶_Open_the_live_app-7b1e3a?style=for-the-badge" alt="Open the live app"></a>
  <a href="https://ande-thursday-dinner-concierge.streamlit.app"><img src="https://img.shields.io/badge/Streamlit-FF4B4B?style=for-the-badge&logo=streamlit&logoColor=white" alt="Streamlit"></a>
  <a href="docs/img/demo.mp4"><img src="https://img.shields.io/badge/45s_video-2b1d24?style=for-the-badge" alt="Video"></a>
</p>
<p align="center">
  <a href="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/ci.yml"><img src="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/pages.yml"><img src="https://github.com/AKilalours/thursday-dinner-concierge/actions/workflows/pages.yml/badge.svg" alt="deploy"></a>
  <img src="https://img.shields.io/badge/TypeScript-Node%2022-3178c6" alt="TypeScript"> <img src="https://img.shields.io/badge/Postgres-16-336791" alt="Postgres 16"> <img src="https://img.shields.io/badge/Claude-recorded_%26_replayed-d97757" alt="Claude">
</p>

<p align="center"><a href="https://akilalours.github.io/thursday-dinner-concierge/"><img src="docs/img/demo.gif" width="900" alt="One sentence: the agents email four venues, read the replies, ignore a prompt injection, compare, and the booker slides to approve"></a></p>

<table align="center"><tr>
<td align="center"><h3>47/47</h3>eval scenarios</td>
<td align="center"><h3>0 / 2,013</h3>safety failures<br>in random worlds</td>
<td align="center"><h3>90</h3>tests, incl.<br>real Postgres</td>
<td align="center"><h3>9</h3>bugs caught →<br>permanent cases</td>
</tr></table>

### ▶ Try a sentence (each link runs it live)

- [“dinner for 12 with the Acme team next Thursday, somewhere private”](https://akilalours.github.io/thursday-dinner-concierge/?ask=dinner%20for%2012%20with%20the%20Acme%20team%20next%20Thursday%2C%20somewhere%20private#home)
- [“private dinner for 20 with Globex on Nov 19”](https://akilalours.github.io/thursday-dinner-concierge/?ask=private%20dinner%20for%2020%20with%20Globex%20on%20Nov%2019#home)
- [“japanese dinner for 8 with Wayne Enterprises on Nov 24, private”](https://akilalours.github.io/thursday-dinner-concierge/?ask=japanese%20dinner%20for%208%20with%20Wayne%20Enterprises%20on%20Nov%2024%2C%20private#home)
- [“team dinner for 8 this Friday under $100 a head”](https://akilalours.github.io/thursday-dinner-concierge/?ask=team%20dinner%20for%208%20this%20Friday%20under%20%24100%20a%20head#home)

### Click any screen to open it

<table>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#home"><img src="docs/img/home.png" alt="Home"></a><br><b>Home</b> · one sentence → booked <a href="https://akilalours.github.io/thursday-dinner-concierge/#home">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#explore"><img src="docs/img/explore.png" alt="Explore"></a><br><b>Explore</b> · map → shortlist → RFP <a href="https://akilalours.github.io/thursday-dinner-concierge/#explore">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#chat"><img src="docs/img/chat.png" alt="Chat"></a><br><b>Chat</b> · “move it to Friday” <a href="https://akilalours.github.io/thursday-dinner-concierge/#chat">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#calendar"><img src="docs/img/calendar.png" alt="Calendar"></a><br><b>Calendar</b> · drag to reschedule <a href="https://akilalours.github.io/thursday-dinner-concierge/#calendar">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#compare"><img src="docs/img/compare.png" alt="Compare"></a><br><b>Compare</b> · every offer side by side <a href="https://akilalours.github.io/thursday-dinner-concierge/#compare">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#policy"><img src="docs/img/policy.png" alt="Policy"></a><br><b>Policy</b> · replay 47 requests first <a href="https://akilalours.github.io/thursday-dinner-concierge/#policy">open ↗</a></td></tr>
<tr><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#controls"><img src="docs/img/controls.png" alt="Controls"></a><br><b>Controls</b> · attack it; Postgres says no <a href="https://akilalours.github.io/thursday-dinner-concierge/#controls">open ↗</a></td><td width="50%" valign="top"><a href="https://akilalours.github.io/thursday-dinner-concierge/#fix"><img src="docs/img/fix.png" alt="Fix lab"></a><br><b>Fix lab</b> · a real failure, fixed, proven <a href="https://akilalours.github.io/thursday-dinner-concierge/#fix">open ↗</a></td></tr>
</table>

```bash
npm install && npm run demo        # or: npm test · npm run evals · npm run site:check
```

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
| **Changes after booking** | Amendments and cancellations are proposals too; an amendment swaps the booking atomically and rolls back if the new slot is taken. |
| **Spend control** | Policy as code: per-head caps, manager thresholds, notice; preferred corporate rates (12-15%) applied and reported. |
| **Typed tools** | zod in and out, run as the EA *for* the executive, idempotent, audited. `book`, `pay_deposit`, `amend_booking` and `cancel_booking` need an approved proposal. |
| **Evals** | 47 scenarios, invariant + expectation graders, LLM judge with calibration, recorded model calls replayed in CI, randomized fuzz. |
| **Memory** | Every venue reply leaves facts ("the Library really seats 10"). Sourcing uses them next time. Private memories protected by row-level security. |
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
</details>

<details>
<summary><b>Live model</b></summary>

- Claude (`claude-sonnet-4-5`) parses requests, extracts offers from venue email and judges proposal messages. Every output is recorded under `evals/recordings/` and replayed in CI and on the live site, so anyone sees exactly what Claude answered, with no key.
- First full live run: 45/45 scenarios, Claude decided 45/45 request parses and 117/117 offer extractions. The judge scored every proposal message 5/5 except two (4/5 and 1/5); both were real bugs (R7, R8), now fixed and graded deterministically.
- Put your key in `.env` once (`ANTHROPIC_API_KEY=...`); `npm run llm:check` verifies it, `npm run evals:live` re-measures and rebuilds the site.
- The LLM judge is calibrated with `node evals/calibrate.ts --export` plus human labels.
</details>

<details>
<summary><b>Commands</b></summary>

```bash
npm run demo -- --ask "private dinner for 20 with Globex on Nov 19"   # you approve
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
