// In-memory store that enforces the same rules as db/schema.sql. Used by unit tests and the eval suite.
import type { Proposal, Role, Venue } from "../domain/types.ts";
import { StoreError } from "./store.ts";
import type { BookingRow, Memory, PaymentRow, Step, Store, VenueFact } from "./store.ts";

export class MemoryStore implements Store {
  private now = new Date().toISOString();
  private venues = new Map<string, Venue>();
  private runs = new Set<string>();
  private stepLog = new Map<string, Step[]>();
  private calls = new Map<string, { output: unknown }>();
  private proposals = new Map<string, Proposal>();
  private bookings: (BookingRow & { status: "confirmed" | "cancelled" })[] = [];
  private payments: PaymentRow[] = [];
  private factRows: VenueFact[] = [];
  private memoryRows: Memory[] = [];
  private auditRows: { runId: string | null; actorId: string; action: string; detail: Record<string, unknown> }[] = [];

  setNow(iso: string) { this.now = iso; }

  async init(venues: Venue[]) { for (const v of venues) this.venues.set(v.id, v); }

  async createRun(run: { id: string }) { this.runs.add(run.id); this.stepLog.set(run.id, []); }

  async appendStep(runId: string, agent: string, kind: string, detail: Record<string, unknown>) {
    const log = this.stepLog.get(runId) ?? [];
    log.push({ seq: log.length + 1, agent, kind, detail: structuredClone(detail) });
    this.stepLog.set(runId, log);
  }

  async steps(runId: string) { return structuredClone(this.stepLog.get(runId) ?? []); }

  async findToolCall(key: string) { return this.calls.get(key) ?? null; }

  async saveToolCall(c: { key: string; output: unknown }) {
    if (!this.calls.has(c.key)) this.calls.set(c.key, { output: structuredClone(c.output) });
  }

  async createProposal(p: Proposal) {
    if (p.requiredRoles.length === 0) throw new StoreError("unknown", "a proposal needs at least one approver role");
    this.proposals.set(p.id, structuredClone({ ...p, approvedRoles: [], status: "pending" }));
  }

  async getProposal(id: string) { const p = this.proposals.get(id); return p ? structuredClone(p) : null; }

  async decide(proposalId: string, userId: string, role: Role, decision: "approve" | "reject") {
    const p = this.proposals.get(proposalId);
    if (!p) throw new StoreError("unknown", `no proposal ${proposalId}`);
    if (p.status !== "pending") throw new StoreError("not_pending", `proposal ${p.id} is ${p.status}, not pending`);
    if (userId === "agent") throw new StoreError("agent_cannot_approve", "the agent cannot approve its own proposal");
    if (!p.requiredRoles.includes(role)) throw new StoreError("role_not_required", `role ${role} is not required`);
    if (p.approvedRoles.includes(role)) throw new StoreError("not_pending", `role ${role} already decided`);
    if (decision === "reject") p.status = "rejected";
    else {
      p.approvedRoles.push(role);
      if (p.requiredRoles.every((r) => p.approvedRoles.includes(r))) p.status = "approved";
    }
    return structuredClone(p);
  }

  async getBooking(id: string) { const b = this.bookings.find((x) => x.id === id); return b ? structuredClone(b) : null; }

  async amend(proposalId: string, newBookingId: string) {
    const p = this.proposals.get(proposalId);
    if (!p || p.kind !== "amend" || p.status !== "approved") throw new StoreError("not_approved", "amendment needs an approved amend proposal");
    const old = this.bookings.find((x) => x.id === p.replacesBookingId);
    if (!old || old.status !== "confirmed") throw new StoreError("mismatch", "amendment must replace a confirmed booking");
    old.status = "cancelled";
    try {
      await this.book({ id: newBookingId, proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
    } catch (e) {
      old.status = "confirmed"; // same as the database: the whole change rolls back
      throw e;
    }
  }

  async cancel(proposalId: string) {
    const p = this.proposals.get(proposalId);
    if (!p || p.kind !== "cancel" || p.status !== "approved") throw new StoreError("not_approved", "cancellation needs an approved cancel proposal");
    const b = this.bookings.find((x) => x.id === p.replacesBookingId);
    if (!b || b.status !== "confirmed") throw new StoreError("mismatch", "cancellation must target a confirmed booking");
    b.status = "cancelled";
    p.status = "executed";
  }

  async book(b: BookingRow) {
    const p = this.proposals.get(b.proposalId);
    if (!p || (p.kind !== "book" && p.kind !== "amend") || p.status !== "approved") throw new StoreError("not_approved", "booking needs an approved book proposal");
    if (p.expiresAt < this.now) throw new StoreError("expired", `proposal ${p.id} expired`);
    if (b.venueId !== p.venueId || b.roomId !== p.roomId || b.partySize !== p.partySize
        || Date.parse(b.startsAt) !== Date.parse(p.startsAt) || Date.parse(b.endsAt) !== Date.parse(p.endsAt)) {
      throw new StoreError("mismatch", "booking does not match what the booker approved");
    }
    const overlap = this.bookings.some((x) => x.status === "confirmed" && x.roomId === b.roomId
      && Date.parse(x.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(x.endsAt));
    if (overlap) throw new StoreError("double_booked", `room ${b.roomId} is already booked then`);
    this.bookings.push({ ...b, status: "confirmed" });
    p.status = "executed";
  }

  async pay(pay: PaymentRow) {
    if (this.payments.some((x) => x.idempotencyKey === pay.idempotencyKey)) return; // retried call: already paid once
    const p = this.proposals.get(pay.proposalId);
    if (!p || p.kind !== "pay_deposit" || p.status !== "approved") throw new StoreError("not_approved", "payment needs an approved pay_deposit proposal");
    const b = this.bookings.find((x) => x.id === pay.bookingId);
    const v = b ? this.venues.get(b.venueId) : undefined;
    if (!b || !v || b.status !== "confirmed" || b.venueId !== p.venueId) throw new StoreError("mismatch", "payment must be for a confirmed booking at the approved venue");
    if (pay.payeeId !== v.payeeId || p.payeeId !== v.payeeId) throw new StoreError("payee_mismatch", `payee ${pay.payeeId} is not the payee on file for ${v.id}`);
    if (pay.amountCents > p.amountCents) throw new StoreError("over_amount", "payment exceeds the approved amount");
    this.payments.push(pay);
    p.status = "executed";
  }

  async addFact(f: VenueFact) { this.factRows.push(structuredClone(f)); }
  async facts(venueId: string) { return this.factRows.filter((f) => f.venueId === venueId).map((f) => structuredClone(f)); }

  async remember(m: Memory) { this.memoryRows.push({ ...m }); }
  async recall(companyId: string, userId: string) {
    return this.memoryRows.filter((m) => m.companyId === companyId && (m.scope === "company" || m.ownerUserId === userId));
  }

  async audit(runId: string | null, actorId: string, action: string, detail: Record<string, unknown>) {
    this.auditRows.push({ runId, actorId, action, detail: structuredClone(detail) });
  }
  async auditLog(runId: string) {
    return this.auditRows.filter((a) => a.runId === runId).map(({ actorId, action, detail }) => ({ actorId, action, detail }));
  }

  /** Test helpers. */
  allBookings() { return structuredClone(this.bookings); }
  allPayments() { return structuredClone(this.payments); }
}
