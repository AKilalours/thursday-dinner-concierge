// One interface, two implementations: in-memory (fast unit tests and evals) and Postgres (production).
// test/store.contract.test.ts runs the same safety tests against both, so they cannot drift apart.
import type { Proposal, Role, Venue } from "../domain/types.ts";

export type StoreErrorCode =
  | "not_approved" | "agent_cannot_approve" | "role_not_required" | "not_pending"
  | "payee_mismatch" | "over_amount" | "double_booked" | "mismatch" | "expired" | "forbidden" | "unknown";

export class StoreError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Step { seq: number; agent: string; kind: string; detail: Record<string, unknown> }
export interface VenueFact {
  venueId: string; roomId: string | null; kind: string; value: unknown; confidence: number; sourceMessageId: string;
}
export interface Memory { companyId: string; scope: "company" | "private"; ownerUserId: string; subject: string; fact: string; source: string }
export interface BookingRow { id: string; proposalId: string; venueId: string; roomId: string; startsAt: string; endsAt: string; partySize: number }
export interface PaymentRow { id: string; idempotencyKey: string; proposalId: string; bookingId: string; payeeId: string; amountCents: number }

export interface Store {
  /** The simulated clock in evals, the wall clock in production. Expiry checks use it. */
  setNow(iso: string): void;
  init(venues: Venue[]): Promise<void>;
  createRun(run: { id: string; actorId: string; principalId: string; requestText: string }): Promise<void>;
  appendStep(runId: string, agent: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  steps(runId: string): Promise<Step[]>;
  findToolCall(key: string): Promise<{ output: unknown } | null>;
  saveToolCall(c: { key: string; runId: string; tool: string; actorId: string; principalId: string; input: unknown; output: unknown }): Promise<void>;
  createProposal(p: Proposal): Promise<void>;
  getProposal(id: string): Promise<Proposal | null>;
  /** The approver path. In Postgres it runs under a role the agent does not have. */
  decide(proposalId: string, userId: string, role: Role, decision: "approve" | "reject"): Promise<Proposal>;
  book(b: BookingRow): Promise<void>;
  pay(p: PaymentRow): Promise<void>;
  addFact(f: VenueFact): Promise<void>;
  facts(venueId: string): Promise<VenueFact[]>;
  remember(m: Memory): Promise<void>;
  /** Memories visible to this user: their company's shared ones plus their own private ones. */
  recall(companyId: string, userId: string): Promise<Memory[]>;
  audit(runId: string | null, actorId: string, action: string, detail: Record<string, unknown>): Promise<void>;
  auditLog(runId: string): Promise<{ actorId: string; action: string; detail: Record<string, unknown> }[]>;
}
