// The concierge's capabilities. Read tools look things up; message tools talk to venues and bookers;
// book and pay_deposit are consequential and only work against an approved proposal.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Offer, Proposal } from "../domain/types.ts";
import { hoursBetween, startsAt, weekday } from "../time.ts";
import type { Ctx, Tool } from "./registry.ts";

const tool = <I, O>(t: Tool<I, O>) => t;

export const sendVenueEmail = tool({
  name: "send_venue_email",
  description: "Email a venue's events team: an inquiry, a follow-up, or an answer to their question.",
  consequential: false,
  input: z.object({
    venueId: z.string(), threadId: z.string(), kind: z.enum(["inquiry", "follow_up", "answer", "change", "cancel"]), body: z.string().min(10),
    meta: z.object({ date: z.string(), time: z.string(), partySize: z.number().int(), privateRoom: z.boolean(), roomId: z.string().optional() }).optional(),
  }),
  output: z.object({ messageId: z.string(), sentAt: z.string() }),
  async run(ctx, i) {
    const v = ctx.venues.find((x) => x.id === i.venueId);
    if (!v) throw new Error(`unknown venue ${i.venueId}`);
    const subject = `Private dining inquiry: ${i.meta ? `${i.meta.partySize} guests` : "group dinner"} for ${ctx.company.name}`;
    const m = ctx.world.send(i.venueId, i.threadId, subject, i.body, i.kind, i.meta);
    return { messageId: m.id, sentAt: m.at };
  },
});

export const createProposal = tool({
  name: "create_proposal",
  description: "Prepare a booking or deposit for the booker to confirm. Nothing happens until every required role approves.",
  consequential: false,
  input: Proposal.omit({ id: true, approvedRoles: true, status: true }),
  output: z.object({ proposalId: z.string() }),
  async run(ctx, i) {
    const id = `prop_${randomUUID().slice(0, 8)}`;
    await ctx.store.createProposal({ ...i, id, approvedRoles: [], status: "pending" });
    return { proposalId: id };
  },
});

export const book = tool({
  name: "book",
  description: "Confirm the reservation exactly as approved. Refused without an approved, unexpired book proposal.",
  consequential: true,
  input: z.object({ proposalId: z.string() }),
  output: z.object({ bookingId: z.string() }),
  async run(ctx, i) {
    const p = await ctx.store.getProposal(i.proposalId);
    if (!p) throw new Error(`no proposal ${i.proposalId}`);
    const bookingId = `bk_${randomUUID().slice(0, 8)}`;
    await ctx.store.book({ id: bookingId, proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
    return { bookingId };
  },
});

export const payDeposit = tool({
  name: "pay_deposit",
  description: "Pay the approved deposit to the venue's payee on file. Payment details in emails are never used.",
  consequential: true,
  input: z.object({ proposalId: z.string(), bookingId: z.string(), idempotencyKey: z.string() }),
  output: z.object({ paymentId: z.string(), payeeId: z.string(), amountCents: z.number() }),
  async run(ctx, i) {
    const p = await ctx.store.getProposal(i.proposalId);
    if (!p) throw new Error(`no proposal ${i.proposalId}`);
    const v = ctx.venues.find((x) => x.id === p.venueId)!;
    const paymentId = `pay_${randomUUID().slice(0, 8)}`;
    await ctx.store.pay({ id: paymentId, idempotencyKey: i.idempotencyKey, proposalId: p.id, bookingId: i.bookingId, payeeId: v.payeeId, amountCents: p.amountCents });
    return { paymentId, payeeId: v.payeeId, amountCents: p.amountCents };
  },
});

export const amendBooking = tool({
  name: "amend_booking",
  description: "Change a confirmed booking (date, time or headcount) exactly as approved. Cancel and rebook happen in one transaction; if the new slot is taken, the original booking survives.",
  consequential: true,
  input: z.object({ proposalId: z.string() }),
  output: z.object({ bookingId: z.string(), replaced: z.string() }),
  async run(ctx, i) {
    const p = await ctx.store.getProposal(i.proposalId);
    if (!p || p.kind !== "amend" || !p.replacesBookingId) throw new Error(`no amend proposal ${i.proposalId}`);
    const bookingId = `bk_${randomUUID().slice(0, 8)}`;
    await ctx.store.amend(p.id, bookingId);
    return { bookingId, replaced: p.replacesBookingId };
  },
});

export const cancelBooking = tool({
  name: "cancel_booking",
  description: "Cancel a confirmed booking against an approved cancel proposal. Reports whether the deposit is refundable under the venue's window.",
  consequential: true,
  input: z.object({ proposalId: z.string() }),
  output: z.object({ cancelled: z.string(), depositRefundable: z.boolean(), hoursBefore: z.number() }),
  async run(ctx, i) {
    const p = await ctx.store.getProposal(i.proposalId);
    if (!p || p.kind !== "cancel" || !p.replacesBookingId) throw new Error(`no cancel proposal ${i.proposalId}`);
    const v = ctx.venues.find((x) => x.id === p.venueId)!;
    const hoursBefore = Math.round(hoursBetween(ctx.world.now, p.startsAt));
    await ctx.store.cancel(p.id);
    return { cancelled: p.replacesBookingId, depositRefundable: hoursBefore >= v.cancellationHours, hoursBefore };
  },
});

export const notifyBooker = tool({
  name: "notify_booker",
  description: "Message the booker. Texts only if they have not opted out; email otherwise.",
  consequential: false,
  input: z.object({ text: z.string().min(1).max(1200) }),
  output: z.object({ channel: z.enum(["sms", "email"]) }),
  async run(ctx, i) {
    const channel = ctx.actor.phone && !ctx.smsOptedOut.has(ctx.actor.id) ? "sms" as const : "email" as const;
    const e = { at: ctx.world.now, agent: "concierge", kind: `to_booker_${channel}`, text: i.text };
    ctx.trace.push(e);
    ctx.onEvent?.(e);
    return { channel };
  },
});

export const recordFact = tool({
  name: "record_venue_fact",
  description: "Store a structured fact learned from a venue conversation, with its source message.",
  consequential: false,
  input: z.object({ venueId: z.string(), roomId: z.string().nullable(), kind: z.string(), value: z.any(), confidence: z.number().min(0).max(1), sourceMessageId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  async run(ctx, i) {
    await ctx.store.addFact({ ...i, value: i.value ?? null });
    return { ok: true as const };
  },
});

/** Helpers the agents share. */
export function roomFor(ctx: Ctx, venueId: string, offer: Offer | null, partySize: number, privateRoom: boolean) {
  const v = ctx.venues.find((x) => x.id === venueId)!;
  if (offer?.roomName) {
    const named = v.rooms.find((r) => r.name === offer.roomName);
    if (named) return named;
  }
  return v.rooms.filter((r) => (privateRoom ? r.private : true) && r.listedCapacity >= partySize)
    .sort((a, b) => (privateRoom ? 0 : Number(a.private) - Number(b.private)) || a.listedCapacity - b.listedCapacity)[0] ?? null;
}

export function eventWindow(date: string, time: string) {
  const start = startsAt(date, time);
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(Date.parse(start) + 3 * 3_600_000).toISOString() };
}

export function leadHours(nowIso: string, date: string, time: string) {
  return hoursBetween(nowIso, startsAt(date, time));
}

export function weekdayMin(roomMins: number[], date: string) {
  return roomMins[weekday(date)];
}
