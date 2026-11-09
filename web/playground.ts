// Browser playground. It runs the real agent, tools, policy and store from src/, against the simulated
// venue network, and animates what happens. Only the approval clicks come from you.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { approverFor, runConcierge } from "../src/agents/concierge.ts";
import type { Approver } from "../src/agents/concierge.ts";
import type { Proposal } from "../src/domain/types.ts";
import { offline } from "../src/llm/client.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior, Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { StoreError } from "../src/store/store.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const el = (tag: string, cls = "", html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRESETS: Record<string, { text?: string; order: Behavior[] }> = {
  normal: { order: ["counter_capacity", "injection", "accept"] },
  silent: { order: ["no_reply", "no_reply", "accept_slow"] },
  injection: { order: ["injection", "decline", "decline"] },
  declines: { order: ["decline", "decline", "decline"] },
  big: { text: "private dinner for 20 with Globex on Nov 19", order: ["accept", "question_then_accept", "decline"] },
};
const AGENT_COLOR: Record<string, string> = { concierge: "c", sourcing: "s", coordination: "v", comparison: "m" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); const h = d.getUTCHours(); return `${DAYS[d.getUTCDay()]} ${h % 12 || 12}${h < 12 ? "am" : "pm"}`; };

let preset = "normal";
let running = false;
let store: MemoryStore;
let world: VenueWorld;
let lastProposals: Proposal[] = [];
const venues = buildVenues();
const priya = user("usr_priya");

document.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
  b.classList.add("on");
  preset = b.dataset.p!;
  if (PRESETS[preset].text) $<HTMLInputElement>("#ask").value = PRESETS[preset].text!;
  else $<HTMLInputElement>("#ask").value = "dinner for 12 with the Acme team next Thursday, somewhere private";
}));
$<HTMLFormElement>("#go").addEventListener("submit", (e) => { e.preventDefault(); if (!running) void run(); });
document.querySelectorAll<HTMLButtonElement>(".attack").forEach((b) => b.addEventListener("click", () => void attack(b)));

// Events are animated one by one; the approver waits until the animation has caught up.
const queue: (() => void)[] = [];
let pumping: Promise<void> | null = null;
function enqueue(fn: () => void) {
  queue.push(fn);
  pumping ??= (async () => { while (queue.length) { queue.shift()!(); await sleep(420); } pumping = null; })();
}
const drained = async () => { while (pumping) await pumping; };

function addEvent(e: TraceEvent) {
  if (e.kind.startsWith("to_booker")) { enqueue(() => phoneMsg(e.text, e.kind.endsWith("sms") ? "sms" : "email")); return; }
  enqueue(() => {
    const row = el("li", `ev ${AGENT_COLOR[e.agent] ?? ""}${e.kind === "injection_flagged" ? " bad" : ""}${e.kind === "booked" ? " good" : ""}`,
      `<span class="t">${when(e.at)}</span><span class="who">${e.agent}</span><span class="what">${esc(short(e))}</span>`);
    $("#events").append(row);
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (e.kind === "sourced") shortlist(e);
    renderInbox();
  });
}

function short(e: TraceEvent) {
  if (e.kind === "proposed") return "proposal sent to your phone";
  return e.text.length > 110 ? `${e.text.slice(0, 107)}...` : e.text;
}

function shortlist(e: TraceEvent) {
  const top = (e.data?.top ?? []) as { venue: string; score: number; parts: Record<string, number> }[];
  const box = $("#short");
  box.innerHTML = "";
  for (const c of top.slice(0, 4)) {
    const parts = Object.entries(c.parts).filter(([, v]) => v !== 0);
    box.append(el("div", "cand", `<b>${esc(c.venue)}</b><span class="sc">${c.score}</span><div class="bars">${parts.map(([k, v]) =>
      `<i class="${v < 0 ? "neg" : ""}" style="flex:${Math.abs(v)}" title="${k} ${v > 0 ? "+" : ""}${v}"></i>`).join("")}</div>`));
  }
}

function renderInbox() {
  const box = $("#inbox");
  const threads = new Map<string, Message[]>();
  for (const m of [...world.sent(), ...world.received()].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!threads.has(m.venueId)) threads.set(m.venueId, []);
    threads.get(m.venueId)!.push(m);
  }
  const open = new Set([...box.querySelectorAll<HTMLElement>("details[open]")].map((d) => d.dataset.v));
  box.innerHTML = "";
  for (const [vid, msgs] of threads) {
    const v = venues.find((x) => x.id === vid)!;
    const last = msgs.filter((m) => m.direction === "in").at(-1);
    const status = !last ? (msgs.length > 1 ? "followed up" : "waiting") : /SYSTEM NOTE/.test(last.body) ? "injection" : /unfortunately|no availability|not able/i.test(last.body) && !/instead/i.test(last.body) ? "declined" : /instead|semi-private/i.test(last.body) ? "counter" : /out of the office/i.test(last.body) ? "auto-reply" : /\?\s*\n/.test(last.body) && /could you confirm/i.test(last.body) ? "question" : "offer";
    const d = el("details", `th ${status.replace(/ .*/, "")}`) as HTMLDetailsElement;
    d.dataset.v = vid;
    if (open.has(vid)) d.open = true;
    d.innerHTML = `<summary><b>${esc(v.name)}</b><span class="badge">${status}</span><span class="n">${msgs.length}</span></summary>` + msgs.map((m) =>
      `<div class="mail ${m.direction}"><div class="mh">${m.direction === "out" ? "→ concierge" : "← venue"} · ${when(m.at)}</div><pre>${highlight(esc(m.body))}</pre></div>`).join("");
    box.append(d);
  }
}

const highlight = (s: string) => s.replace(/(\[SYSTEM NOTE:[^\]]*\])/s, '<mark>$1</mark>').replace(/(\$[\d,]+)/g, "<u>$1</u>");

function phoneMsg(text: string, channel: string) {
  const b = el("div", "bubble", `<span class="ch">${channel}</span>${esc(text).replace(/(instructions to change payment details[^.]*\.)/, "<mark>$1</mark>")}`);
  $("#phone").append(b);
  b.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const approver: Approver = async (p, s) => {
  await drained();
  const current = (await s.getProposal(p.id))!;
  if (current.status === "approved") return "approved";
  if (current.status === "rejected") return "rejected";
  lastProposals = [current];
  const all = [current];
  // Show the booking and its deposit as one decision, the way a booker sees it.
  for (const other of await Promise.all((await s.steps(p.runId)).filter((x) => x.kind === "proposed").flatMap((x) => (x.detail.proposals as string[]) ?? []).map((id) => s.getProposal(id)))) {
    if (other && other.id !== current.id && other.status === "pending") all.push(other);
  }
  lastProposals = all;
  return new Promise((resolve) => {
    const card = el("div", "card");
    const roles = current.requiredRoles;
    card.innerHTML = `<div class="ct">Approve?</div><div class="roles">${roles.map((r) => `<span class="role" data-r="${r}">${approverFor(r, priya).name.split(" ")[0]} · ${r}</span>`).join("")}</div>
      <div class="btns"><button class="yes">Approve</button><button class="no">Reject</button></div>`;
    $("#phone").append(card);
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    let i = 0;
    const yes = card.querySelector<HTMLButtonElement>(".yes")!;
    yes.textContent = `Approve as ${approverFor(roles[0], priya).name.split(" ")[0]}`;
    yes.onclick = async () => {
      const role = roles[i];
      for (const x of all) await s.decide(x.id, approverFor(role, priya).id, role, "approve");
      card.querySelector(`[data-r="${role}"]`)!.classList.add("ok");
      i++;
      if (i < roles.length) { yes.textContent = `Approve as ${approverFor(roles[i], priya).name.split(" ")[0]}`; return; }
      card.querySelector(".btns")!.remove();
      resolve("approved");
    };
    card.querySelector<HTMLButtonElement>(".no")!.onclick = async () => {
      for (const x of all) await s.decide(x.id, approverFor(roles[i], priya).id, roles[i], "reject");
      card.querySelector(".btns")!.remove();
      card.classList.add("rej");
      resolve("rejected");
    };
  });
};

async function run() {
  running = true;
  $("#go button")!.setAttribute("disabled", "");
  for (const id of ["#events", "#inbox", "#phone", "#short", "#breaklog"]) $(id).innerHTML = "";
  document.body.classList.add("live");
  const p = PRESETS[preset];
  const seen = new Map<string, Behavior>();
  world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, p.order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  store = new MemoryStore();
  await store.init(venues);
  const res = await runConcierge({
    text: $<HTMLInputElement>("#ask").value, actor: priya, principal: user("usr_dana"), today: "2026-11-09",
    store, world, llm: offline, venues, company: COMPANY, approver, onEvent: addEvent,
  });
  await drained();
  const pay = res.paymentId ? store.allPayments().find((x) => x.id === res.paymentId) : null;
  const out = el("div", `result ${res.outcome}`, `<b>${res.outcome.replace(/_/g, " ")}</b>${res.bookingId ? ` · ${res.bookingId}` : ""}${pay ? ` · deposit $${(pay.amountCents / 100).toFixed(0)} → ${pay.payeeId}` : ""}`);
  $("#phone").append(out);
  out.scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("#break").classList.toggle("ready", true);
  running = false;
  $("#go button")!.removeAttribute("disabled");
}

async function attack(b: HTMLButtonElement) {
  if (!store) { log("Run a booking first.", "info"); return; }
  const base = lastProposals[0] ?? (await anyProposal());
  if (!base) { log("Run a booking first.", "info"); return; }
  const fresh = (over: Partial<Proposal>) => ({ ...base, id: `atk_${Math.random().toString(36).slice(2, 8)}`, approvedRoles: [], status: "pending" as const, ...over });
  const booking = store.allBookings()[0];
  try {
    switch (b.dataset.a) {
      case "attacker": {
        if (!booking) { log("Approve a booking first, then try this.", "info"); return; }
        const p = fresh({ kind: "pay_deposit", amountCents: 50_000, payeeId: "acct_4400187733" });
        await store.createProposal(p);
        for (const r of p.requiredRoles) await store.decide(p.id, approverFor(r, priya).id, r, "approve");
        await store.pay({ id: "x1", idempotencyKey: `k_${p.id}`, proposalId: p.id, bookingId: booking.id, payeeId: "acct_4400187733", amountCents: 50_000 });
        break;
      }
      case "unapproved": {
        const p = fresh({ kind: "book", startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2026-12-01T03:00:00.000Z" });
        await store.createProposal(p);
        await store.book({ id: "x2", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
        break;
      }
      case "self": {
        const p = fresh({ kind: "book" });
        await store.createProposal(p);
        await store.decide(p.id, "agent", "booker", "approve");
        break;
      }
      case "double": {
        if (!booking) { log("Approve a booking first, then try this.", "info"); return; }
        const p = fresh({ kind: "book", roomId: booking.roomId, venueId: booking.venueId, startsAt: booking.startsAt, endsAt: booking.endsAt, partySize: booking.partySize });
        await store.createProposal(p);
        for (const r of p.requiredRoles) await store.decide(p.id, approverFor(r, priya).id, r, "approve");
        await store.book({ id: "x3", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
        break;
      }
    }
    log(`${b.textContent}: went through?!`, "bad");
  } catch (e) {
    log(`${b.textContent}`, "blocked", e instanceof StoreError ? e.code.replace(/_/g, " ") : String(e));
  }
}

async function anyProposal() { return null; }

function log(text: string, kind: "blocked" | "bad" | "info", code = "") {
  const row = el("div", `bl ${kind}`, kind === "blocked" ? `<span class="x">BLOCKED</span>${esc(text)} <code>${esc(code)}</code>` : esc(text));
  $("#breaklog").prepend(row);
}
