// The typed vocabulary every agent, tool and store shares. Money is integer cents, never floats.
import { z } from "zod";

export const Cents = z.number().int().nonnegative();
export const Iso = z.string().datetime({ offset: true });

export const EventKind = z.enum(["client_dinner", "team_dinner", "client_lunch", "happy_hour"]);
export type EventKind = z.infer<typeof EventKind>;

/** What the concierge understands from one sentence. Every field the booker did not say is null, never guessed. */
export const BookingRequest = z.object({
  partySize: z.number().int().min(1).max(500),
  /** False when the sentence gave no headcount: the concierge asks rather than guessing. */
  partySizeStated: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateAmbiguous: z.boolean(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  kind: EventKind,
  clientName: z.string().nullable(),
  privateRoom: z.boolean(),
  neighborhood: z.string().nullable(),
  cuisine: z.string().nullable(),
  maxPerHeadCents: Cents.nullable(),
  dietary: z.array(z.string()),
  notes: z.string(),
});
export type BookingRequest = z.infer<typeof BookingRequest>;

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  private: z.boolean(),
  /** What the venue lists. Supply facts learned from conversations can override it. */
  listedCapacity: z.number().int(),
  /** Food and beverage minimum by weekday (0 = Sunday), in cents. */
  minSpendCents: z.array(Cents).length(7),
});
export type Room = z.infer<typeof Room>;

export const Venue = z.object({
  id: z.string(),
  name: z.string(),
  neighborhood: z.string(),
  cuisine: z.string(),
  perHeadCents: Cents,
  rooms: z.array(Room),
  email: z.string().email(),
  payeeId: z.string(),
  depositPct: z.number().min(0).max(100),
  contractRequired: z.boolean(),
  cancellationHours: z.number().int(),
  closedDays: z.array(z.number().int().min(0).max(6)),
});
export type Venue = z.infer<typeof Venue>;

/** What the coordination subagent extracts from a venue's email. Typed, so code can check it before anyone acts. */
export const Offer = z.object({
  venueId: z.string(),
  available: z.boolean(),
  roomName: z.string().nullable(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  capacity: z.number().int().nullable(),
  minSpendCents: Cents.nullable(),
  perHeadCents: Cents.nullable(),
  depositPct: z.number().min(0).max(100).nullable(),
  holdExpiresHours: z.number().nullable(),
  contractRequired: z.boolean().nullable(),
  /** A payment destination the email asked us to use. Never trusted: only the payee on file is ever paid. */
  requestedPaymentDestination: z.string().nullable(),
  alternativeDates: z.array(z.string()),
  sourceMessageId: z.string(),
});
export type Offer = z.infer<typeof Offer>;

export const Role = z.enum(["booker", "manager", "finance"]);
export type Role = z.infer<typeof Role>;

export const User = z.object({
  id: z.string(),
  name: z.string(),
  companyId: z.string(),
  roles: z.array(Role),
  /** Principals this user may act for, e.g. an EA booking for an executive. */
  actsFor: z.array(z.string()),
  phone: z.string().nullable(),
});
export type User = z.infer<typeof User>;

export const Policy = z.object({
  perHeadCapCents: z.object({ client_dinner: Cents, team_dinner: Cents, client_lunch: Cents, happy_hour: Cents }),
  managerApprovalAboveCents: Cents,
  financeApprovalDepositAbovePct: z.number(),
  minLeadHours: z.number(),
  blockedVenueIds: z.array(z.string()),
});
export type Policy = z.infer<typeof Policy>;

export const Company = z.object({
  id: z.string(),
  name: z.string(),
  officeNeighborhood: z.string(),
  policy: Policy,
});
export type Company = z.infer<typeof Company>;

export const ProposalKind = z.enum(["book", "pay_deposit"]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const ProposalStatus = z.enum(["pending", "approved", "rejected", "expired", "executed"]);

export const Proposal = z.object({
  id: z.string(),
  runId: z.string(),
  kind: ProposalKind,
  actorId: z.string(),
  principalId: z.string(),
  venueId: z.string(),
  roomId: z.string(),
  startsAt: Iso,
  endsAt: Iso,
  partySize: z.number().int(),
  amountCents: Cents,
  payeeId: z.string().nullable(),
  requiredRoles: z.array(Role),
  approvedRoles: z.array(Role),
  status: ProposalStatus,
  summary: z.string(),
  expiresAt: Iso,
});
export type Proposal = z.infer<typeof Proposal>;

export type Outcome = "booked" | "awaiting_approval" | "needs_clarification" | "escalated" | "rejected_by_booker";
