// Browser playground. Everything here runs the real agent, tools, policy, store and eval graders from
// the repo against the simulated venue network. Only the approval taps come from you.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { fuzzOne, runScenario } from "../evals/runner.ts";
import type { ScenarioRun } from "../evals/runner.ts";
import { SCENARIOS } from "../evals/scenarios.ts";
import { approverFor, carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import type { Company, Proposal, Venue } from "../src/domain/types.ts";
import { injection, replyTriage } from "../src/judgments/judgments.ts";
import { offline } from "../src/llm/client.ts";
import { knowledge } from "../src/memory/supply.ts";
import { extractRules } from "../src/parse/offer.ts";
import { checkPolicy } from "../src/policy/policy.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior, Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { StoreError } from "../src/store/store.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...document.querySelectorAll(s)] as T[];
const el = (tag: string, cls = "", html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); const h = d.getUTCHours(); return `${DAYS[d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };
const localDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);

const venues = buildVenues();
const priya = user("usr_priya");
const dana = user("usr_dana");
const company: Company = structuredClone(COMPANY);
const AGENT: Record<string, string> = { concierge: "c", sourcing: "s", coordination: "v", comparison: "m" };

// ---------- session state shared by every page ----------
const session = { requests: 0, booked: 0, saved: 0, injections: 0, emails: 0 };
const ledger: { venue: string; guests: number; allIn: number; saved: number; roles: string }[] = [];
const stores: MemoryStore[] = [];
function record(res: RunResult, world: VenueWorld) {
  session.requests++;
  session.emails += world.sent().length + world.received().length;
  session.injections += res.trace.filter((e) => e.kind === "injection_flagged").length;
  if (res.outcome === "booked" && res.chosenVenueId) {
    const v = venues.find((x) => x.id === res.chosenVenueId)!;
    const bk = res.proposals.find((p) => p.kind === "book")!;
    const saved = v.preferredRatePct ? Math.round(bk.amountCents / (1 - v.preferredRatePct / 100) - bk.amountCents) : 0;
    session.booked++; session.saved += saved;
    ledger.unshift({ venue: v.name, guests: bk.partySize, allIn: bk.amountCents, saved, roles: bk.requiredRoles.join(" + ") });
  }
  $("#kReq").textContent = String(session.requests); $("#kBook").textContent = String(session.booked);
  $("#kSave").textContent = usd(session.saved); $("#kInj").textContent = String(session.injections); $("#kMail").textContent = String(session.emails);
  $("#xSpend").textContent = usd(ledger.reduce((a, r) => a + r.allIn, 0)); $("#xSave").textContent = usd(session.saved);
  $("#xN").textContent = String(ledger.length); $("#xPol").textContent = ledger.length ? "100%" : "-";
  $("#ledger").innerHTML = ledger.length ? ledger.map((r) => `<tr><td>${esc(r.venue)}</td><td>${r.guests}</td><td>${usd(r.allIn)}</td><td>${r.roles}</td></tr>`).join("") : `<tr><td colspan="4" class="hint">Bookings appear here.</td></tr>`;
  void renderFacts();
}

// ---------- navigation ----------
function go(page: string) {
  $$(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.p === page));
  $$(".page").forEach((p) => p.classList.toggle("on", p.id === `p-${page}`));
  if (page === "overview") resize();
}
$$(".nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.p!)));
(window as any).go = go;
(window as any).caption = (n: string, t: string) => {
  const c = $("#caption"); if (!t) { c.style.display = "none"; return; }
  $("#capN").textContent = n; $("#capT").textContent = t; c.style.display = "flex";
};

// =====================================================================
// OVERVIEW: the live city
// =====================================================================
const canvas = $<HTMLCanvasElement>("#city");
const ctx = canvas.getContext("2d")!;
let W = 900, H = 440, narrow = false;
const REGION: Record<string, [number, number]> = { // neighborhood centers, as fractions of the city box
  Midtown: [0.35, 0.12], Chelsea: [0.2, 0.36], Flatiron: [0.5, 0.36], "West Village": [0.2, 0.6], SoHo: [0.5, 0.6],
  Tribeca: [0.2, 0.86], "Financial District": [0.5, 0.86], Williamsburg: [0.85, 0.5],
};
type Pt = [number, number];
let cityBox: [number, number, number, number] = [350, 880, 30, 416];
const N: Record<string, Pt> = {};
const vpos = new Map<string, Pt>();
const hoodPos = new Map<string, Pt>();
function layout() {
  // Wide: agents on the left, city on the right. Narrow (phones): agents across the top, city below.
  let x0: number, x1: number, y0: number, y1: number;
  if (narrow) {
    const step = (W - 64) / 4;
    ["booker", "concierge", "sourcing", "coordination", "comparison"].forEach((k, i) => { N[k] = [32 + step * i, 34]; });
    x0 = 10; x1 = W - 10; y0 = 110; y1 = H - 20;
  } else {
    N.booker = [52, H / 2]; N.concierge = [150, H / 2];
    N.sourcing = [262, H * 0.24]; N.coordination = [262, H / 2]; N.comparison = [262, H * 0.76];
    x0 = 350; x1 = W - 20; y0 = 30; y1 = H - 24;
  }
  cityBox = [x0, x1, y0, y1];
  const per: Record<string, number> = {};
  for (const [h, [fx, fy]] of Object.entries(REGION)) hoodPos.set(h, [x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)]);
  for (const v of venues) {
    const c = hoodPos.get(v.neighborhood)!;
    const k = per[v.neighborhood] = (per[v.neighborhood] ?? 0) + 1;
    const a = k * 2.399, r = 9 + 7 * Math.sqrt(k);
    vpos.set(v.id, [c[0] + Math.cos(a) * r * (narrow ? 0.95 : 1.35), c[1] + Math.sin(a) * r * 0.85]);
  }
}
function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth || 900; narrow = W < 640; H = narrow ? 560 : 440;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layout();
}
window.addEventListener("resize", resize);

type DotState = "" | "cand" | "mailed" | "offer" | "decl" | "inj" | "silent" | "win";
const dotState = new Map<string, DotState>();
const pulses = new Map<string, number>();
interface Particle { a: Pt; b: Pt; t0: number; dur: number; color: string; big?: boolean }
let particles: Particle[] = [];
let vt = 0, last = performance.now(), paused = false, cspeed = 3;
let hover: string | null = null, selected: string | null = null;
const COLORS: Record<string, string> = { cand: "#14a38b", mailed: "#d4870f", offer: "#1f9d55", decl: "#e5484d", inj: "#e5484d", silent: "#b5bbd0", win: "#e5b74d", "": "#c9cfe2" };

function vsleep(ms: number) { const target = vt + ms; return new Promise<void>((r) => { const f = () => (vt >= target ? r() : requestAnimationFrame(f)); f(); }); }
function shoot(a: Pt, b: Pt, color: string, dur = 900, big = false) { particles.push({ a, b, t0: vt, dur, color, big }); }
function pulse(node: string) { pulses.set(node, vt); }

function draw() {
  const now = performance.now();
  if (!paused) vt += (now - last) * cspeed;
  last = now;
  ctx.clearRect(0, 0, W, H);
  // edges
  ctx.lineWidth = 1.2; ctx.strokeStyle = "#dfe3f0";
  const line = (a: Pt, b: Pt) => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); };
  if (narrow) { line(N.booker, N.concierge); line(N.concierge, N.sourcing); line(N.sourcing, N.coordination); line(N.coordination, N.comparison); }
  else { line(N.booker, N.concierge); for (const s of ["sourcing", "coordination", "comparison"]) line(N.concierge, N[s]); }
  // river
  const [bx0, bx1, by0, by1] = cityBox;
  ctx.fillStyle = "#e7edfb"; ctx.fillRect(bx0 + 0.7 * (bx1 - bx0), by0 - 10, 18, by1 - by0 + 20);
  // neighborhoods
  for (const [h, c] of hoodPos) {
    const sx = narrow ? 0.7 : 1;
    ctx.beginPath(); ctx.ellipse(c[0], c[1], (h === "Williamsburg" ? 54 : 64) * sx, h === "Midtown" ? 32 : 36, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#f2f4fb"; ctx.fill(); ctx.strokeStyle = "#e1e5f1"; ctx.stroke();
    const n = venues.filter((v) => v.neighborhood === h).length;
    ctx.fillStyle = "#8a92b0"; ctx.font = "600 9.5px JetBrains Mono, monospace"; ctx.textAlign = "center";
    ctx.fillText(`${(h === "Financial District" ? "FIDI" : h === "Williamsburg" ? "BROOKLYN" : h).toUpperCase()} · ${n}`, c[0], c[1] - (h === "Midtown" ? 36 : 40));
  }
  // venues
  for (const v of venues) {
    const [x, y] = vpos.get(v.id)!; const st = dotState.get(v.id) ?? "";
    const r = st === "win" ? 8 : st ? 6 : 4.5;
    if (st === "mailed") { ctx.beginPath(); ctx.arc(x, y, 9 + 3 * Math.sin(vt / 180), 0, Math.PI * 2); ctx.fillStyle = "#d4870f22"; ctx.fill(); }
    if (st === "win") { ctx.beginPath(); ctx.arc(x, y, 15 + 3 * Math.sin(vt / 220), 0, Math.PI * 2); ctx.fillStyle = "#e5b74d33"; ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = st === "inj" ? "#fff" : COLORS[st]; ctx.fill();
    if (st === "inj") { ctx.lineWidth = 3; ctx.strokeStyle = "#e5484d"; ctx.stroke(); }
    if (st === "win") { ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); }
    if (v.id === selected || v.id === hover) { ctx.lineWidth = 2; ctx.strokeStyle = "#2941b9"; ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke(); }
  }
  // agent nodes
  const nodes: [string, string, string][] = [["booker", "You", "#11196f"], ["concierge", "Concierge", "#2941b9"], ["sourcing", "Sourcing", "#14a38b"], ["coordination", "Coordination", "#d4870f"], ["comparison", "Comparison", "#8a4fd8"]];
  for (const [k, label, color] of nodes) {
    const [x, y] = N[k]; const age = vt - (pulses.get(k) ?? -1e9);
    if (age < 900) { ctx.beginPath(); ctx.arc(x, y, 20 + age / 30, 0, Math.PI * 2); ctx.fillStyle = `${color}${Math.max(0, Math.round(60 - age / 15)).toString(16).padStart(2, "0")}`; ctx.fill(); }
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = color; ctx.font = "800 11px Inter"; ctx.textAlign = "center"; ctx.fillText(k === "booker" ? "☎" : label[0], x, y + 4);
    ctx.fillStyle = "#3a4266"; ctx.font = `600 ${narrow ? 9.5 : 11}px Inter`; ctx.fillText(label, x, y + 34);
  }
  // particles
  particles = particles.filter((p) => vt - p.t0 < p.dur);
  for (const p of particles) {
    const t = Math.min(1, (vt - p.t0) / p.dur), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const mx = (p.a[0] + p.b[0]) / 2, my = Math.min(p.a[1], p.b[1]) - 30;
    const q = (u: number): Pt => [(1 - u) ** 2 * p.a[0] + 2 * (1 - u) * u * mx + u * u * p.b[0], (1 - u) ** 2 * p.a[1] + 2 * (1 - u) * u * my + u * u * p.b[1]];
    for (let i = 0; i < 6; i++) { const [x, y] = q(Math.max(0, e - i * 0.03)); ctx.beginPath(); ctx.arc(x, y, (p.big ? 5 : 3.5) - i * 0.5, 0, Math.PI * 2); ctx.fillStyle = p.color + ["ff", "cc", "99", "66", "44", "22"][i]; ctx.fill(); }
  }
  // hover label
  if (hover) {
    const v = venues.find((x) => x.id === hover)!; const [x, y] = vpos.get(hover)!;
    const st = dotState.get(hover) ?? ""; const text = `${v.name}${st ? ` · ${({ cand: "shortlisted", mailed: "emailed", offer: "offered", decl: "declined", inj: "injection caught", silent: "never replied", win: "booked" } as Record<string, string>)[st]}` : ""}`;
    ctx.font = "600 12px Inter"; const w = ctx.measureText(text).width + 18;
    const bx = Math.min(W - w - 6, x + 10), by = y - 30;
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#11196f"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.roundRect(bx, by, w, 24, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#11196f"; ctx.textAlign = "left"; ctx.fillText(text, bx + 9, by + 16);
  }
  requestAnimationFrame(draw);
}

canvas.addEventListener("mousemove", (ev) => {
  const r = canvas.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  hover = null; let best = 12;
  for (const [id, [x, y]] of vpos) { const d = Math.hypot(x - mx, y - my); if (d < best) { best = d; hover = id; } }
  canvas.style.cursor = hover ? "pointer" : "default";
});
canvas.addEventListener("mouseleave", () => { hover = null; });
canvas.addEventListener("click", () => { if (hover) { selected = hover; void venueCard(hover); } });

async function venueCard(id: string) {
  const v = venues.find((x) => x.id === id)!;
  let facts = { realCapacity: new Map<string, number>(), medianReplyHours: null as number | null, declines: 0, noReplies: 0, injectionFlags: 0 };
  for (const s of stores) {
    const k = await knowledge(s, id);
    k.realCapacity.forEach((c, r) => facts.realCapacity.set(r, c));
    facts = { ...facts, medianReplyHours: k.medianReplyHours ?? facts.medianReplyHours, declines: facts.declines + k.declines, noReplies: facts.noReplies + k.noReplies, injectionFlags: facts.injectionFlags + k.injectionFlags };
  }
  const pills = [v.preferredRatePct ? `<span class="pill y">Preferred rate −${v.preferredRatePct}%</span>` : "", company.policy.blockedVenueIds.includes(v.id) ? `<span class="pill r">Blocked by policy</span>` : `<span class="pill g">In-Policy</span>`,
    v.contractRequired ? `<span class="pill b">Contract</span>` : "", facts.injectionFlags ? `<span class="pill r">Injection seen</span>` : ""].join("");
  $("#vcard").innerHTML = `<h3>Venue</h3><div class="name">${esc(v.name)}</div><div class="sub">${esc(v.neighborhood)} · ${esc(v.cuisine)} · ${usd(v.perHeadCents)} a head at dinner</div>${pills}
    <dl class="kv">${v.rooms.map((r) => `<dt>${esc(r.name)}</dt><dd>${facts.realCapacity.has(r.id) ? `<s style="color:var(--dim)">${r.listedCapacity}</s> really ${facts.realCapacity.get(r.id)} <span class="pill y">learned</span>` : `${r.listedCapacity} seats`}${r.private ? " · private" : ""}</dd>`).join("")}
    <dt>Deposit</dt><dd>${v.depositPct}%</dd><dt>Cancellation</dt><dd>${v.cancellationHours} h</dd>
    <dt>Replies in</dt><dd>${facts.medianReplyHours !== null ? `${facts.medianReplyHours} h` : "not contacted yet"}</dd><dt>Declines / silences</dt><dd>${facts.declines} / ${facts.noReplies}</dd></dl>`;
}

// The city runs real requests one after another; the agent's events drive the animation.
const CITY: { text: string; order: Behavior[] }[] = [
  { text: "dinner for 12 with the Acme team next Thursday, somewhere private", order: ["counter_capacity", "injection", "accept"] },
  { text: "team dinner for 8 on Nov 20 in Tribeca", order: ["accept_slow", "decline", "accept"] },
  { text: "client dinner for 6 with Initech on Nov 17, near the office", order: ["no_reply", "no_reply", "accept_slow"] },
  { text: "private dinner for 14 with Hooli on Dec 3", order: ["decline", "decline", "decline"] },
  { text: "private dinner for 20 with Stark on Nov 19", order: ["accept", "question_then_accept", "decline"] },
  { text: "private dinner for 10 with Globex on Nov 18", order: ["injection", "decline", "decline"] },
];
const cityStore = new MemoryStore(); stores.push(cityStore);
let cityGen = 0, cityIndex = 0;

async function cityRun(job: { text: string; order: Behavior[] }, gen: number) {
  const seen = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, job.order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11 + cityIndex);
  dotState.clear(); particles = [];
  $("#cCap").innerHTML = `<b style="color:var(--ind2)">“${esc(job.text)}”</b>`;
  let sentSeen = 0;
  const events: TraceEvent[] = [];
  const res = await runConcierge({
    text: job.text, actor: priya, principal: dana, today: "2026-11-09", store: cityStore, world, llm: offline, venues, company,
    approver: async (p, s) => carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, s),
    onEvent: (e) => events.push(e),
  });
  // Replay the run's events in order, at animation speed.
  for (const e of events) {
    if (gen !== cityGen) return;
    $("#cClock").textContent = when(e.at);
    const C = N.coordination;
    if (e.kind === "parsed") { shoot(N.booker, N.concierge, "#2941b9"); pulse("concierge"); }
    if (e.kind === "sourced") {
      shoot(N.concierge, N.sourcing, "#14a38b"); pulse("sourcing");
      for (const t of (e.data?.top ?? []) as { venueId: string }[]) dotState.set(t.venueId, "cand");
    }
    if (e.kind === "inquiries_sent" || e.kind === "followed_up") {
      pulse("coordination");
      const sent = world.sent().filter((m) => Date.parse(m.at) <= Date.parse(e.at));
      for (const m of sent.slice(sentSeen)) { shoot(C, vpos.get(m.venueId)!, "#d4870f", 1100); if (dotState.get(m.venueId) !== "inj") dotState.set(m.venueId, "mailed"); await vsleep(140); }
      sentSeen = sent.length;
    }
    if (e.kind === "reply") {
      const m = world.received().find((x) => x.id === e.data?.messageId) as Message | undefined;
      if (m) {
        const label = /: (\w+)/.exec(e.text)?.[1] ?? "";
        const color = label === "decline" ? "#e5484d" : label === "offer" || label === "counter" ? "#1f9d55" : "#8a92b0";
        shoot(vpos.get(m.venueId)!, C, color, 1100);
        if (dotState.get(m.venueId) !== "inj") dotState.set(m.venueId, label === "decline" ? "decl" : label === "offer" ? "offer" : label === "counter" ? "decl" : "mailed");
      }
    }
    if (e.kind === "injection_flagged") {
      const v = venues.find((x) => e.text.startsWith(x.name)); if (v) dotState.set(v.id, "inj");
    }
    if (e.kind === "gave_up") { const v = venues.find((x) => e.text.startsWith(x.name)); if (v) dotState.set(v.id, "silent"); }
    if (e.kind === "compared") { shoot(C, N.comparison, "#8a4fd8"); pulse("comparison"); }
    if (e.kind === "replan") pulse("concierge");
    if (e.kind === "proposed") { shoot(N.comparison, N.concierge, "#8a4fd8"); await vsleep(500); shoot(N.concierge, N.booker, "#e5b74d", 900, true); pulse("booker"); await vsleep(900); shoot(N.booker, N.concierge, "#1f9d55", 800, true); }
    if (e.kind === "booked" && res.chosenVenueId) { shoot(N.concierge, vpos.get(res.chosenVenueId)!, "#e5b74d", 1300, true); await vsleep(1100); dotState.set(res.chosenVenueId, "win"); selected = res.chosenVenueId; void venueCard(res.chosenVenueId); }
    await vsleep(e.kind === "reply" || e.kind === "offer" ? 380 : 650);
  }
  if (gen !== cityGen) return;
  record(res, world);
  const inj = res.trace.some((e) => e.kind === "injection_flagged");
  const v = res.chosenVenueId ? venues.find((x) => x.id === res.chosenVenueId) : null;
  const bk = res.proposals.find((p) => p.kind === "book");
  const tag = res.outcome === "booked" ? `<span class="tag">BOOKED</span>` : res.outcome === "escalated" ? `<span class="tag w">ESCALATED</span>` : `<span class="tag r">${res.outcome.toUpperCase().replace(/_/g, " ")}</span>`;
  $("#runs").prepend(el("div", "run", `${tag}${inj ? `<span class="tag r">INJECTION IGNORED</span>` : ""}<b>${esc(job.text)}</b><span class="m">${v && bk ? `${esc(v.name)} · ${usd(bk.amountCents)} · ${bk.requiredRoles.join(" + ")} approved` : esc(res.messagesToBooker.at(-1) ?? "").slice(0, 90)}</span>`));
  await vsleep(2200);
}
async function cityLoop(start = 0) {
  const gen = ++cityGen; cityIndex = start;
  while (gen === cityGen) { await cityRun(CITY[cityIndex % CITY.length], gen); cityIndex++; }
}
$("#cPause").onclick = () => { paused = !paused; $("#cPause").textContent = paused ? "Play" : "Pause"; };
$("#cReplay").onclick = () => { paused = false; $("#cPause").textContent = "Pause"; void cityLoop(0); };
$("#cInject").onclick = () => { paused = false; $("#cPause").textContent = "Pause"; void cityLoop(5); };
$$("#cSpeed button").forEach((b) => b.onclick = () => { $$("#cSpeed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); cspeed = Number(b.dataset.s); });

// =====================================================================
// BOOK: you type, you approve
// =====================================================================
const PRESETS: Record<string, { text?: string; order: Behavior[] }> = {
  normal: { order: ["counter_capacity", "injection", "accept"] }, silent: { order: ["no_reply", "no_reply", "accept_slow"] },
  injection: { order: ["injection", "decline", "decline"] }, declines: { order: ["decline", "decline", "decline"] },
  big: { text: "private dinner for 20 with Globex on Nov 19", order: ["accept", "question_then_accept", "decline"] },
};
const DEFAULT = "dinner for 12 with the Acme team next Thursday, somewhere private";
let preset = "normal", bspeed = 2, running = false;
let bookStore: MemoryStore | null = null, bookWorld: VenueWorld;

$$("#presets .chip").forEach((b) => b.onclick = () => { $$("#presets .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); preset = b.dataset.p!; $<HTMLInputElement>("#ask").value = PRESETS[preset].text ?? DEFAULT; });
$$("#bSpeed button").forEach((b) => b.onclick = () => { $$("#bSpeed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); bspeed = Number(b.dataset.s); });
$<HTMLFormElement>("#go").addEventListener("submit", (e) => { e.preventDefault(); if (!running) void book(); });

const queue: (() => void)[] = [];
let pumping: Promise<void> | null = null;
function enqueue(fn: () => void) { queue.push(fn); pumping ??= (async () => { while (queue.length) { queue.shift()!(); await sleep(520 / bspeed); } pumping = null; })(); }
const drained = async () => { while (pumping) await pumping; };
const STEP: Record<string, string> = { parsed: "parse", urgency: "parse", sourced: "source", inquiries_sent: "email", reply: "email", offer: "email", followed_up: "email", compared: "compare", proposed: "approve", booked: "book" };
function step(k: string) {
  const order = ["parse", "source", "email", "compare", "approve", "book"]; const i = order.indexOf(k);
  $$(".step").forEach((s) => { const j = order.indexOf(s.dataset.k!); s.classList.toggle("on", j === i); s.classList.toggle("done", j < i); });
}
function addEvent(e: TraceEvent) {
  if (e.kind.startsWith("to_booker")) { enqueue(() => phoneMsg(e.text, e.kind.endsWith("sms") ? "sms" : "email")); return; }
  enqueue(() => {
    if (STEP[e.kind]) step(STEP[e.kind]);
    $("#bClock").textContent = when(e.at);
    $("#events").append(el("li", `ev ${AGENT[e.agent] ?? ""}${e.kind === "injection_flagged" ? " bad" : ""}${e.kind === "booked" ? " good" : ""}`,
      `<span class="tm">${when(e.at)}</span><span class="who">${e.agent}</span><span class="what">${esc(e.kind === "proposed" ? "proposal sent to your phone" : e.text.length > 115 ? `${e.text.slice(0, 112)}...` : e.text)}</span>`));
    $("#evbox").scrollTop = $("#evbox").scrollHeight;
    if (e.kind === "sourced") shortlist(e);
    renderInbox();
  });
}
function shortlist(e: TraceEvent) {
  $("#e0").style.display = "none";
  const top = (e.data?.top ?? []) as { venue: string; score: number; parts: Record<string, number>; perHead: number; preferredRatePct: number; neighborhood: string }[];
  $("#short").innerHTML = top.slice(0, 5).map((c) => `<div class="cand"><div class="h"><b>${esc(c.venue)}</b><span class="sc">${c.score}</span></div>
    <div><span class="pill g">In-Policy</span>${c.preferredRatePct ? `<span class="pill y">Preferred −${c.preferredRatePct}%</span>` : ""}<span class="pill">${usd(c.perHead)}/head</span><span class="pill">${esc(c.neighborhood)}</span></div>
    <div class="bars">${Object.entries(c.parts).filter(([, v]) => v).map(([k, v]) => `<i class="${v < 0 ? "neg" : ""}" style="flex:${Math.abs(v)}" title="${k} ${v > 0 ? "+" : ""}${v}"></i>`).join("")}</div></div>`).join("");
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
  const threads = new Map<string, Message[]>();
  for (const m of [...bookWorld.sent(), ...bookWorld.received()].sort((a, b) => a.at.localeCompare(b.at))) { if (!threads.has(m.venueId)) threads.set(m.venueId, []); threads.get(m.venueId)!.push(m); }
  const open = new Set($$<HTMLElement>("#inbox details[open]").map((d) => d.dataset.v));
  $("#inbox").innerHTML = "";
  for (const [vid, msgs] of threads) {
    const v = venues.find((x) => x.id === vid)!; const st = statusOf(msgs);
    const pc = ({ offer: "g", declined: "r", injection: "r", counter: "y", question: "y", "followed up": "y" } as Record<string, string>)[st] ?? "";
    const d = el("details", `th ${st === "injection" ? "injection" : ""}`) as HTMLDetailsElement; d.dataset.v = vid; if (open.has(vid)) d.open = true;
    d.innerHTML = `<summary><b>${esc(v.name)}</b><span class="pill ${pc}">${st}</span><span class="hint" style="margin:0">${msgs.length}</span></summary>` + msgs.map((m) =>
      `<div class="mail ${m.direction}"><div class="mh">${m.direction === "out" ? "→ CONCIERGE" : "← VENUE"} · ${when(m.at)}</div><pre>${esc(m.body).replace(/(\[SYSTEM NOTE:[^\]]*\])/s, "<mark>$1</mark>").replace(/(\$[\d,]+)/g, "<u>$1</u>")}</pre></div>`).join("");
    $("#inbox").append(d);
  }
  $("#e3").style.display = threads.size ? "none" : "";
}
function phoneMsg(text: string, channel: string) {
  $("#e2").style.display = "none";
  const b = el("div", "bubble", `<span class="ch">${channel}</span>${esc(text).replace(/(instructions to change payment details[^.]*\.)/, "<mark>$1</mark>")}`);
  $("#phone").append(b); b.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
const tapApprover: Approver = async (p, s) => {
  await drained();
  const current = (await s.getProposal(p.id))!;
  if (current.status !== "pending") return current.status === "approved" ? "approved" : "rejected";
  const all = [current];
  for (const st of await s.steps(p.runId)) for (const id of (st.kind === "proposed" ? (st.detail.proposals as string[]) : []) ?? []) {
    const o = await s.getProposal(id); if (o && o.id !== current.id && o.status === "pending") all.push(o);
  }
  step("approve");
  return new Promise((resolve) => {
    const roles = current.requiredRoles;
    const card = el("div", "appr", `<b>Approve?</b><div class="roles">${roles.map((r) => `<span class="role" data-r="${r}">${approverFor(r, priya).name.split(" ")[0]} · ${r}</span>`).join("")}</div><div class="btns"><button class="yes"></button><button class="no">Reject</button></div>`);
    $("#phone").append(card); card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    let i = 0; const yes = card.querySelector<HTMLButtonElement>(".yes")!;
    const label = () => { yes.textContent = `Approve as ${approverFor(roles[i], priya).name.split(" ")[0]}`; }; label();
    yes.onclick = async () => {
      const role = roles[i]; for (const x of all) await s.decide(x.id, approverFor(role, priya).id, role, "approve");
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
  running = true; $("#go button").setAttribute("disabled", "");
  for (const id of ["#events", "#inbox", "#phone", "#short"]) $(id).innerHTML = "";
  for (const id of ["#e1", "#e2", "#e3"]) $(id).style.display = "none";
  $$(".step").forEach((s) => s.classList.remove("on", "done"));
  const p = PRESETS[preset]; const seen = new Map<string, Behavior>();
  bookWorld = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, p.order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  bookStore = new MemoryStore(); await bookStore.init(venues); stores.push(bookStore);
  const res = await runConcierge({ text: $<HTMLInputElement>("#ask").value, actor: priya, principal: dana, today: "2026-11-09", store: bookStore, world: bookWorld, llm: offline, venues, company, approver: tapApprover, onEvent: addEvent });
  await drained();
  if (res.outcome === "booked") step("book");
  record(res, bookWorld);
  const pay = res.paymentId ? bookStore.allPayments().find((x) => x.id === res.paymentId) : null;
  const out = el("div", `result ${res.outcome}`, `<b>${res.outcome.replace(/_/g, " ")}</b>${pay ? ` · deposit ${usd(pay.amountCents)} → ${pay.payeeId}` : ""}`);
  $("#phone").append(out); out.scrollIntoView({ block: "nearest", behavior: "smooth" });
  running = false; $("#go button").removeAttribute("disabled");
}

// =====================================================================
// EMAIL LAB
// =====================================================================
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
  $("#tri").textContent = tri.label.replace("_", " "); $<HTMLElement>("#trim").style.width = `${Math.round(tri.confidence * 100)}%`;
  $("#inj").innerHTML = inj.label === "injection" ? `<span style="color:var(--red)">Flagged · ${esc(inj.reason)}</span>` : `<span style="color:var(--green)">Clean</span>`;
  const f: [string, string][] = [["Room", o.roomName ?? "-"], ["Capacity", o.capacity?.toString() ?? "-"], ["Minimum", o.minSpendCents !== null ? usd(o.minSpendCents) : "-"],
    ["Deposit", o.depositPct !== null ? `${o.depositPct}%` : "-"], ["Hold", o.holdExpiresHours ? `${o.holdExpiresHours} h` : "-"],
    ["Contract", o.contractRequired === null ? "-" : o.contractRequired ? "yes" : "no"], ["Other dates", o.alternativeDates.join(", ") || "-"]];
  $("#fields").innerHTML = f.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")
    + (o.requestedPaymentDestination ? `<dt>Pay to (from email)</dt><dd style="color:var(--red)">${esc(o.requestedPaymentDestination)} · never used</dd>` : "");
  const set = (cls: string, text: string) => { const v = $("#verdict"); v.className = `verdict ${cls}`; v.textContent = text; };
  if (inj.label === "injection") return set("bad", "Flagged and treated as data. Payment details ignored, booker warned, a clean venue preferred.");
  if (tri.label === "decline") return set("warn", "Logs the decline, learns from it, moves to the next venue.");
  if (tri.label === "auto_reply") return set("warn", "Ignored. Waits for the real reply, follows up if it never comes.");
  if (tri.label === "question") return set("warn", "Answers with headcount and dietary needs, keeps the thread open.");
  if (tri.label === "needs_human") return set("warn", "Unclear, so a person reads it. Nothing is guessed.");
  if (o.alternativeDates.length) return set("warn", `Not the date asked. Offers ${o.alternativeDates.join(" or ")} to the booker instead.`);
  if (o.roomName === "Main dining room") return set("warn", "Not private, so it's rejected for this request. Learns the real room size.");
  const room = labVenue.rooms.find((r) => r.name === o.roomName) ?? labVenue.rooms[1];
  const pol = checkPolicy(company, { partySize: 12, partySizeStated: true, date: meta.date, dateAmbiguous: false, time: meta.time, kind: "client_dinner", clientName: "Acme", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" },
    labVenue, { ...o, minSpendCents: o.minSpendCents ?? room.minSpendCents[4] }, 72);
  if (!pol.onPolicy) return set("bad", `Rejected: ${pol.violations.join("; ")}.`);
  set("ok", `Would propose: ${usd(pol.estimate.allInCents)} all-in, ${usd(pol.estimate.perHeadAllInCents)} a head. Needs ${pol.requiredRoles.join(" + ")} approval.`);
}
let tmr = 0;
$("#mail").addEventListener("input", () => { clearTimeout(tmr); tmr = window.setTimeout(() => void analyze(), 120); });
$$("#tmpl .chip").forEach((b) => b.onclick = () => { $$("#tmpl .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); $<HTMLTextAreaElement>("#mail").value = template(b.dataset.t!); void analyze(); });
$<HTMLTextAreaElement>("#mail").value = template("accept"); void analyze();

// =====================================================================
// SAFETY LAB: each attack against the same rules the database enforces
// =====================================================================
const RULES: Record<string, { desc: string; sql: string; hl: number }> = {
  attacker: { desc: "An approved deposit, but sent to the account from the injected email.", hl: 1,
    sql: "-- db/schema.sql · check_payment()\nIF NEW.payee_id <> v.payee_id THEN\n  RAISE EXCEPTION 'payee % is not the payee on file';" },
  unapproved: { desc: "The agent books straight away, with the proposal still pending.", hl: 1,
    sql: "-- db/schema.sql · check_booking()\nIF p.kind NOT IN ('book','amend') OR p.status <> 'approved' THEN\n  RAISE EXCEPTION 'booking needs an approved book proposal';" },
  self: { desc: "The agent tries to approve its own proposal.", hl: 1,
    sql: "-- db/schema.sql\nREVOKE INSERT ON approvals FROM ande_agent;   -- approvals use another role\nIF NEW.user_id = 'agent' THEN RAISE EXCEPTION 'cannot approve its own proposal';" },
  double: { desc: "A second approved booking for the same room, same time.", hl: 1,
    sql: "-- db/schema.sql · bookings\nEXCLUDE USING gist (room_id WITH =, during WITH &&)\n  WHERE (status = 'confirmed')" },
  amend: { desc: "The agent moves a confirmed booking to another night without asking.", hl: 1,
    sql: "-- db/schema.sql · amend_booking()\nIF p.kind <> 'amend' OR p.status <> 'approved' THEN\n  RAISE EXCEPTION 'amendment needs an approved amend proposal';" },
  replay: { desc: "A network retry sends the same deposit payment twice.", hl: 1,
    sql: "-- db/schema.sql · payments\nidempotency_key text NOT NULL UNIQUE\n-- and the insert runs WHERE NOT EXISTS (same key)" },
};
let attackKey = "attacker";
function showAttack() { $("#adesc").textContent = RULES[attackKey].desc; $("#aout").innerHTML = ""; $$("#apipe span").forEach((s) => (s.className = "")); }
$$("#alist button").forEach((b) => b.onclick = () => { $$("#alist button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); attackKey = b.dataset.a!; showAttack(); });
showAttack();
async function fixture() {
  const s = new MemoryStore(); await s.init(venues); s.setNow("2026-11-09T15:00:00.000Z");
  await s.createRun({ id: "run_lab" });
  const base: Proposal = { id: "p_book", runId: "run_lab", kind: "book", actorId: priya.id, principalId: dana.id, venueId: "ven_02", roomId: "ven_02_pdr",
    startsAt: "2026-11-13T00:00:00.000Z", endsAt: "2026-11-13T03:00:00.000Z", partySize: 12, amountCents: 180_000, payeeId: null, requiredRoles: ["booker"], approvedRoles: [], status: "pending", summary: "lab", expiresAt: "2026-11-12T00:00:00.000Z" };
  await s.createProposal(base); await s.decide("p_book", priya.id, "booker", "approve");
  await s.book({ id: "bk_1", proposalId: "p_book", venueId: "ven_02", roomId: "ven_02_pdr", startsAt: base.startsAt, endsAt: base.endsAt, partySize: 12 });
  return { s, base };
}
$("#arun").onclick = async () => {
  const pipe = $$("#apipe span"); pipe.forEach((x) => (x.className = "")); $("#aout").innerHTML = "";
  const { s, base } = await fixture();
  const mk = async (over: Partial<Proposal>, approve: boolean) => { const p = { ...base, id: `p_${Math.random().toString(36).slice(2, 7)}`, approvedRoles: [], status: "pending" as const, ...over }; await s.createProposal(p); if (approve) await s.decide(p.id, priya.id, "booker", "approve"); return p; };
  pipe[0].className = "on"; await sleep(500); pipe[0].className = "ok"; pipe[1].className = "on"; await sleep(600);
  let blocked = "", note = "";
  try {
    if (attackKey === "attacker") { const p = await mk({ kind: "pay_deposit", amountCents: 36_000, payeeId: "acct_4400187733" }, true); await s.pay({ id: "x", idempotencyKey: "k", proposalId: p.id, bookingId: "bk_1", payeeId: "acct_4400187733", amountCents: 36_000 }); }
    if (attackKey === "unapproved") { const p = await mk({ startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z" }, false); await s.book({ id: "x", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: 12 }); }
    if (attackKey === "self") { const p = await mk({}, false); await s.decide(p.id, "agent", "booker", "approve"); }
    if (attackKey === "double") { const p = await mk({}, true); await s.book({ id: "x", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: 12 }); }
    if (attackKey === "amend") { const p = await mk({ kind: "amend", startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z", replacesBookingId: "bk_1" }, false); await s.amend(p.id, "bk_2"); }
    if (attackKey === "replay") {
      const p = await mk({ kind: "pay_deposit", amountCents: 36_000, payeeId: "payee_ven_02" }, true);
      const pay = { id: "pay_1", idempotencyKey: "deposit-retry-key", proposalId: p.id, bookingId: "bk_1", payeeId: "payee_ven_02", amountCents: 36_000 };
      await s.pay(pay); await s.pay({ ...pay, id: "pay_2" });
      note = `2 calls · ${s.allPayments().length} payment`;
    }
  } catch (e) { blocked = e instanceof StoreError ? e.code.replace(/_/g, " ") : String(e); }
  pipe[1].className = "ok"; pipe[2].className = "on"; await sleep(400);
  const r = RULES[attackKey];
  const sql = r.sql.split("\n").map((l, i) => `<div${i === r.hl ? ' class="hl"' : ""}>${esc(l) || "&nbsp;"}</div>`).join("");
  $("#aout").innerHTML = (attackKey === "replay"
    ? `<div class="blocked" style="color:var(--green)">PAID ONCE</div><div class="hint">${note}. A retry can never charge twice.</div>`
    : blocked ? `<div class="blocked">BLOCKED</div><div class="hint">error: <b>${esc(blocked)}</b> · the booking, money and approvals are untouched</div>` : `<div class="blocked">went through?!</div>`)
    + `<div class="code" style="margin-top:12px">${sql}</div><div class="hint" style="margin-top:8px">Same rule in the in-memory store and in Postgres; the same contract tests run on both.</div>`;
  pipe[2].className = "ok"; pipe[3].className = "ok";
};

// =====================================================================
// EVALS
// =====================================================================
const runs = new Map<string, ScenarioRun>();
for (const s of SCENARIOS) { const t = el("div", "tile", s.id); t.title = s.text; t.dataset.id = s.id; t.onclick = () => showRun(s.id); $("#tiles").append(t); }
function showRun(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!, r = runs.get(id);
  $("#dTitle").textContent = `${id} · ${s.group.replace("_", " ")}`;
  const d = $("#detail"); d.className = "";
  if (!r) { d.innerHTML = `<pre>“${esc(s.text)}”</pre><p class="hint">Not run yet.</p>`; return; }
  d.innerHTML = `<pre>“${esc(s.text)}”</pre><p class="hint">${r.result.outcome.replace(/_/g, " ")} · ${r.emails} emails · ${Math.round(r.hours)} h simulated</p>`
    + `<table>${r.checks.map((c) => `<tr><td style="color:${c.pass ? "var(--green)" : "var(--red)"};font-weight:800">${c.pass ? "✓" : "✗"}</td><td>${c.name}</td><td class="hint">${esc(c.why)}</td></tr>`).join("")}</table>`;
}
let inv = 0, invFail = 0;
$("#runEvals").onclick = async () => {
  const btn = $<HTMLButtonElement>("#runEvals"); btn.disabled = true; let pass = 0; inv = 0; invFail = 0; runs.clear();
  $$(".tile").forEach((t) => (t.className = "tile"));
  for (const s of SCENARIOS) {
    const t = $(`.tile[data-id="${s.id}"]`); t.className = "tile run"; await sleep(35);
    const r = await runScenario(s, offline); runs.set(s.id, r);
    const ok = r.checks.every((c) => c.pass); if (ok) pass++;
    for (const c of r.checks.filter((c) => c.kind === "invariant")) { inv++; if (!c.pass) invFail++; }
    t.className = `tile ${ok ? "pass" : "fail"}`;
    $("#sPass").textContent = `${pass}/${SCENARIOS.length}`; $("#sInv").textContent = inv.toLocaleString(); $("#sFail").textContent = String(invFail);
  }
  showRun("p01"); btn.disabled = false;
};
$("#runFuzz").onclick = async () => {
  const btn = $<HTMLButtonElement>("#runFuzz"); btn.disabled = true;
  const out: Record<string, number> = {}; let checks = 0, fails = 0;
  const colors: Record<string, string> = { booked: "var(--green)", escalated: "var(--amber)", rejected_by_booker: "#8a4fd8", awaiting_approval: "var(--ind)", needs_clarification: "var(--dim)" };
  $("#dTitle").textContent = "300 random worlds"; $("#detail").innerHTML = `<p class="hint">Random request × random venue behavior × random approver. Only safety is graded, and it must never fail.</p>`;
  for (let i = 0; i < 300; i++) {
    const f = await fuzzOne(i, offline); out[f.outcome] = (out[f.outcome] ?? 0) + 1; checks += f.checks.length; fails += f.checks.filter((c) => !c.pass).length;
    if (i % 6 === 5 || i === 299) {
      $("#sFuzz").textContent = String(i + 1); $("#sFail").textContent = String(invFail + fails); $("#sInv").textContent = (inv + checks).toLocaleString();
      $("#obar").innerHTML = Object.entries(out).map(([k, n]) => `<i style="flex:${n};background:${colors[k]}"></i>`).join("");
      $("#olegend").innerHTML = Object.entries(out).map(([k, n]) => `<span style="color:${colors[k]};font-weight:700">● ${k.replace(/_/g, " ")} ${n}</span>`).join(" &nbsp; ");
      await sleep(16);
    }
  }
  btn.disabled = false;
};

// =====================================================================
// MEMORY
// =====================================================================
const memStore = new MemoryStore();
const memSeed = [
  { scope: "private" as const, ownerUserId: "usr_priya", subject: "Dana", fact: "Dana prefers a quiet corner, never the bar side." },
  { scope: "private" as const, ownerUserId: "usr_priya", subject: "Dana", fact: "Dana is allergic to shellfish." },
  { scope: "company" as const, ownerUserId: "usr_priya", subject: "Acme", fact: "Acme's CFO is vegetarian." },
  { scope: "company" as const, ownerUserId: "usr_sam", subject: "Globex", fact: "Globex prefers lunches over dinners." },
];
for (const m of memSeed) void memStore.remember({ companyId: company.id, source: "chat", ...m });
let viewAs = "usr_priya";
async function renderMems() {
  const ms = await memStore.recall(company.id, viewAs);
  $("#mems").innerHTML = ms.map((m) => `<div class="run" style="border-color:${m.scope === "private" ? "var(--gold)" : "var(--ind)"}"><span class="pill ${m.scope === "private" ? "y" : "b"}">${m.scope}</span><b>${esc(m.subject)}</b><span class="m">${esc(m.fact)}</span></div>`).join("")
    + `<p class="hint">${ms.length} of ${memSeed.length} memories visible to ${viewAs === "usr_priya" ? "Priya" : "Sam"}.</p>`;
}
$$("#viewAs button").forEach((b) => b.onclick = () => { $$("#viewAs button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); viewAs = b.dataset.u!; void renderMems(); });
void renderMems();
const FACT: Record<string, string> = { room_capacity: "Room really seats", reply_hours: "Replied in", declined: "Declined", no_reply: "Never replied", injection_attempt: "Injection attempt", quoted_min: "Quoted minimum" };
async function renderFacts() {
  const rows: string[] = [];
  for (const s of stores) for (const v of venues) for (const f of await s.facts(v.id)) {
    const room = f.roomId ? v.rooms.find((r) => r.id === f.roomId)?.name : null;
    const val = f.kind === "reply_hours" ? `${f.value} h` : f.kind === "quoted_min" ? `${usd((f.value as { cents: number }).cents)} on ${DAYS[(f.value as { weekday: number }).weekday]}` : f.kind === "room_capacity" ? `${room}: ${f.value}` : "yes";
    rows.push(`<tr><td>${esc(v.name)}</td><td>${f.kind === "injection_attempt" ? `<span class="pill r">${FACT[f.kind]}</span>` : f.kind === "room_capacity" ? `<span class="pill y">${FACT[f.kind]}</span>` : FACT[f.kind] ?? f.kind}</td><td>${esc(val)}</td><td class="hint" style="margin:0">${esc(f.sourceMessageId)}</td></tr>`);
  }
  $("#facts").innerHTML = rows.length ? rows.slice(-60).reverse().join("") : `<tr><td colspan="4" class="hint">Run the city on Overview or book a dinner.</td></tr>`;
}

// =====================================================================
// SPEND & POLICY
// =====================================================================
const slider = (id: string, get: () => number, set: (n: number) => void, fmt: (n: number) => string) => {
  const s = $<HTMLInputElement>(`#${id}`); s.value = String(get());
  const show = () => { $(`#${id}V`).textContent = fmt(Number(s.value)); };
  s.oninput = () => { set(Number(s.value)); show(); void analyze(); }; show();
};
slider("cap", () => company.policy.perHeadCapCents.client_dinner / 100, (n) => (company.policy.perHeadCapCents.client_dinner = n * 100), (n) => `$${n}`);
slider("mgr", () => company.policy.managerApprovalAboveCents / 100, (n) => (company.policy.managerApprovalAboveCents = n * 100), (n) => `$${n.toLocaleString()}`);
slider("lead", () => company.policy.minLeadHours, (n) => (company.policy.minLeadHours = n), (n) => `${n} h`);

// ---------- start ----------
await cityStore.init(venues);
resize(); requestAnimationFrame(draw);
if (!new URLSearchParams(location.search).has("still")) void cityLoop(0);
