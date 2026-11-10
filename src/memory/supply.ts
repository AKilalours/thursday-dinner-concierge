// The supply learning loop: every venue conversation leaves structured facts behind, and sourcing reads
// them next time. "The Wine Cellar is listed for 16 but really seats 10" stops us asking again.
import type { Offer, Venue } from "../domain/types.ts";
import type { Message } from "../sim/world.ts";
import type { Store, VenueFact } from "../store/store.ts";

export interface VenueKnowledge {
  /** Room id -> the most recent capacity a venue told us, when it is below the listing. */
  realCapacity: Map<string, number>;
  medianReplyHours: number | null;
  declines: number;
  noReplies: number;
  injectionFlags: number;
  /** Replies that said a listed room really seats fewer: the listing can't be trusted. */
  capacityCounters: number;
  /** Replies that offered the room asked for, as asked. */
  offers: number;
  /** "roomId:weekday" -> the highest minimum the venue quoted for that room, in cents. */
  quotedMin: Map<string, number>;
  /** Weekday -> the highest minimum quoted for any room. Only the pre-R11 behavior reads this. */
  quotedMinByWeekday: Map<number, number>;
}

export async function knowledge(store: Store, venueId: string): Promise<VenueKnowledge> {
  const facts = await store.facts(venueId);
  const k: VenueKnowledge = { realCapacity: new Map(), medianReplyHours: null, declines: 0, noReplies: 0, injectionFlags: 0, capacityCounters: 0, offers: 0, quotedMin: new Map(), quotedMinByWeekday: new Map() };
  const replies: number[] = [];
  for (const f of facts) {
    if (f.kind === "room_capacity" && f.roomId) { k.realCapacity.set(f.roomId, Number(f.value)); k.capacityCounters++; }
    if (f.kind === "offered") k.offers++;
    if (f.kind === "reply_hours") replies.push(Number(f.value));
    if (f.kind === "declined") k.declines++;
    if (f.kind === "no_reply") k.noReplies++;
    if (f.kind === "injection_attempt") k.injectionFlags++;
    if (f.kind === "quoted_min") {
      const v = f.value as { weekday: number; cents: number };
      k.quotedMinByWeekday.set(v.weekday, Math.max(k.quotedMinByWeekday.get(v.weekday) ?? 0, v.cents));
      if (f.roomId) k.quotedMin.set(`${f.roomId}:${v.weekday}`, Math.max(k.quotedMin.get(`${f.roomId}:${v.weekday}`) ?? 0, v.cents));
    }
  }
  if (replies.length) k.medianReplyHours = replies.sort((a, b) => a - b)[Math.floor(replies.length / 2)];
  return k;
}

/** Facts worth keeping from one reply. Pure: the caller records them through the audited tool. */
export function factsFrom(venue: Venue, msg: Message, offer: Offer | null, sentAt: string, weekdayOf: number, extra: { declined?: boolean; injection?: boolean }): Omit<VenueFact, "venueId">[] {
  const out: Omit<VenueFact, "venueId">[] = [];
  out.push({ roomId: null, kind: "reply_hours", value: Math.round(((Date.parse(msg.at) - Date.parse(sentAt)) / 3_600_000) * 10) / 10, confidence: 1, sourceMessageId: msg.id });
  if (extra.declined) out.push({ roomId: null, kind: "declined", value: true, confidence: 0.9, sourceMessageId: msg.id });
  if (extra.injection) out.push({ roomId: null, kind: "injection_attempt", value: true, confidence: 0.9, sourceMessageId: msg.id });
  for (const room of venue.rooms) {
    const tight = msg.body.match(new RegExp(`${room.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} only seats (\\d{1,3})`, "i"));
    if (tight && Number(tight[1]) < room.listedCapacity) {
      out.push({ roomId: room.id, kind: "room_capacity", value: Number(tight[1]), confidence: 0.85, sourceMessageId: msg.id });
    }
  }
  const countered = out.some((f) => f.kind === "room_capacity");
  if (offer?.available && !countered && !extra.injection) out.push({ roomId: null, kind: "offered", value: true, confidence: 0.8, sourceMessageId: msg.id });
  if (offer) {
    // Regression R11 (found by the ranking eval): the quote was stored per venue, so a $2,180 minimum for a
    // 16-seat room was later applied to the same venue's 8-seat room and dropped it as over budget. Quotes
    // belong to the room they were for.
    const quotedRoom = venue.rooms.find((r) => r.name.toLowerCase() === offer.roomName?.toLowerCase());
    if (offer.minSpendCents) out.push({ roomId: quotedRoom?.id ?? null, kind: "quoted_min", value: { weekday: weekdayOf, cents: offer.minSpendCents }, confidence: 0.8, sourceMessageId: msg.id });
  }
  return out;
}
