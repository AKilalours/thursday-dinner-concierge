// Comparison subagent: which offers actually satisfy the request and the policy, and which is best.
// Every rejection carries a reason the booker can read.
import type { BookingRequest } from "../domain/types.ts";
import { checkPolicy } from "../policy/policy.ts";
import type { PolicyResult } from "../policy/policy.ts";
import { weekday } from "../time.ts";
import type { Ctx } from "../tools/registry.ts";
import { log } from "../tools/registry.ts";
import { leadHours, roomFor } from "../tools/tools.ts";
import type { Thread } from "./coordination.ts";

export interface Option { thread: Thread; roomId: string; policy: PolicyResult; rank: number; minSpendCents: number }
export interface Comparison { usable: Option[]; rejected: { venue: string; why: string }[]; alternatives: { venue: string; dates: string[] }[] }

export async function compare(ctx: Ctx, req: BookingRequest, threads: Thread[]): Promise<Comparison> {
  const usable: Option[] = [];
  const rejected: { venue: string; why: string }[] = [];
  const alternatives: { venue: string; dates: string[] }[] = [];
  for (const t of threads) {
    const o = t.offer;
    if (!o) { rejected.push({ venue: t.venue.name, why: t.status.replace("_", " ") }); continue; }
    if (o.alternativeDates.length && (!o.date || o.date !== req.date)) {
      alternatives.push({ venue: t.venue.name, dates: o.alternativeDates });
      rejected.push({ venue: t.venue.name, why: `not available ${req.date}; offered ${o.alternativeDates.join(" or ")}` });
      continue;
    }
    const room = roomFor(ctx, t.venue.id, o, req.partySize, req.privateRoom);
    if (!room) { rejected.push({ venue: t.venue.name, why: "no matching room" }); continue; }
    if (req.privateRoom && !room.private) { rejected.push({ venue: t.venue.name, why: `offered ${room.name}, which is not private` }); continue; }
    // If the email gave no minimum, assume the listed one rather than zero: never under-estimate spend.
    const priced = { ...o, minSpendCents: o.minSpendCents ?? room.minSpendCents[weekday(req.date!)] };
    const policy = checkPolicy(ctx.company, req, t.venue, priced, leadHours(ctx.world.now, req.date!, req.time));
    if (!policy.onPolicy) { rejected.push({ venue: t.venue.name, why: policy.violations.join("; ") }); continue; }
    // Lower all-in cost per head is better, and the sourcing score breaks ties.
    const rank = policy.estimate.perHeadAllInCents / 100 - t.candidate.score;
    usable.push({ thread: t, roomId: room.id, policy, rank, minSpendCents: priced.minSpendCents });
  }
  // An inbox that tried to redirect money may be compromised: use it only when no clean offer exists.
  usable.sort((a, b) => Number(a.thread.injectionFlagged) - Number(b.thread.injectionFlagged) || a.rank - b.rank);
  await log(ctx, "comparison", "compared", `${usable.length} usable offers; ${rejected.length} rejected`, {
    usable: usable.map((u) => ({ venue: u.thread.venue.name, perHeadAllIn: u.policy.estimate.perHeadAllInCents / 100, roles: u.policy.requiredRoles })),
    rejected,
  });
  return { usable, rejected, alternatives };
}
