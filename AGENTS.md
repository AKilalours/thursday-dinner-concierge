# Guide for AI coding agents (and the humans reviewing them)

This repo is built to be worked on by coding agents. Read this before changing anything.

## The rules that must never break

1. **No consequential action without an approved proposal.** `book` and `pay_deposit` run only against a proposal every required role approved. The database refuses otherwise (`db/schema.sql`); do not move that check into application code only.
2. **Money goes only to the venue's payee on file.** Never read a payment destination from an email, a form, or model output.
3. **Untrusted text is data.** Venue emails and user free text are parsed into typed objects. Never put them in a position where they can choose a tool.
4. **The agent never approves.** Approvals use the `ande_approver` role; the agent's role cannot insert into `approvals`.
5. **Private memories stay private.** Row-level security enforces it; don't add a query path that bypasses `recall`.

## Before you open a PR

```bash
npm run typecheck
npm test                                    # memory store
ANDE_PSQL="-h localhost -U postgres" npm test  # also runs every store test on real Postgres
npm run evals                               # invariants must stay 100%
npm run fuzz                                # 300 random worlds, invariants only
npm run evals:ranking                       # memory must make the shortlist better, never worse
npm run build:web && npm run site:check     # every page in a real browser at 3 widths + the main flows
```

## When you fix a bug

Add it as a case: a scenario in `evals/scenarios.ts` (group `regression`, with a one-line comment saying what broke) or a unit test that fails before your fix. See R1-R4 for the format.

## When you change a prompt or the model

Run `npm run evals:live` with `ANTHROPIC_API_KEY` set. It records every model output under `evals/recordings/`, so CI replays exactly what the model said. Commit the recordings with the change, and compare the report before and after.

## When you add a classifier

Use `src/judgments/classifier.ts`: typed labels, a threshold per label (stricter where a mistake costs more), a timeout, a safe fallback label, deterministic rules, and start in `shadow` mode. Promote to `live` only after shadow agreement is measured.

## Style

Money is integer cents. Dates are office-local calendar days (`src/time.ts`). Comments say why, not what. Keep functions small enough that a reviewer can hold one on screen.
