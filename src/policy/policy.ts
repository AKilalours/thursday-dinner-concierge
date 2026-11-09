// Company policy is code, not a prompt. It decides what may be proposed and who must approve it.
import type { BookingRequest, Company, Offer, Role, Venue } from "../domain/types.ts";

/** NYC sales tax plus a 20% service charge: what the company will actually pay on top of the minimum. */
export const ALL_IN = 1.08875 + 0.2;

/** Venues list dinner pricing; lunch and drinks-only events cost a fraction of it. */
const KIND_FACTOR: Record<string, number> = { client_dinner: 1, team_dinner: 1, client_lunch: 0.55, happy_hour: 0.35 };
export function perHeadFor(venue: Venue, kind: string): number {
  return Math.round(venue.perHeadCents * (KIND_FACTOR[kind] ?? 1));
}

export interface Estimate { subtotalCents: number; allInCents: number; perHeadAllInCents: number }

export function estimate(partySize: number, perHeadCents: number, minSpendCents: number): Estimate {
  const subtotal = Math.max(minSpendCents, perHeadCents * partySize);
  const allIn = Math.round(subtotal * ALL_IN);
  return { subtotalCents: subtotal, allInCents: allIn, perHeadAllInCents: Math.round(allIn / partySize) };
}

export interface PolicyResult {
  onPolicy: boolean;
  violations: string[];
  requiredRoles: Role[];
  estimate: Estimate;
  depositCents: number;
}

export function checkPolicy(company: Company, req: BookingRequest, venue: Venue, offer: Pick<Offer, "minSpendCents" | "perHeadCents" | "depositPct" | "capacity">, leadHours: number): PolicyResult {
  const p = company.policy;
  const perHead = offer.perHeadCents ?? perHeadFor(venue, req.kind);
  const est = estimate(req.partySize, perHead, offer.minSpendCents ?? 0);
  const depositPct = offer.depositPct ?? venue.depositPct;
  const violations: string[] = [];
  if (p.blockedVenueIds.includes(venue.id)) violations.push(`${venue.name} is on the company's blocked list`);
  const cap = Math.min(p.perHeadCapCents[req.kind], req.maxPerHeadCents ? Math.round(req.maxPerHeadCents * ALL_IN) : Infinity);
  if (est.perHeadAllInCents > cap) violations.push(`about $${Math.round(est.perHeadAllInCents / 100)} a head all-in is over the $${Math.round(cap / 100)} limit`);
  if (leadHours < p.minLeadHours) violations.push(`only ${Math.round(leadHours)} h notice; policy needs ${p.minLeadHours} h`);
  if (offer.capacity !== null && offer.capacity < req.partySize) violations.push(`the room seats ${offer.capacity}, the party is ${req.partySize}`);
  const roles: Role[] = ["booker"];
  if (est.allInCents > p.managerApprovalAboveCents) roles.push("manager");
  if (depositPct > p.financeApprovalDepositAbovePct) roles.push("finance");
  return { onPolicy: violations.length === 0, violations, requiredRoles: roles, estimate: est, depositCents: Math.round(((offer.minSpendCents || est.subtotalCents) * depositPct) / 100) };
}
