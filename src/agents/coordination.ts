// Venue coordination subagent: emails venues, waits, follows up, reads every reply as untrusted data,
// answers simple questions, and turns replies into typed offers and supply facts.
import type { BookingRequest, Offer, Venue } from "../domain/types.ts";
import { injection, replyTriage } from "../judgments/judgments.ts";
import type { Triage, Urgency } from "../judgments/judgments.ts";
import type { Mode } from "../judgments/classifier.ts";
import { factsFrom } from "../memory/supply.ts";
import { extractOffer } from "../parse/offer.ts";
import type { Message } from "../sim/world.ts";
import { weekday } from "../time.ts";
import type { Ctx } from "../tools/registry.ts";
import { call, log } from "../tools/registry.ts";
import { recordFact, sendVenueEmail } from "../tools/tools.ts";
import type { Candidate } from "./sourcing.ts";

export type ThreadStatus = "waiting" | "followed_up" | "offer" | "declined" | "no_reply" | "needs_human";

export interface Thread {
  venue: Venue;
  candidate: Candidate;
  threadId: string;
  sentAt: string;
  status: ThreadStatus;
  offer: Offer | null;
  triage: Triage | null;
  injectionFlagged: boolean;
  notes: string[];
}

const CADENCE: Record<Urgency, { followUpH: number; giveUpH: number }> = {
  urgent: { followUpH: 2, giveUpH: 6 },
  soon: { followUpH: 4, giveUpH: 24 },
  normal: { followUpH: 8, giveUpH: 36 },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: string) => `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(d)]}, ${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;

export function inquiryBody(ctx: Ctx, req: BookingRequest, venue: Venue): string {
  const room = req.privateRoom ? "a private room" : "a table";
  const lines = [
    `Hello ${venue.name} team,`,
    "",
    `I'm reaching out on behalf of ${ctx.principal.name} at ${ctx.company.name}. We'd like ${room} for ${req.partySize} guests on ${longDate(req.date!)} at ${req.time}${req.clientName ? `, a dinner with our guests from ${req.clientName}` : ""}.`,
    req.dietary.length ? `Dietary notes: ${req.dietary.join(", ")}.` : "",
    "Could you let us know availability, the food and beverage minimum, deposit terms, and how long you can hold the date?",
    "",
    `Thank you,\nConcierge desk for ${ctx.actor.name}, ${ctx.company.name}`,
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}

export interface CoordinationOptions { urgency: Urgency; judgmentMode: Mode }

export async function coordinate(ctx: Ctx, req: BookingRequest, candidates: Candidate[], opts: CoordinationOptions): Promise<Thread[]> {
  const triage = replyTriage(ctx.llm, opts.judgmentMode);
  const inject = injection(ctx.llm, opts.judgmentMode);
  const cadence = CADENCE[opts.urgency];
  const threads: Thread[] = [];

  for (const c of candidates) {
    const threadId = `thr_${ctx.runId}_${c.venue.id}`;
    const sent = await call(ctx, "coordination", sendVenueEmail, {
      venueId: c.venue.id, threadId, kind: "inquiry", body: inquiryBody(ctx, req, c.venue),
      meta: { date: req.date!, time: req.time, partySize: req.partySize, privateRoom: req.privateRoom },
    });
    threads.push({ venue: c.venue, candidate: c, threadId, sentAt: sent.sentAt, status: "waiting", offer: null, triage: null, injectionFlagged: false, notes: [] });
  }
  await log(ctx, "coordination", "inquiries_sent", `emailed ${threads.map((t) => t.venue.name).join(", ")}`);

  const open = () => threads.filter((t) => t.status === "waiting" || t.status === "followed_up");
  const elapsed = (t: Thread) => (Date.parse(ctx.world.now) - Date.parse(t.sentAt)) / 3_600_000;

  for (let hour = 0; hour < cadence.giveUpH + 1 && open().length; hour++) {
    const arrived = ctx.world.advance(1);
    for (const msg of arrived) {
      const t = threads.find((x) => x.threadId === msg.threadId);
      if (t && (t.status === "waiting" || t.status === "followed_up")) await handleReply(ctx, req, t, msg, triage, inject);
    }
    for (const t of open()) {
      if (t.status === "waiting" && elapsed(t) >= cadence.followUpH) {
        await call(ctx, "coordination", sendVenueEmail, {
          venueId: t.venue.id, threadId: t.threadId, kind: "follow_up",
          body: `Hi again, just following up on our request for ${req.partySize} guests on ${longDate(req.date!)}. Is the date still possible? Thank you!`,
        });
        t.status = "followed_up";
        await log(ctx, "coordination", "followed_up", `no reply from ${t.venue.name} after ${cadence.followUpH} h, followed up`);
      } else if (elapsed(t) >= cadence.giveUpH) {
        t.status = "no_reply";
        await call(ctx, "coordination", recordFact, { venueId: t.venue.id, roomId: null, kind: "no_reply", value: true, confidence: 0.7, sourceMessageId: t.threadId });
        await log(ctx, "coordination", "gave_up", `${t.venue.name} never replied in ${cadence.giveUpH} h; moving on`);
      }
    }
    // Once we have a usable offer and everyone else has had their follow-up window, stop waiting.
    const haveOffer = threads.some((t) => t.status === "offer" && t.offer?.available);
    if (haveOffer && open().every((t) => elapsed(t) >= cadence.followUpH + 2)) break;
  }
  for (const t of open()) {
    t.status = "no_reply";
    t.notes.push("stopped waiting: a usable offer arrived elsewhere");
  }
  return threads;
}

async function handleReply(ctx: Ctx, req: BookingRequest, t: Thread, msg: Message,
  triage: ReturnType<typeof replyTriage>, inject: ReturnType<typeof injection>) {
  const inj = await inject.classify(msg.body);
  if (inj.label === "injection") {
    t.injectionFlagged = true;
    t.notes.push(`email contained instructions aimed at the agent (${inj.reason}); treated as data only`);
    await log(ctx, "coordination", "injection_flagged", `${t.venue.name}'s email tried to instruct the agent; ignored`, { reason: inj.reason });
  }
  const tri = await triage.classify(msg.body);
  t.triage = tri.label;
  await log(ctx, "coordination", "reply", `${t.venue.name}: ${tri.label} (${tri.decidedBy}, ${tri.confidence.toFixed(2)})`, { messageId: msg.id });
  const day = weekday(req.date!);

  if (tri.label === "auto_reply") return;
  if (tri.label === "question") {
    await call(ctx, "coordination", sendVenueEmail, {
      venueId: t.venue.id, threadId: t.threadId, kind: "answer",
      body: `Thanks! Final headcount is ${req.partySize}. Dietary restrictions: ${req.dietary.length ? req.dietary.join(", ") : "none known yet, we'll confirm a week out"}.`,
    });
    t.status = "followed_up"; // we owe nothing more; don't chase them while they check
    return;
  }
  if (tri.label === "decline") {
    t.status = "declined";
    for (const f of factsFrom(t.venue, msg, null, t.sentAt, day, { declined: true, injection: t.injectionFlagged })) {
      await call(ctx, "coordination", recordFact, { venueId: t.venue.id, ...f });
    }
    return;
  }
  if (tri.label === "payment_request") {
    t.notes.push("venue asked for payment by email; payments only go through the platform to the payee on file");
    return;
  }
  if (tri.label === "needs_human") {
    t.status = "needs_human";
    t.notes.push("reply unclear; a person should read it");
    return;
  }
  const { offer, decidedBy, note } = await extractOffer(ctx.llm, msg.body, t.venue, msg.id, ctx.today, true);
  t.offer = offer;
  t.status = "offer";
  if (note) t.notes.push(note);
  if (offer.requestedPaymentDestination) t.notes.push(`email asked for payment to ${offer.requestedPaymentDestination}; ignored`);
  for (const f of factsFrom(t.venue, msg, offer, t.sentAt, day, { injection: t.injectionFlagged })) {
    await call(ctx, "coordination", recordFact, { venueId: t.venue.id, ...f });
  }
  await log(ctx, "coordination", "offer", `${t.venue.name}: ${offer.roomName ?? "room?"}, min ${offer.minSpendCents !== null ? `$${offer.minSpendCents / 100}` : "?"}, deposit ${offer.depositPct ?? "?"}% (${decidedBy})`, { offer });
}
