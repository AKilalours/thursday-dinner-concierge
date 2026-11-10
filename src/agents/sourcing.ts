// Sourcing subagent: from the whole network to a short, explained list. Hard filters first (closed,
// blocked, too small, not private), then a score whose parts add back up to the total.
import type { BookingRequest, Venue } from "../domain/types.ts";
import { knowledge } from "../memory/supply.ts";
import { estimate, ALL_IN, perHeadFor } from "../policy/policy.ts";
import { weekday } from "../time.ts";
import type { Ctx } from "../tools/registry.ts";
import { log } from "../tools/registry.ts";

export interface Candidate {
  venue: Venue;
  roomId: string;
  score: number;
  parts: Record<string, number>;
  estimatePerHeadCents: number;
}

export const ADJACENT: Record<string, string[]> = {
  flatiron: ["chelsea", "midtown", "soho"], chelsea: ["flatiron", "west village"], midtown: ["flatiron"],
  soho: ["tribeca", "west village", "flatiron"], tribeca: ["soho", "financial district"], "west village": ["soho", "chelsea"],
  "financial district": ["tribeca"], williamsburg: [],
};

export async function source(ctx: Ctx, req: BookingRequest, exclude: Set<string>): Promise<Candidate[]> {
  const day = weekday(req.date!);
  // Regression R10 (found on the live site with live Claude): the model returns "SoHo", venues say "soho", so the
  // comparison never matched and "somewhere in SoHo" booked Williamsburg. Normalize before comparing.
  const where = (req.neighborhood === "office" ? ctx.company.officeNeighborhood : req.neighborhood)?.toLowerCase().trim() || null;
  const hosted = (await ctx.store.recall(ctx.company.id, ctx.actor.id))
    .filter((m) => req.clientName && m.subject.toLowerCase() === req.clientName.toLowerCase() && m.fact.startsWith("hosted_at:"))
    .map((m) => m.fact.slice("hosted_at:".length));
  const cap = Math.min(ctx.company.policy.perHeadCapCents[req.kind], req.maxPerHeadCents ? Math.round(req.maxPerHeadCents * ALL_IN) : Infinity);
  const out: Candidate[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };

  // Regression R7 (found by the LLM judge): cuisine was only a +20 nudge, so "japanese dinner" booked a
  // Korean room. A stated cuisine is a requirement whenever the network has any venue serving it.
  const cuisineRequired = !ctx.legacy?.r7 && !!req.cuisine && ctx.venues.some((v) => v.cuisine === req.cuisine);
  for (const v of ctx.venues) {
    if (exclude.has(v.id)) { drop("already tried"); continue; }
    if (cuisineRequired && v.cuisine !== req.cuisine) { drop(`not ${req.cuisine}`); continue; }
    if (ctx.company.policy.blockedVenueIds.includes(v.id)) { drop("blocked by policy"); continue; }
    if (v.closedDays.includes(day)) { drop("closed that day"); continue; }
    const k = await knowledge(ctx.store, v.id);
    const rooms = v.rooms
      .filter((r) => (req.privateRoom ? r.private : true))
      .filter((r) => (k.realCapacity.get(r.id) ?? r.listedCapacity) >= req.partySize)
      // Without a private-room ask, a table in the dining room (no minimum) beats a private room's minimum.
      .sort((a, b) => (req.privateRoom ? 0 : Number(a.private) - Number(b.private)) || a.listedCapacity - b.listedCapacity);
    if (!rooms.length) { drop(req.privateRoom ? "no private room that fits" : "no room that fits"); continue; }
    const room = rooms[0];
    const min = Math.max(room.minSpendCents[day], k.quotedMinByWeekday.get(day) ?? 0);
    // Lunch and drinks in the dining room carry no room minimum.
    const est = estimate(req.partySize, perHeadFor(v, req.kind), room.private ? min : 0, v.preferredRatePct);
    if (est.perHeadAllInCents > cap) { drop("over the per-head limit"); continue; }

    const parts: Record<string, number> = {
      location: !where ? 10 : v.neighborhood.toLowerCase() === where ? 30 : (ADJACENT[where] ?? []).includes(v.neighborhood.toLowerCase()) ? 15 : 0,
      cuisine: req.cuisine && v.cuisine === req.cuisine ? 20 : 0,
      // Spend headroom under the cap: cheaper is better, but only up to a point.
      value: Math.round(20 * Math.min(1, (cap - est.perHeadAllInCents) / Math.max(1, cap))),
      // Rooms much bigger than the party feel empty and cost more.
      fit: Math.round(15 * (req.partySize / room.listedCapacity)),
      responsiveness: k.medianReplyHours === null ? 5 : k.medianReplyHours <= 3 ? 10 : k.medianReplyHours <= 12 ? 5 : 0,
      reliability: -(k.declines * 4 + k.noReplies * 6 + k.injectionFlags * 25),
      preferred: v.preferredRatePct ? 8 : 0,
      variety: hosted.includes(v.id) ? -8 : 0,
    };
    out.push({ venue: v, roomId: room.id, score: Object.values(parts).reduce((a, b) => a + b, 0), parts, estimatePerHeadCents: est.perHeadAllInCents });
  }
  out.sort((a, b) => b.score - a.score || a.venue.id.localeCompare(b.venue.id));
  // A named neighborhood is a requirement (that neighborhood or the ones next to it) whenever anything there fits.
  if (where && !ctx.legacy?.r10) {
    const near = out.filter((c) => { const n = c.venue.neighborhood.toLowerCase(); return n === where || (ADJACENT[where] ?? []).includes(n); });
    if (near.length && near.length < out.length) { dropped[`outside ${req.neighborhood === "office" ? "the office area" : req.neighborhood}`] = out.length - near.length; out.splice(0, out.length, ...near); }
  }
  await log(ctx, "sourcing", "sourced", `${out.length} venues fit; dropped ${Object.entries(dropped).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`, {
    top: out.slice(0, 5).map((c) => ({ venue: c.venue.name, venueId: c.venue.id, score: c.score, parts: c.parts, perHead: c.estimatePerHeadCents, preferredRatePct: c.venue.preferredRatePct, neighborhood: c.venue.neighborhood })),
  });
  return out;
}
