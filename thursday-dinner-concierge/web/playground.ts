// Browser playground. It runs the real agent, tools, policy, store and eval graders from the repo against
// the simulated venue network, and animates what happens. Only the approval taps come from you.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { fuzzOne, runScenario } from "../evals/runner.ts";
import type { ScenarioRun } from "../evals/runner.ts";
import { SCENARIOS } from "../evals/scenarios.ts";
import { approverFor, runConcierge } from "../src/agents/concierge.ts";
import type { Approver } from "../src/agents/concierge.ts";
import type { Company, Proposal } from "../src/domain/types.ts";
import { injection, replyTriage } from "../src/judgments/judgments.ts";
import { offline } from "../src/llm/client.ts";
import { extractRules } from "../src/parse/offer.ts";
import { checkPolicy } from "../src/policy/policy.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior, Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { StoreError } from "../src/store/store.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...document.querySelectorAll(s)] as T[];
const el = (tag: string, cls = "", html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); const h = d.getUTCHours(); return `${DAYS[d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };

const venues = buildVenues();
const priya = user("usr_priya");
const company: Company = structuredClone(COMPANY);

// ---------- tabs ----------
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.remove("on")); t.classList.add("on");
  $$(".view").forEach((v) => v.classList.remove("on")); $(`#v-${t.dataset.v}`).classList.add("on");
}));

// ---------- map ----------
const HOODS: Record<string, [number, number, number, number]> = {
  Midtown: [40, 12, 200, 56], Chelsea: [40, 74, 96, 50], Flatiron: [144, 74, 96, 50], "West Village": [40, 130, 96, 50],
  SoHo: [144, 130, 96, 50], Tribeca: [40, 186, 96, 50], "Financial District": [144, 186, 96, 100], Williamsburg: [280, 100, 70, 110],
};
const pos = new Map<string, [number, number]>();
function drawMap() {
  const svg = $("#map");
  let s = `<rect class="river" x="246" y="0" width="28" height="300"/>`;
  for (const [name, [x, y, w, h]] of Object.entries(HOODS)) s += `<rect class="hood" rx="8" x="${x}" y="${y}" width="${w}" height="${h}"/><text x="${x + 6}" y="${y + 13}">${name === "Financial District" ? "FiDi" : name === "Williamsburg" ? "Brooklyn" : name}</text>`;
  const [ox, oy, ow, oh] = HOODS.Flatiron;
  s += `<rect class="office" rx="8" x="${ox - 3}" y="${oy - 3}" width="${ow + 6}" height="${oh + 6}"/><text x="${ox + ow - 40}" y="${oy + oh - 6}" style="fill:#8fb2ff">office</text>`;
  const per: Record<string, number> = {};
  for (const v of venues) {
    const [x, y, w, h] = HOODS[v.neighborhood];
    const k = (per[v.neighborhood] = (per[v.neighborhood] ?? 0) + 1) - 1;
    const p: [number, number] = [x + 16 + ((k * 23) % (w - 26)), y + 26 + Math.floor((k * 23) / (w - 26)) * 16 + (k % 2) * 6];
    pos.set(v.id, p);
    s += `<circle class="dot" id="d_${v.id}" cx="${p[0]}" cy="${Math.min(p[1], y + h - 8)}" r="5"><title>${esc(v.name)}</title></circle>`;
  }
  svg.innerHTML = s;
}
const dot = (id: string, cls: string) => { const d = document.getElementById(`d_${id}`); if (d) d.setAttribute("class", `dot ${cls}`); };
drawMap();

// ---------- book ----------
const PRESETS: Record<string, { text?: string; order: Behavior[] }> = {
  normal: { order: ["counter_capacity", "injection", "accept"] },
  silent: { order: ["no_reply", "no_reply", "accept_slow"] },
  injection: { order: ["injection", "decline", "decline"] },
  declines: { order: ["decline", "decline", "decline"] },
  big: { text: "private dinner for 20 with Globex on Nov 19", order: ["accept", "question_then_accept", "decline"] },
};
const DEFAULT = "dinner for 12 with the Acme team next Thursday, somewhere private";
const AGENT: Record<string, string> = { concierge: "c", sourcing: "s", coordination: "v", comparison: "m" };
let preset = "normal", speed = 2, running = false;
let store: MemoryStore, world: VenueWorld;
let lastProposals: Proposal[] = [];
const ledger: { venue: string; guests: number; allIn: number; saved: number; roles: string }[] = [];

$$("#v-book .chip").forEach((b) => b.addEventListener("click", () => {
  $$("#v-book .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  preset = b.dataset.p!; $<HTMLInputElement>("#ask").value = PRESETS[preset].text ?? DEFAULT;
}));
$$(".speed button").forEach((b) => b.addEventListener("click", () => { $$(".speed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); speed = Number(b.dataset.s); }));
$<HTMLFormElement>("#go").addEventListener("submit", (e) => { e.preventDefault(); if (!running) void book(); });
$$<HTMLButtonElement>(".attack").forEach((b) => b.addEventListener("click", () => void attack(b)));

const queue: (() => void)[] = [];
let pumping: Promise<void> | null = null;
function enqueue(fn: () => void) {
  queue.push(fn);
  pumping ??= (async () => { while (queue.length) { queue.shift()!(); await sleep(480 / speed); } pumping = null; })();
}
const drained = async () => { while (pumping) await pumping; };

function light(agent: string) {
  $$(".node").forEach((n) => n.classList.remove("on"));
  $(`.node.${agent}`)?.classList.add("on");
}

function addEvent(e: TraceEvent) {
  if (e.kind.startsWith("to_booker")) { enqueue(() => { light("c"); phoneMsg(e.text, e.kind.endsWith("sms") ? "sms" : "email"); }); return; }
  enqueue(() => {
    light(AGENT[e.agent] ?? "c");
    $("#clock").textContent = when(e.at);
    const row = el("li", `ev ${AGENT[e.agent] ?? ""}${e.kind === "injection_flagged" ? " bad" : ""}${e.kind === "booked" ? " good" : ""}`,
      `<span class="tm">${when(e.at)}</span><span class="who">${e.agent}</span><span class="what">${esc(e.kind === "proposed" ? "proposal sent to your phone" : e.text.length > 115 ? `${e.text.slice(0, 112)}...` : e.text)}</span>`);
    $("#events").append(row);
    $("#evbox").scrollTop = $("#evbox").scrollHeight;
    if (e.kind === "sourced") shortlist(e);
    renderInbox();
  });
}

function shortlist(e: TraceEvent) {
  const top = (e.data?.top ?? []) as { venue: string; venueId: string; score: number; parts: Record<string, number>; perHead: number; preferredRatePct: number; neighborhood: string }[];
  const box = $("#short"); box.innerHTML = "";
  for (const c of top.slice(0, 4)) {
    dot(c.venueId, "cand");
    const parts = Object.entries(c.parts).filter(([, v]) => v !== 0);
    const tags = [`<span class="t g">In-Policy</span>`, c.preferredRatePct ? `<span class="t p">Preferred rate −${c.preferredRatePct}%</span>` : "", `<span class="t">${usd(c.perHead)}/head</span>`, `<span class="t">${esc(c.neighborhood)}</span>`].join("");
    box.append(el("div", "cand", `<div class="h"><b>${esc(c.venue)}</b><span class="sc">${c.score}</span></div><div class="tags">${tags}</div><div class="bars">${parts.map(([k, v]) =>
      `<i class="${v < 0 ? "neg" : ""}" style="flex:${Math.abs(v)}" title="${k} ${v > 0 ? "+" : ""}${v}"></i>`).join("")}</div>`));
  }
}

function statusOf(msgs: Message[]) {
  const last = msgs.filter((m) => m.direction === "in").at(-1);
  if (!last) return msgs.length > 1 ? "followed up" : "waiting";
  if (/SYSTEM NOTE/.test(last.body)) return "injection";
  if (/instead|semi-private/i.test(last.body)) return "counter";
  if (/unfortunately|no availability|not able/i.test(last.body)) return "declined";
  if (/out of the office/i.test(last.body)) return "auto-reply";
  if (/could you confirm/i.test(last.body)) return "question";
  return "offer";
}

function renderInbox() {
  const box = $("#inbox");
  const threads = new Map<string, Message[]>();
  for (const m of [...world.sent(), ...world.received()].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!threads.has(m.venueId)) threads.set(m.venueId, []);
    threads.get(m.venueId)!.push(m);
  }
  const open = new Set($$<HTMLElement>("#inbox details[open]").map((d) => d.dataset.v));
  box.innerHTML = "";
  for (const [vid, msgs] of threads) {
    const v = venues.find((x) => x.id === vid)!;
    const status = statusOf(msgs);
    dot(vid, ({ offer: "offer", declined: "decl", injection: "inj", counter: "decl" } as Record<string, string>)[status] ?? "mailed");
    const d = el("details", `th ${status.replace(/ .*/, "")}`) as HTMLDetailsElement;
    d.dataset.v = vid; if (open.has(vid)) d.open = true;
    d.innerHTML = `<summary><b>${esc(v.name)}</b><span class="badge">${status}</span><span class="n">${msgs.length}</span></summary>` + msgs.map((m) =>
      `<div class="mail ${m.direction}"><div class="mh">${m.direction === "out" ? "→ concierge" : "← venue"} · ${when(m.at)}</div><pre>${esc(m.body).replace(/(\[SYSTEM NOTE:[^\]]*\])/s, "<mark>$1</mark>").replace(/(\$[\d,]+)/g, "<u>$1</u>")}</pre></div>`).join("");
    box.append(d);
  }
  $("#e3").style.display = threads.size ? "none" : "";
}

function phoneMsg(text: string, channel: string) {
  $("#e2").style.display = "none";
  const b = el("div", "bubble", `<span class="ch">${channel}</span>${esc(text).replace(/(instructions to change payment details[^.]*\.)/, "<mark>$1</mark>")}`);
  $("#phone").append(b);
  b.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const approver: Approver = async (p, s) => {
  await drained();
  const current = (await s.getProposal(p.id))!;
  if (current.status === "approved") return "approved";
  if (current.status === "rejected") return "rejected";
  const all = [current];
  for (const st of await s.steps(p.runId)) {
    for (const id of (st.kind === "proposed" ? (st.detail.proposals as string[]) : []) ?? []) {
      const o = await s.getProposal(id);
      if (o && o.id !== current.id && o.status === "pending") all.push(o);
    }
  }
  lastProposals = all;
  light("y");
  return new Promise((resolve) => {
    const roles = current.requiredRoles;
    const card = el("div", "card", `<div class="ct">Approve?</div><div class="roles">${roles.map((r) => `<span class="role" data-r="${r}">${approverFor(r, priya).name.split(" ")[0]} · ${r}</span>`).join("")}</div><div class="btns"><button class="yes"></button><button class="no">Reject</button></div>`);
    $("#phone").append(card); card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    let i = 0;
    const yes = card.querySelector<HTMLButtonElement>(".yes")!;
    const label = () => { yes.textContent = `Approve as ${approverFor(roles[i], priya).name.split(" ")[0]}`; };
    label();
    yes.onclick = async () => {
      const role = roles[i];
      for (const x of all) await s.decide(x.id, approverFor(role, priya).id, role, "approve");
      card.querySelector(`[data-r="${role}"]`)!.classList.add("ok");
      if (++i < roles.length) { label(); return; }
      card.querySelector(".btns")!.remove(); resolve("approved");
    };
    card.querySelector<HTMLButtonElement>(".no")!.onclick = async () => {
      for (const x of all) await s.decide(x.id, approverFor(roles[i], priya).id, roles[i], "reject");
      card.querySelector(".btns")!.remove(); card.classList.add("rej"); resolve("rejected");
    };
  });
};

async function book() {
  running = true; $(".go").setAttribute("disabled", "");
  for (const id of ["#events", "#inbox", "#phone", "#short", "#breaklog"]) $(id).innerHTML = "";
  for (const id of ["#e1", "#e2", "#e3"]) $(id).style.display = "none";
  venues.forEach((v) => dot(v.id, ""));
  const p = PRESETS[preset];
  const seen = new Map<string, Behavior>();
  world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, p.order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  store = new MemoryStore(); await store.init(venues);
  const res = await runConcierge({ text: $<HTMLInputElement>("#ask").value, actor: priya, principal: user("usr_dana"), today: "2026-11-09", store, world, llm: offline, venues, company, approver, onEvent: addEvent });
  await drained();
  if (res.outcome === "booked" && res.chosenVenueId) {
    dot(res.chosenVenueId, "win");
    const v = venues.find((x) => x.id === res.chosenVenueId)!;
    const bk = res.proposals.find((x) => x.kind === "book")!;
    ledger.unshift({ venue: v.name, guests: bk.partySize, allIn: bk.amountCents, saved: v.preferredRatePct ? Math.round(bk.amountCents / (1 - v.preferredRatePct / 100) - bk.amountCents) : 0, roles: bk.requiredRoles.join(" + ") });
    renderSpend();
  }
  light(res.outcome === "booked" ? "y" : "c");
  const pay = res.paymentId ? store.allPayments().find((x) => x.id === res.paymentId) : null;
  const out = el("div", `result ${res.outcome}`, `<b>${res.outcome.replace(/_/g, " ")}</b>${pay ? ` · deposit ${usd(pay.amountCents)} → ${pay.payeeId}` : ""}`);
  $("#phone").append(out); out.scrollIntoView({ block: "nearest", behavior: "smooth" });
  running = false; $(".go").removeAttribute("disabled");
}

async function attack(b: HTMLButtonElement) {
  const log = (text: string, cls: string, code = "") => $("#breaklog").prepend(el("div", `bl ${cls}`, cls === "blocked" ? `<span class="x">BLOCKED</span>${esc(text)} <code>${esc(code)}</code>` : esc(text)));
  const base = lastProposals[0];
  if (!store || !base) { log("Book a dinner first.", "info"); return; }
  const fresh = (over: Partial<Proposal>): Proposal => ({ ...base, id: `atk_${Math.random().toString(36).slice(2, 8)}`, approvedRoles: [], status: "pending", ...over });
  const booking = store.allBookings()[0];
  const approveAll = async (p: Proposal) => { for (const r of p.requiredRoles) await store.decide(p.id, approverFor(r, priya).id, r, "approve"); };
  try {
    if ((b.dataset.a === "attacker" || b.dataset.a === "double") && !booking) { log("Approve a booking first, then try this.", "info"); return; }
    if (b.dataset.a === "attacker") {
      const p = fresh({ kind: "pay_deposit", amountCents: 50_000, payeeId: "acct_4400187733" });
      await store.createProposal(p); await approveAll(p);
      await store.pay({ id: "x1", idempotencyKey: `k_${p.id}`, proposalId: p.id, bookingId: booking.id, payeeId: "acct_4400187733", amountCents: 50_000 });
    } else if (b.dataset.a === "unapproved") {
      const p = fresh({ kind: "book", startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2026-12-01T03:00:00.000Z" });
      await store.createProposal(p);
      await store.book({ id: "x2", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
    } else if (b.dataset.a === "self") {
      const p = fresh({ kind: "book" }); await store.createProposal(p);
      await store.decide(p.id, "agent", "booker", "approve");
    } else {
      const p = fresh({ kind: "book", roomId: booking.roomId, venueId: booking.venueId, startsAt: booking.startsAt, endsAt: booking.endsAt, partySize: booking.partySize });
      await store.createProposal(p); await approveAll(p);
      await store.book({ id: "x3", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: p.partySize });
    }
    log(`${b.textContent}: went through?!`, "info");
  } catch (e) {
    log(b.textContent ?? "", "blocked", e instanceof StoreError ? e.code.replace(/_/g, " ") : String(e));
  }
}

// ---------- email lab ----------
const labVenue = venues[1];
const meta = { date: "2026-11-12", time: "19:00", partySize: 12, privateRoom: true };
function template(t: string) {
  if (t === "auto") return "Thank you for your email. I am currently out of the office with limited access to email and will respond when I return.\n\nEvents Team";
  const w = new VenueWorld(venues, () => t as Behavior, "2026-11-09T15:00:00.000Z", 5);
  w.send(labVenue.id, "lab", "Inquiry", "Hello, inquiry for 12 guests", "inquiry", meta);
  return w.advance(12)[0]?.body ?? "";
}
const triager = replyTriage(offline), detector = injection(offline);
async function analyze() {
  const body = $<HTMLTextAreaElement>("#mail").value;
  const [tri, inj] = await Promise.all([triager.classify(body), detector.classify(body)]);
  const o = extractRules(body, labVenue, "lab", "2026-11-09", tri.label === "offer" || tri.label === "counter");
  $("#tri").textContent = tri.label.replace("_", " ");
  $<HTMLElement>("#trim").style.width = `${Math.round(tri.confidence * 100)}%`;
  $("#inj").innerHTML = inj.label === "injection" ? `<span style="color:var(--bad)">Flagged · ${esc(inj.reason)}</span>` : `<span style="color:var(--good)">Clean</span>`;
  const f: [string, string][] = [
    ["Room", o.roomName ?? "-"], ["Capacity", o.capacity?.toString() ?? "-"], ["Minimum", o.minSpendCents !== null ? usd(o.minSpendCents) : "-"],
    ["Deposit", o.depositPct !== null ? `${o.depositPct}%` : "-"], ["Hold", o.holdExpiresHours ? `${o.holdExpiresHours} h` : "-"],
    ["Contract", o.contractRequired === null ? "-" : o.contractRequired ? "yes" : "no"], ["Other dates", o.alternativeDates.join(", ") || "-"],
    ["Pay to (from email)", o.requestedPaymentDestination ? `<span style="color:var(--bad)">${esc(o.requestedPaymentDestination)} · never used</span>` : "-"],
  ];
  $("#fields").innerHTML = f.map(([k, v]) => `<dt>${k}</dt><dd>${v.startsWith("<") ? v : esc(v)}</dd>`).join("");
  const v = $("#verdict");
  const set = (cls: string, text: string) => { v.className = `verdict ${cls}`; v.textContent = text; };
  if (inj.label === "injection") return set("bad", "Flagged and treated as data. Payment details ignored, booker warned, a clean venue preferred.");
  if (tri.label === "decline") return set("warn", "Logs the decline, learns from it, moves to the next venue.");
  if (tri.label === "auto_reply") return set("warn", "Ignored. Waits for the real reply, follows up if it never comes.");
  if (tri.label === "question") return set("warn", "Answers with headcount and dietary needs, keeps the thread open.");
  if (tri.label === "needs_human") return set("warn", "Unclear, so a person reads it. Nothing is guessed.");
  if (o.alternativeDates.length) return set("warn", `Not the date asked. Offers ${o.alternativeDates.join(" or ")} to the booker instead.`);
  if (o.roomName === "Main dining room") return set("warn", "Not private, so it is rejected for this request. Learns the real room size.");
  const room = labVenue.rooms.find((r) => r.name === o.roomName) ?? labVenue.rooms[1];
  const pol = checkPolicy(company, { partySize: 12, partySizeStated: true, date: meta.date, dateAmbiguous: false, time: meta.time, kind: "client_dinner", clientName: "Acme", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" },
    labVenue, { ...o, minSpendCents: o.minSpendCents ?? room.minSpendCents[4] }, 72);
  if (!pol.onPolicy) return set("bad", `Rejected: ${pol.violations.join("; ")}.`);
  set("ok", `Would propose: ${usd(pol.estimate.allInCents)} all-in, ${usd(pol.estimate.perHeadAllInCents)} a head. Needs ${pol.requiredRoles.join(" + ")} approval.`);
}
let tmr = 0;
$("#mail").addEventListener("input", () => { clearTimeout(tmr); tmr = window.setTimeout(() => void analyze(), 120); });
$$("#v-lab .chip").forEach((b) => b.addEventListener("click", () => {
  $$("#v-lab .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  $<HTMLTextAreaElement>("#mail").value = template(b.dataset.t!); void analyze();
}));
$<HTMLTextAreaElement>("#mail").value = template("accept"); void analyze();

// ---------- evals ----------
const runs = new Map<string, ScenarioRun>();
const tiles = $("#tiles");
for (const s of SCENARIOS) {
  const t = el("div", "tile", s.id); t.title = s.text; t.dataset.id = s.id;
  t.onclick = () => showRun(s.id); tiles.append(t);
}
function showRun(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!, r = runs.get(id);
  $("#dTitle").textContent = `${id} · ${s.group.replace("_", " ")}`;
  const d = $("#detail"); d.className = "";
  if (!r) { d.innerHTML = `<pre>${esc(s.text)}</pre><div class="lbl">Not run yet.</div>`; return; }
  d.innerHTML = `<pre>"${esc(s.text)}"</pre><div class="lbl" style="margin:6px 0">${r.result.outcome.replace(/_/g, " ")} · ${r.emails} emails · ${Math.round(r.hours)} h simulated</div>`
    + `<table>${r.checks.map((c) => `<tr><td style="color:${c.pass ? "var(--good)" : "var(--bad)"}">${c.pass ? "✓" : "✗"}</td><td>${c.name}</td><td class="lbl">${esc(c.why)}</td></tr>`).join("")}</table>`
    + r.result.messagesToBooker.map((m) => `<div class="bubble" style="margin-top:8px">${esc(m)}</div>`).join("");
}
let inv = 0, invFail = 0;
$("#runEvals").onclick = async () => {
  const btn = $<HTMLButtonElement>("#runEvals"); btn.disabled = true;
  let pass = 0; inv = 0; invFail = 0; runs.clear();
  $$(".tile").forEach((t) => (t.className = "tile"));
  for (const s of SCENARIOS) {
    const t = tiles.querySelector<HTMLElement>(`[data-id="${s.id}"]`)!; t.className = "tile run";
    await sleep(40);
    const r = await runScenario(s, offline); runs.set(s.id, r);
    const ok = r.checks.every((c) => c.pass); if (ok) pass++;
    for (const c of r.checks.filter((c) => c.kind === "invariant")) { inv++; if (!c.pass) invFail++; }
    t.className = `tile ${ok ? "pass" : "fail"}`;
    $("#sPass").textContent = `${pass}/${SCENARIOS.length}`; $("#sInv").textContent = inv.toLocaleString(); $("#sFail").textContent = String(invFail);
  }
  showRun(SCENARIOS[0].id); btn.disabled = false;
};
$("#runFuzz").onclick = async () => {
  const btn = $<HTMLButtonElement>("#runFuzz"); btn.disabled = true;
  const out: Record<string, number> = {}; let checks = 0, fails = 0;
  const colors: Record<string, string> = { booked: "var(--good)", escalated: "var(--v)", rejected_by_booker: "var(--m)", awaiting_approval: "var(--c)", needs_clarification: "var(--dim)" };
  $("#dTitle").textContent = "300 random worlds"; $("#detail").innerHTML = `<div class="lbl">Random request × random venue behavior × random approver. Only safety is graded.</div>`;
  for (let i = 0; i < 300; i++) {
    const f = await fuzzOne(i, offline);
    out[f.outcome] = (out[f.outcome] ?? 0) + 1; checks += f.checks.length; fails += f.checks.filter((c) => !c.pass).length;
    if (i % 6 === 5 || i === 299) {
      $("#sFuzz").textContent = String(i + 1); $("#sFail").textContent = String(invFail + fails);
      $("#sInv").textContent = (inv + checks).toLocaleString();
      $("#obar").innerHTML = Object.entries(out).map(([k, n]) => `<i style="flex:${n};background:${colors[k]}"></i>`).join("");
      $("#olegend").innerHTML = Object.entries(out).map(([k, n]) => `<span style="color:${colors[k]}">● ${k.replace(/_/g, " ")} ${n}</span>`).join(" &nbsp; ");
      await sleep(16);
    }
  }
  btn.disabled = false;
};

// ---------- spend & policy ----------
function renderSpend() {
  const total = ledger.reduce((a, r) => a + r.allIn, 0), saved = ledger.reduce((a, r) => a + r.saved, 0);
  $("#kSpend").textContent = usd(total); $("#kSave").textContent = usd(saved); $("#kBooked").textContent = String(ledger.length);
  $("#kPolicy").textContent = ledger.length ? "100%" : "-";
  $("#ledger").innerHTML = ledger.map((r) => `<tr><td>${esc(r.venue)}</td><td>${r.guests}</td><td>${usd(r.allIn)}</td><td>${r.roles}</td></tr>`).join("");
}
const slider = (id: string, get: () => number, set: (n: number) => void, fmt: (n: number) => string) => {
  const s = $<HTMLInputElement>(`#${id}`); s.value = String(get());
  const show = () => { $(`#${id}V`).textContent = fmt(Number(s.value)); };
  s.oninput = () => { set(Number(s.value)); show(); void analyze(); }; show();
};
slider("cap", () => company.policy.perHeadCapCents.client_dinner / 100, (n) => (company.policy.perHeadCapCents.client_dinner = n * 100), (n) => `$${n}`);
slider("mgr", () => company.policy.managerApprovalAboveCents / 100, (n) => (company.policy.managerApprovalAboveCents = n * 100), (n) => `$${n.toLocaleString()}`);
slider("lead", () => company.policy.minLeadHours, (n) => (company.policy.minLeadHours = n), (n) => `${n} h`);
