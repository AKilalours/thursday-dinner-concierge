// npm run demo -- "dinner for 12 with the Acme team next Thursday, somewhere private"
// Runs the whole flow against the simulated venue network and prints what each agent did.
import { createInterface } from "node:readline/promises";
import { buildVenues, user } from "../../data/seed.ts";
import { carefulApprover } from "../agents/concierge.ts";
import type { Approver } from "../agents/concierge.ts";
import { runConcierge } from "../agents/concierge.ts";
import { llmFromEnv } from "../llm/client.ts";
import { VenueWorld } from "../sim/world.ts";
import type { Behavior } from "../sim/world.ts";
import { MemoryStore } from "../store/memory.ts";
import { PgStore, pgDriver } from "../store/pg.ts";
import type { Store } from "../store/store.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const today = flag("today") ?? "2026-11-09";
const interactive = args.includes("--ask") ? (args.splice(args.indexOf("--ask"), 1), true) : false;
const text = args.join(" ") || "dinner for 12 with the Acme team next Thursday, somewhere private";

// A realistic mix: most venues answer, some slowly, some decline, one tries a prompt injection.
const MIX: Behavior[] = ["accept", "accept_slow", "decline", "counter_price", "injection", "accept", "question_then_accept", "no_reply", "counter_capacity", "auto_reply_then_accept", "counter_date", "accept"];
const venues = buildVenues();
const world = new VenueWorld(venues, (id) => MIX[Number(id.slice(4)) % MIX.length], `${today}T15:00:00.000Z`);

const store: Store = process.env.DATABASE_URL ? new PgStore(await pgDriver(process.env.DATABASE_URL)) : new MemoryStore();
await store.init(venues);

const actor = user("usr_priya");
const askApprover: Approver = async (p, s) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n  [${p.kind}] ${p.summary}\n  approve as ${p.requiredRoles.join(" + ")}? (y/n) `)).trim().toLowerCase();
  rl.close();
  for (const role of p.requiredRoles) {
    const userId = role === "booker" ? actor.id : role === "manager" ? "usr_marcus" : "usr_jordan";
    const r = await s.decide(p.id, userId, role, a.startsWith("y") ? "approve" : "reject");
    if (r.status === "rejected") return "rejected";
  }
  return "approved";
};

const llm = llmFromEnv();
console.log(`\n> ${text}\n  (as ${actor.name} for Dana Whitfield; today ${today}; model mode: ${llm.mode}; store: ${process.env.DATABASE_URL ? "postgres" : "memory"})\n`);
const res = await runConcierge({
  text, actor, principal: user("usr_dana"), today, store, world, llm, venues,
  approver: interactive ? askApprover : async (p, s) => carefulApprover(actor, { partySize: p.partySize, date: new Date(Date.parse(p.startsAt) - 5 * 3_600_000).toISOString().slice(0, 10), privateRoom: true })(p, s),
});

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
for (const e of res.trace) console.log(`  ${e.at.slice(5, 16).replace("T", " ")}  ${pad(e.agent, 12)} ${e.text}`);
console.log(`\n  outcome: ${res.outcome}${res.bookingId ? `  booking ${res.bookingId}` : ""}${res.paymentId ? `  payment ${res.paymentId}` : ""}`);
console.log(`  emails sent: ${world.sent().length}, received: ${world.received().length}\n`);
