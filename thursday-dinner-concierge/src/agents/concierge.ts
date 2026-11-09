// The root concierge. It plans the run, delegates to sourcing, coordination and comparison, recovers
// when a step fails, and turns the best option into proposals a booker confirms. It never approves;
// approvals arrive through the approver (the booker-facing app), which uses a separate database role.
import { randomUUID } from "node:crypto";
import { COMPANY, USERS } from "../../data/seed.ts";
import type { BookingRequest, Company, Outcome, Proposal, Role, User, Venue } from "../domain/types.ts";
import type { Mode } from "../judgments/classifier.ts";
import { urgency } from "../judgments/judgments.ts";
import type { LLM } from "../llm/client.ts";
import { parseRequest } from "../parse/request.ts";
import type { VenueWorld } from "../sim/world.ts";
import { StoreError } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import { addDays, startsAt, weekday } from "../time.ts";
import type { Ctx, TraceEvent } from "../tools/registry.ts";
import { call, log } from "../tools/registry.ts";
import { book, createProposal, eventWindow, leadHours, notifyBooker, payDeposit } from "../tools/tools.ts";
import { compare } from "./comparison.ts";
import type { Option } from "./comparison.ts";
import { coordinate } from "./coordination.ts";
import { source } from "./sourcing.ts";

/** The booker-facing app. Returns decisions per role, or null if nobody has answered yet. */
export type Approver = (p: Proposal, store: Store) => Promise<"approved" | "rejected" | "pending">;

export interface RunInput {
  text: string;
  actor: User;
  principal: User;
  today: string;
  store: Store;
  world: VenueWorld;
  llm: LLM;
  venues: Venue[];
  approver: Approver;
  company?: Company;
  judgmentMode?: Mode;
  smsOptedOut?: Set<string>;
  maxRounds?: number;
  onEvent?: (e: TraceEvent) => void;
}

export interface RunResult {
  runId: string;
  outcome: Outcome;
  request: BookingRequest | null;
  proposals: Proposal[];
  bookingId: string | null;
  paymentId: string | null;
  chosenVenueId: string | null;
  messagesToBooker: string[];
  trace: TraceEvent[];
  parseDecidedBy: "model" | "rules";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const human = (d: string) => `${DAYS[weekday(d)]} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
const clock = (t: string) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; };
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

export function approverFor(role: Role, actor: User): User {
  if (role === "booker") return actor;
  return USERS.find((u) => u.roles.includes(role))!;
}

export async function runConcierge(input: RunInput): Promise<RunResult> {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const ctx: Ctx = {
    store: input.store, world: input.world, llm: input.llm, company: input.company ?? COMPANY, venues: input.venues,
    actor: input.actor, principal: input.principal, runId, today: input.today, smsOptedOut: input.smsOptedOut ?? new Set(), trace: [], onEvent: input.onEvent,
  };
  const mode = input.judgmentMode ?? "rules";
  const result: RunResult = { runId, outcome: "escalated", request: null, proposals: [], bookingId: null, paymentId: null, chosenVenueId: null, messagesToBooker: [], trace: ctx.trace, parseDecidedBy: "rules" };
  const tell = async (text: string) => {
    result.messagesToBooker.push(text);
    await call(ctx, "concierge", notifyBooker, { text }, `${runId}:notify:${result.messagesToBooker.length}`);
  };
  input.store.setNow(ctx.world.now);
  await input.store.createRun({ id: runId, actorId: input.actor.id, principalId: input.principal.id, requestText: input.text });

  // 1. Understand the request.
  const parsed = await parseRequest(ctx.llm, input.text, input.today);
  const req = parsed.request;
  result.request = req;
  result.parseDecidedBy = parsed.decidedBy;
  await log(ctx, "concierge", "parsed", `${req.partySize} guests, ${req.date ?? "no date"} ${req.time}, ${req.kind}${req.privateRoom ? ", private" : ""}${req.clientName ? `, with ${req.clientName}` : ""}`, { request: req, decidedBy: parsed.decidedBy });

  if (!req.partySizeStated || !req.date) {
    result.outcome = "needs_clarification";
    await tell(`Happy to set this up. ${!req.partySizeStated ? "How many guests? " : ""}${!req.date ? "Which date should I book? " : ""}`.trim());
    return result;
  }
  const lead = leadHours(ctx.world.now, req.date, req.time);
  if (lead < 0) {
    result.outcome = "needs_clarification";
    await tell(`${human(req.date)} at ${req.time} has already passed. Which date did you mean?`);
    return result;
  }
  if (lead < ctx.company.policy.minLeadHours) {
    result.outcome = "escalated";
    await tell(`${human(req.date)} at ${req.time} is ${Math.round(lead)} h away; policy needs ${ctx.company.policy.minLeadHours} h notice, so I've passed this to the concierge team to handle by phone with your manager's sign-off.`);
    return result;
  }
  const urg = await urgency(ctx.llm, mode).classify({ text: input.text, hoursUntil: lead });
  await log(ctx, "concierge", "urgency", `${urg.label} (${urg.reason})`);

  // 2-4. Source, coordinate, compare; widen the search if a round produces nothing usable.
  const contacted = new Set<string>();
  const alternatives: { venue: string; dates: string[] }[] = [];
  let options: Option[] = [];
  const rounds = input.maxRounds ?? 2;
  for (let round = 1; round <= rounds && options.length === 0; round++) {
    const candidates = (await source(ctx, req, contacted)).slice(0, urg.label === "urgent" ? 4 : 3);
    if (!candidates.length) break;
    candidates.forEach((c) => contacted.add(c.venue.id));
    const threads = await coordinate(ctx, req, candidates, { urgency: urg.label, judgmentMode: mode });
    const cmp = await compare(ctx, req, threads);
    alternatives.push(...cmp.alternatives);
    options = cmp.usable;
    if (!options.length) await log(ctx, "concierge", "replan", `round ${round}: nothing usable (${cmp.rejected.map((r) => `${r.venue}: ${r.why}`).join("; ")}); widening the search`);
  }

  if (!options.length) {
    result.outcome = "escalated";
    const alt = alternatives.length ? ` ${alternatives.map((a) => `${a.venue} could do ${a.dates.map(human).join(" or ")}`).join("; ")}. Want one of those instead?` : "";
    await tell(`I contacted ${contacted.size} venues and none could host ${req.partySize} on ${human(req.date)} within policy.${alt} I've also flagged it to the concierge team.`);
    return result;
  }

  // 5-7. Propose, wait for the booker, execute; on failure fall through to the next option.
  for (const opt of options.slice(0, 2)) {
    const outcome = await proposeAndExecute(ctx, req, opt, input, result, tell, input.text);
    if (outcome !== "try_next") return result;
  }
  result.outcome = "escalated";
  await tell("The top options fell through after approval; I've flagged this to the concierge team.");
  return result;
}

async function proposeAndExecute(ctx: Ctx, req: BookingRequest, opt: Option, input: RunInput, result: RunResult,
  tell: (t: string) => Promise<void>, text: string): Promise<"done" | "try_next"> {
  const v = opt.thread.venue;
  const room = v.rooms.find((r) => r.id === opt.roomId)!;
  const win = eventWindow(req.date!, req.time);
  const holdH = Math.min(opt.thread.offer?.holdExpiresHours ?? 24, 48);
  const expiresAt = new Date(Math.min(Date.parse(ctx.world.now) + holdH * 3_600_000, Date.parse(startsAt(req.date!, req.time)))).toISOString();
  const caveats = [
    req.dateAmbiguous ? `I read "${text.match(/next \w+/i)?.[0] ?? "the date"}" as ${human(req.date!)}; reject if you meant ${human(addDays(req.date!, 7))}.` : "",
    opt.thread.injectionFlagged ? `${v.name}'s email contained instructions to change payment details; I ignored them and will only pay the venue's account on file.` : "",
    v.contractRequired ? `${v.name} requires its private dining agreement; approving authorizes signing it.` : "",
    opt.policy.requiredRoles.includes("manager") ? `Over ${usd(ctx.company.policy.managerApprovalAboveCents)}, so ${approverFor("manager", ctx.actor).name} also approves.` : "",
  ].filter(Boolean);
  const summary = `${v.name}, ${room.name}, ${human(req.date!)} at ${clock(req.time)}, ${req.partySize} guests${req.clientName ? ` with ${req.clientName}` : ""}. `
    + `Minimum ${usd(opt.minSpendCents)}; about ${usd(opt.policy.estimate.allInCents)} all-in (${usd(opt.policy.estimate.perHeadAllInCents)} a head, under the ${usd(ctx.company.policy.perHeadCapCents[req.kind])} cap). `
    + (v.preferredRatePct ? `Preferred corporate rate: ${v.preferredRatePct}% off, saving about ${usd(opt.policy.estimate.savingsCents)}. ` : "")
    + `Deposit ${opt.policy.depositCents ? usd(opt.policy.depositCents) : "none"}; free cancellation until ${v.cancellationHours} h before.`;

  const base = { runId: ctx.runId, actorId: ctx.actor.id, principalId: ctx.principal.id, venueId: v.id, roomId: room.id, ...win, partySize: req.partySize, requiredRoles: opt.policy.requiredRoles, expiresAt };
  const bookP = await call(ctx, "concierge", createProposal, { ...base, kind: "book", amountCents: opt.policy.estimate.allInCents, payeeId: null, summary });
  const depP = opt.policy.depositCents > 0
    ? await call(ctx, "concierge", createProposal, { ...base, kind: "pay_deposit", amountCents: opt.policy.depositCents, payeeId: v.payeeId, summary: `Deposit for ${v.name}` })
    : null;
  const proposals = [bookP.proposalId, depP?.proposalId].filter((x): x is string => !!x);
  for (const id of proposals) result.proposals.push((await ctx.store.getProposal(id))!);
  result.chosenVenueId = v.id;
  await tell(`${summary}${caveats.length ? ` ${caveats.join(" ")}` : ""} Reply approve or reject.`);
  await log(ctx, "concierge", "proposed", `proposal sent to the booker (${opt.policy.requiredRoles.join(" + ")} must approve)`, { proposals, requiredRoles: opt.policy.requiredRoles });

  const decisions = [];
  for (const id of proposals) decisions.push(await input.approver((await ctx.store.getProposal(id))!, ctx.store));
  result.proposals = await Promise.all(proposals.map(async (id) => (await ctx.store.getProposal(id))!));
  if (decisions.includes("rejected")) {
    result.outcome = "rejected_by_booker";
    await log(ctx, "concierge", "rejected", "the booker rejected the proposal; nothing was booked or paid");
    await tell("Understood, nothing was booked. Tell me what to change and I'll look again.");
    return "done";
  }
  if (decisions.includes("pending")) {
    result.outcome = "awaiting_approval";
    await log(ctx, "concierge", "waiting", "waiting for approval; the hold expires at " + expiresAt);
    return "done";
  }

  try {
    const bk = await call(ctx, "concierge", book, { proposalId: bookP.proposalId }, `${bookP.proposalId}:book`);
    result.bookingId = bk.bookingId;
    if (depP) {
      const pay = await call(ctx, "concierge", payDeposit, { proposalId: depP.proposalId, bookingId: bk.bookingId, idempotencyKey: `${depP.proposalId}:pay` }, `${depP.proposalId}:pay`);
      result.paymentId = pay.paymentId;
    }
  } catch (e) {
    if (e instanceof StoreError && (e.code === "double_booked" || e.code === "expired")) {
      await log(ctx, "concierge", "recover", `${v.name}: ${e.code.replace("_", " ")}; moving to the next option`);
      result.bookingId = null;
      return "try_next";
    }
    throw e;
  }
  await ctx.store.remember({ companyId: ctx.company.id, scope: "company", ownerUserId: ctx.actor.id, subject: req.clientName ?? "team", fact: `hosted_at:${v.id}`, source: ctx.runId });
  result.outcome = "booked";
  await log(ctx, "concierge", "booked", `booked ${v.name}${result.paymentId ? " and paid the deposit to the payee on file" : ""}`);
  await tell(`Confirmed: ${v.name}, ${room.name}, ${human(req.date!)} at ${clock(req.time)} for ${req.partySize}.${result.paymentId ? ` Deposit of ${usd(opt.policy.depositCents)} paid to ${v.name}'s account on file.` : ""} I'll send the calendar invite and remind the venue of dietary needs a week out.`);
  return "done";
}

/** An approver that behaves like a careful booker: approves only what matches the request, as each required role. */
export function carefulApprover(actor: User, expect: { partySize: number; date: string; privateRoom: boolean }, opts: { managerResponds?: boolean } = {}): Approver {
  return async (p, store) => {
    const localDate = new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10); // office time, UTC-5
    const room = (await store.getProposal(p.id))!;
    const matches = room.partySize === expect.partySize && localDate === expect.date;
    for (const role of p.requiredRoles) {
      if (role === "manager" && opts.managerResponds === false) return "pending";
      const updated = await store.decide(p.id, approverFor(role, actor).id, role, matches ? "approve" : "reject");
      if (updated.status === "rejected") return "rejected";
    }
    return (await store.getProposal(p.id))!.status === "approved" ? "approved" : "pending";
  };
}
