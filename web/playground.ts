// The live site. Every page runs the real agent, tools, policy, store and graders from this repo
// against the simulated venue network. Model calls replay recorded Claude outputs (evals/recordings),
// exactly as CI does; anything not recorded falls back to the deterministic path, and the UI says which.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { fuzzOne, runScenario } from "../evals/runner.ts";
import type { ScenarioRun } from "../evals/runner.ts";
import { SCENARIOS } from "../evals/scenarios.ts";
import { approverFor, carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import type { BookingRequest, Company, Offer, Proposal, Venue } from "../src/domain/types.ts";
import { injection, replyTriage, smsConsent } from "../src/judgments/judgments.ts";
import { ReplayLLM } from "../src/llm/client.ts";
import type { LLM } from "../src/llm/client.ts";
import { judgeMessage } from "../evals/judge.ts";
import { call, ToolDenied } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/registry.ts";
import { amendBooking, book as bookTool, cancelBooking, createProposal, eventWindow, leadHours, notifyBooker, payDeposit, recordFact, sendVenueEmail } from "../src/tools/tools.ts";
import { ZodError } from "zod";
import { knowledge } from "../src/memory/supply.ts";
import { extractRules } from "../src/parse/offer.ts";
import { checkPolicy, estimate, perHeadFor } from "../src/policy/policy.ts";
import type { PolicyResult } from "../src/policy/policy.ts";
import { addDays, weekday } from "../src/time.ts";
import { extractOffer } from "../src/parse/offer.ts";
import { VenueWorld } from "../src/sim/world.ts";
import type { Behavior, Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { StoreError } from "../src/store/store.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll(s)] as T[];
const el = (tag: string, cls = "", html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); const h = d.getUTCHours(); return `${DAYS[d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };
const localDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);
const scen = (id: string) => SCENARIOS.find((s) => s.id === id)!;

const llm = new ReplayLLM("claude-sonnet-4-5");
const venues = buildVenues();
const priya = user("usr_priya"), dana = user("usr_dana");
const company: Company = structuredClone(COMPANY);
const AGENT: Record<string, string> = { concierge: "c", sourcing: "s", coordination: "v", comparison: "m" };
const isAI = (e: TraceEvent) => e.data?.decidedBy === "model" || / \(model\)$/.test(e.text);

// ---------- session state ----------
const S = { req: 0, booked: 0, saved: 0, inj: 0, mail: 0, ai: 0 };
const ledger: { venue: string; guests: number; allIn: number; saved: number }[] = [];
const stores: MemoryStore[] = [];
const srcOf = new Map<MemoryStore, string>();
function bump(id: string, v: string) { const k = $(`#${id}`); if (k.textContent !== v) { k.textContent = v; k.parentElement!.classList.remove("bump"); void k.offsetWidth; k.parentElement!.classList.add("bump"); } }
function record(res: RunResult, world: VenueWorld) {
  S.req++; S.mail += world.sent().length + world.received().length;
  S.inj += res.trace.filter((e) => e.kind === "injection_flagged").length;
  S.ai += res.trace.filter(isAI).length;
  if (res.outcome === "booked" && res.chosenVenueId) {
    const v = venues.find((x) => x.id === res.chosenVenueId)!, bk = res.proposals.find((p) => p.kind === "book")!;
    const saved = v.preferredRatePct ? Math.round(bk.amountCents / (1 - v.preferredRatePct / 100) - bk.amountCents) : 0;
    S.booked++; S.saved += saved; ledger.unshift({ venue: v.name, guests: bk.partySize, allIn: bk.amountCents, saved });
  }
  bump("kReq", String(S.req)); bump("kBook", String(S.booked)); bump("kSave", usd(S.saved)); bump("kInj", String(S.inj)); bump("kMail", String(S.mail)); bump("kAI", String(S.ai));
  renderSpend(); void renderKnowledge();
}

// ---------- navigation ----------
function go(page: string) {
  $$<HTMLButtonElement>("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === page));
  $$(".page").forEach((p) => p.classList.toggle("on", p.id === `p-${page}`));
  if (location.hash.slice(1) !== page) history.replaceState(null, "", `#${page}`);
  if (page === "bookings") void renderBookings();
  if (page === "calendar") void renderCal();
  if (page === "explore") renderExplore();
  document.body.classList.remove("menu"); const cur = $$<HTMLButtonElement>("#tabs button").find((b) => b.dataset.p === page); if (cur) $("#menuCur").textContent = cur.textContent!;
  if (page === "chat") setTimeout(() => $<HTMLInputElement>("#chatIn")?.focus(), 50);
  
  window.scrollTo({ top: 0 });
}
$$<HTMLButtonElement>("#tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.p!)));
$("#menuBtn").addEventListener("click", (e) => { e.stopPropagation(); document.body.classList.toggle("menu"); });
document.addEventListener("click", (e) => { if (document.body.classList.contains("menu") && !(e.target as HTMLElement).closest("#tabs")) document.body.classList.remove("menu"); });
Object.assign(window, { go, caption: (n: string, t: string) => { const c = $("#caption"); c.style.display = t ? "flex" : "none"; $("#capN").textContent = n; $("#capT").textContent = t; } });

// =====================================================================
// LIVE DESK: the queue an EA or the concierge team actually watches
// =====================================================================
const STAGES = ["Understand", "Shortlist", "Email venues", "Compare", "Approval", "Confirmed"];
const PIN: Record<string, string> = { cand: "#5b6b8c", mail: "#c98a12", offer: "#3f7d5a", decl: "#b9ad9f", inj: "#c2455d", win: "#7b1e3a" };
interface DeskRow { venueId: string; name: string; state: "cand" | "mail" | "offer" | "decl" | "inj" | "win"; room: string; min: string; perHead: string; note: string; ai: boolean }
interface DeskReq { s: (typeof SCENARIOS)[number]; status: string; tone: string; stage: number; acts: TraceEvent[]; rows: Map<string, DeskRow>; parsed: Record<string, unknown> | null; ai: number; done: boolean; t0: number; need: boolean; needLeft: number; needText: string; decide?: (d: "approve" | "reject") => void; world?: VenueWorld; runId?: string }
const DESK = ["p01", "p04", "v03", "p05", "c04", "p08", "p12", "reg06"].map(scen);
let actsShown = { sel: -1, n: 0 };
let desk: DeskReq[] = [], sel = 0, deskGen = 0, deskSpeed = 2, deskPaused = false;
const dsleep = async (ms: number) => { const end = Date.now() + ms / deskSpeed; while (Date.now() < end || deskPaused) await sleep(40); };

async function learned(id: string) {
  const out = { cap: new Map<string, number>(), replies: [] as number[], declines: 0, silences: 0, inj: 0 };
  for (const s of stores) for (const f of await s.facts(id)) {
    if (f.kind === "room_capacity" && f.roomId) out.cap.set(f.roomId, Number(f.value));
    if (f.kind === "reply_hours") out.replies.push(Number(f.value));
    if (f.kind === "declined") out.declines++; if (f.kind === "no_reply") out.silences++; if (f.kind === "injection_attempt") out.inj++;
  }
  return out;
}

function mapSvg() {
  const B: Record<string, [number, number, number, number]> = { Midtown: [60, 10, 160, 58], Chelsea: [20, 76, 92, 56], Flatiron: [120, 76, 100, 56], "West Village": [20, 140, 92, 56], SoHo: [120, 140, 100, 56], Tribeca: [20, 204, 92, 56], "Financial District": [120, 204, 100, 70], Williamsburg: [262, 110, 74, 96] };
  let s = `<rect x="232" y="0" width="22" height="290" fill="#e4ecf2"/>`;
  for (const [h, [x, y, w, hh]] of Object.entries(B)) s += `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="8" fill="#f3eee6" stroke="#e6dccd"/><text x="${x + 7}" y="${y + 14}" font-family="Inter" font-size="8.5" font-weight="700" fill="#a39380" letter-spacing=".06em">${(h === "Financial District" ? "FIDI" : h === "Williamsburg" ? "BROOKLYN" : h).toUpperCase()}</text>`;
  const per: Record<string, number> = {};
  for (const v of venues) {
    const [x, y, w] = B[v.neighborhood], k = per[v.neighborhood] = (per[v.neighborhood] ?? 0) + 1;
    s += `<circle class="pin" id="pin_${v.id}" data-v="${v.id}" cx="${x + 14 + ((k - 1) * 21) % (w - 22)}" cy="${y + 30 + Math.floor(((k - 1) * 21) / (w - 22)) * 16}" r="5.5" fill="#d8cdbd" stroke="#fff" stroke-width="2"><title>${esc(v.name)}</title></circle>`;
  }
  $("#map").innerHTML = s;
  $$<SVGCircleElement>("#map .pin").forEach((p) => p.addEventListener("click", () => void venueCard(p.dataset.v!)));
}
function paintPins(r: DeskReq | undefined) {
  $$<SVGCircleElement>("#map .pin").forEach((p) => { const row = r?.rows.get(p.dataset.v!); p.setAttribute("fill", row ? PIN[row.state] : "#d8cdbd"); p.setAttribute("r", row?.state === "win" ? "8" : row ? "6.5" : "5"); p.classList.toggle("ring", row?.state === "win"); });
}
async function venueCard(id: string) {
  const v = venues.find((x) => x.id === id)!, L = await learned(id);
  $("#vcard").innerHTML = `<div class="vt">${esc(v.name)}</div><div class="vs">${esc(v.neighborhood)} · ${esc(v.cuisine)} · ${usd(v.perHeadCents)} a head</div>
    <div>${v.preferredRatePct ? `<span class="pill y">Preferred −${v.preferredRatePct}%</span>` : ""}${company.policy.blockedVenueIds.includes(v.id) ? `<span class="pill r">Blocked</span>` : `<span class="pill g">In-Policy</span>`}${v.contractRequired ? `<span class="pill">Contract</span>` : ""}${L.inj ? `<span class="pill r">Injection seen</span>` : ""}</div>
    <dl class="kv">${v.rooms.map((r) => `<dt>${esc(r.name)}</dt><dd>${L.cap.has(r.id) ? `<s>${r.listedCapacity}</s> → ${L.cap.get(r.id)} seats <span class="pill y">learned</span>` : `${r.listedCapacity} seats`}</dd>`).join("")}<dt>Deposit</dt><dd>${v.depositPct}%</dd><dt>Typical reply</dt><dd>${L.replies.length ? `${L.replies.at(-1)} h` : "—"}</dd></dl>`;
}
const COLS: [string, string][] = [["Understanding", "run0"], ["Sourcing", "run1"], ["Waiting on venues", "run2"], ["Comparing", "run3"], ["Needs you", "need"], ["Confirmed", "ok"]];
const colOf = (r: DeskReq) => r.done ? (r.tone === "ok" ? 5 : 6) : r.need ? 4 : Math.min(r.stage, 3);
const VPIP: Record<string, string> = { cand: "#cfc3b3", mail: "#c98a12", offer: "#3f7d5a", decl: "#bfb2a2", inj: "#c2455d", win: "#7b1e3a" };
function cardHtml(r: DeskReq, i: number) {
  const p = r.parsed as { partySize?: number; date?: string; privateRoom?: boolean; clientName?: string | null } | null;
  const d = p?.date ? `${DAYS[weekday(p.date)]} ${Number(p.date.slice(8))}` : "";
  const pips = [...r.rows.values()].map((o) => `<i style="background:${VPIP[o.state]}" title="${esc(o.name)}: ${esc(o.note)}"></i>`).join("");
  const el2 = Math.max(0, Math.round((Date.now() - r.t0) / 1000));
  return `<div class="kc ${i === sel && dOpen ? "on" : ""} ${r.need ? "need" : ""} ${r.tone === "bad" ? "bad" : ""}" data-i="${i}" title="${esc(r.s.text)}">
    <div class="kh"><span class="kav">${esc((p?.clientName ?? "TM").slice(0, 2).toUpperCase())}</span><div><b>${p ? `${p.partySize ?? "?"} guests${p.privateRoom ? " 🔒" : ""}` : "New request"}</b><span>${p ? `${esc(p.clientName ?? "Team")} · ${d}` : esc(r.s.text.slice(0, 34)) + "…"}</span></div>${r.ai ? `<em class="kai" title="Claude decisions">✳${r.ai}</em>` : ""}</div>
    ${pips ? `<div class="kp">${pips}</div>` : ""}
    ${r.need ? `<div class="kact"><button class="btn pri" data-ok="${i}">Approve</button><button class="btn" data-no="${i}">Decline</button><span class="kring" style="--t:${r.needLeft}"><b>${r.needLeft}</b></span></div><div class="kwin">${esc(r.needText)}</div>` : ""}
    <div class="kf"><span>${r.done ? (r.tone === "ok" ? "✓ booked" : esc(r.status)) : `<span class="live"></span>${esc(r.status)}`}</span><span class="kt" data-t0="${r.t0}">${el2 < 60 ? `${el2}s` : `${Math.floor(el2 / 60)}m`}</span></div></div>`;
}
function renderQueue() {
  const cols = [...COLS, ["Needs attention", "bad"] as [string, string]];
  const by = cols.map(() => [] as number[]); desk.forEach((r, i) => by[colOf(r)].push(i));
  const board = $("#board"), first = new Map<string, DOMRect>(); board.querySelectorAll<HTMLElement>(".kc").forEach((c) => first.set(c.dataset.i!, c.getBoundingClientRect()));
  board.innerHTML = cols.map(([name, cls], c) => (c === 6 && !by[6].length) ? "" : `<div class="kcol ${cls}"><div class="kch"><span>${name}</span><b>${by[c].length}</b></div><div class="kcards">${by[c].slice(c === 5 ? -6 : 0).reverse().map((i) => cardHtml(desk[i], i)).join("") || '<div class="kempty"></div>'}</div></div>`).join("");
  // FLIP: cards glide to their new column instead of jumping.
  board.querySelectorAll<HTMLElement>(".kc").forEach((c) => { const f = first.get(c.dataset.i!); if (!f) { c.classList.add("enter"); return; } const l = c.getBoundingClientRect(), dx = f.left - l.left, dy = f.top - l.top; if (dx || dy) { c.style.transform = `translate(${dx}px,${dy}px)`; c.style.transition = "none"; requestAnimationFrame(() => { c.style.transition = "transform .55s cubic-bezier(.2,.8,.2,1)"; c.style.transform = ""; }); } });
  board.querySelectorAll<HTMLElement>(".kc").forEach((c) => c.onclick = (e) => { if ((e.target as HTMLElement).closest("button")) return; sel = Number(c.dataset.i); dOpen = true; $("#dDrawer").classList.add("on"); actsShown = { sel: -1, n: 0 }; renderQueue(); renderDetail(); });
  board.querySelectorAll<HTMLButtonElement>("[data-ok]").forEach((b) => b.onclick = () => desk[Number(b.dataset.ok)].decide?.("approve"));
  board.querySelectorAll<HTMLButtonElement>("[data-no]").forEach((b) => b.onclick = () => desk[Number(b.dataset.no)].decide?.("reject"));
  $("#dLive").textContent = String(desk.filter((r) => !r.done).length);
}
let dOpen = false;
setInterval(() => $$<HTMLElement>(".kt").forEach((t) => { const s2 = Math.round((Date.now() - Number(t.dataset.t0)) / 1000); t.textContent = s2 < 60 ? `${s2}s` : `${Math.floor(s2 / 60)}m`; }), 1000);
const ICON: Record<string, string> = { concierge: "✦", sourcing: "⌕", coordination: "✉", comparison: "⚖" };
function renderDetail() {
  const r = desk[sel]; if (!r) return;
  $("#dReq").textContent = `“${r.s.text}”`;
  const p = r.parsed as { partySize?: number; date?: string; time?: string; privateRoom?: boolean; clientName?: string | null; cuisine?: string | null } | null;
  $("#dMeta").innerHTML = p ? [`${p.partySize} guests`, p.date, p.time, p.privateRoom ? "Private" : null, p.clientName ? `with ${p.clientName}` : null, p.cuisine].filter(Boolean).map((x) => `<span class="pill">${esc(String(x))}</span>`).join("") + (r.acts.find((e) => e.kind === "parsed" && isAI(e)) ? `<span class="ai">PARSED</span>` : "") : `<span class="pill">Queued</span>`;
  $("#stages").innerHTML = STAGES.map((s, i) => `<div class="sg ${r.done && r.tone === "ok" ? "done" : i < r.stage ? "done" : i === r.stage && !r.done ? "on" : ""} ${r.done && r.tone !== "ok" && i === r.stage ? "stop" : ""}"><i>${i < r.stage || (r.done && r.tone === "ok") ? "✓" : i + 1}</i><span>${s}</span></div>`).join("");
  $("#offers").innerHTML = r.rows.size ? `<table><thead><tr><th>Venue</th><th>Room</th><th>Minimum</th><th>All-in / head</th><th>Status</th></tr></thead><tbody>${[...r.rows.values()].map((o) =>
    `<tr class="${o.state === "win" ? "win" : ""}"><td><b>${esc(o.name)}</b></td><td>${esc(o.room)}</td><td>${o.min}</td><td>${o.perHead}</td><td><span class="st ${({ win: "ok", offer: "ok", inj: "bad", decl: "mute", mail: "warn", cand: "mute" } as Record<string, string>)[o.state]}">${esc(o.note)}</span>${o.ai ? '<span class="ai"></span>' : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Offers appear as venues reply.</div>`;
  const shown = r.acts.filter((e) => !e.kind.startsWith("to_booker") || /Reply approve/.test(e.text));
  const li = (e: TraceEvent) => `<li class="${e.kind === "injection_flagged" ? "bad" : e.kind === "booked" ? "good" : ""}"><span class="ic ${AGENT[e.agent] ?? "c"}">${ICON[e.agent] ?? "✦"}</span><div><div class="at">${esc(e.kind.startsWith("to_booker") ? "Proposal sent to Priya's phone" : e.kind === "proposed" ? "Waiting for approval" : e.text.replace(/ \((model|rules)(, [\d.]+)?\)$/, ""))}${isAI(e) ? '<span class="ai"></span>' : ""}</div><div class="tm">${e.agent} · ${when(e.at)}</div></div></li>`;
  // Append only what's new, so the feed doesn't re-animate on every update.
  if (actsShown.sel === sel && shown.length >= actsShown.n) { $("#acts").insertAdjacentHTML("beforeend", shown.slice(actsShown.n).map(li).join("")); }
  else { $("#acts").innerHTML = shown.map(li).join(""); $("#acts").classList.add("still"); requestAnimationFrame(() => $("#acts").classList.remove("still")); }
  actsShown = { sel, n: shown.length };
  $("#acts").scrollTop = $("#acts").scrollHeight;
  paintPins(r);
}
function apply(r: DeskReq, e: TraceEvent) {
  r.acts.push(e); if (isAI(e)) r.ai++;
  const v = venues.find((x) => e.text.startsWith(x.name)), row = (id: string) => r.rows.get(id);
  const set = (st: string, tone: string, stage = r.stage) => { r.status = st; r.tone = tone; r.stage = stage; };
  if (e.kind === "parsed") { r.parsed = (e.data?.request as Record<string, unknown>) ?? null; set("Understanding", "run", 0); }
  if (e.kind === "sourced") { set("Shortlisting", "run", 1); for (const t of (e.data?.top ?? []) as { venueId: string; venue: string; perHead: number }[]) if (!r.rows.has(t.venueId)) r.rows.set(t.venueId, { venueId: t.venueId, name: t.venue, state: "cand", room: "—", min: "—", perHead: usd(t.perHead), note: "Shortlisted", ai: false }); }
  if (e.kind === "inquiries_sent") { set("Emailing venues", "run", 2); for (const o of r.rows.values()) if (e.text.includes(o.name)) { o.state = "mail"; o.note = "Awaiting reply"; } for (const [id, o] of r.rows) if (o.state === "cand") r.rows.delete(id); }
  if (e.kind === "followed_up" && v && row(v.id)) row(v.id)!.note = "Followed up";
  if (e.kind === "reply" && v && row(v.id)) { const l = /: (\w+)/.exec(e.text)?.[1]; const o = row(v.id)!; if (o.state !== "inj") { o.state = l === "decline" || l === "counter" ? "decl" : l === "offer" ? "offer" : "mail"; o.note = l === "decline" ? "Declined" : l === "counter" ? "Counter: not a fit" : l === "offer" ? "Offered" : l === "question" ? "Asked a question" : l === "auto_reply" ? "Out of office" : o.note; } }
  if (e.kind === "injection_flagged" && v && row(v.id)) { row(v.id)!.state = "inj"; row(v.id)!.note = "Injection ignored"; }
  if (e.kind === "gave_up" && v && row(v.id)) { row(v.id)!.state = "decl"; row(v.id)!.note = "No reply"; }
  if (e.kind === "offer" && v && row(v.id)) { const o = e.data?.offer as { roomName: string | null; minSpendCents: number | null } | undefined; const x = row(v.id)!; x.room = o?.roomName ?? "—"; x.min = o?.minSpendCents ? usd(o.minSpendCents) : "—"; x.ai = isAI(e); }
  if (e.kind === "compared") { set("Comparing offers", "run", 3); for (const o of r.rows.values()) if (o.state === "mail") { o.state = "decl"; o.note = "No reply in time"; } for (const u of (e.data?.usable ?? []) as { venue: string; perHeadAllIn: number }[]) { const o = [...r.rows.values()].find((x) => x.name === u.venue); if (o) { o.perHead = usd(u.perHeadAllIn * 100); if (o.state !== "inj") o.note = "In policy"; } } for (const j of (e.data?.rejected ?? []) as { venue: string; why: string }[]) { const o = [...r.rows.values()].find((x) => x.name === j.venue); if (o && o.state === "offer") { o.state = "decl"; o.note = j.why.length > 34 ? `${j.why.slice(0, 32)}…` : j.why; } } }
  if (e.kind === "replan") { set("Widening the search", "warn", 1); }
  if (e.kind === "proposed") { set("Awaiting approval", "warn", 4); const name = e.text.split(",")[0]; const o = [...r.rows.values()].find((x) => x.name === name); if (o) o.note = "Proposed"; }
  if (e.kind === "booked") { set("Confirmed", "ok", 5); r.done = true; const o = [...r.rows.values()].find((x) => e.text.includes(x.name)); if (o) { o.note = o.state === "inj" ? "Booked · bank details ignored" : "Booked"; o.state = "win"; } }
  if (e.kind === "clarify") { set("Needs the booker", "warn", 1); r.done = true; }
  if (e.kind === "rejected") { set("Rejected by booker", "bad"); r.done = true; }
}
async function deskRun(i: number, g: number) {
  const r = desk[i], s = r.s, seen = new Map<string, Behavior>(), order = s.order ?? [];
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11 + i);
  const store = new MemoryStore(); await store.init(venues); stores.push(store); r.world = world;
  let chain: Promise<void> = Promise.resolve();
  const show = (e: TraceEvent) => { chain = chain.then(async () => { if (g !== deskGen) return; apply(r, e); $("#dClock").textContent = when(e.at); renderQueue(); if (sel === i && dOpen) renderDetail(); await dsleep(["reply", "offer", "injection_flagged"].includes(e.kind) ? 700 : 1000); }); };
  const res = await runConcierge({ text: s.text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, company, onEvent: (e) => { if (!e.kind.startsWith("to_booker")) show(e); },
    approver: async (p, st) => {
      await chain; if (g !== deskGen) return "pending";
      if (p.kind === "pay_deposit") return carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, st);
      const v = venues.find((x) => x.id === p.venueId)!;
      r.need = true; r.needLeft = 10; r.needText = `${v.name} · ${usd(p.amountCents)}`; r.status = "Needs you";
      const d = await new Promise<"approve" | "reject">((res2) => { r.decide = res2; const t = setInterval(() => { if (deskPaused) return; r.needLeft--; renderQueue(); if (r.needLeft <= 0) { clearInterval(t); res2("approve"); } }, 1000 / Math.min(deskSpeed, 2)); renderQueue(); });
      r.need = false; r.decide = undefined;
      if (d === "reject") { for (const role of p.requiredRoles) await st.decide(p.id, approverFor(role, priya).id, role, "reject"); return "rejected"; }
      return carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, st);
    } });
  r.runId = res.runId; await chain;
  if (!r.done) { r.done = true; r.status = res.outcome === "booked" ? "Confirmed" : res.outcome === "escalated" ? "Escalated" : res.outcome === "rejected_by_booker" ? "Declined" : res.outcome.replace(/_/g, " "); r.tone = res.outcome === "booked" ? "ok" : "bad"; }
  if (res.outcome === "booked" && $("#p-desk.on")) toast("Booked", r.needText || "Live desk");
  record(res, world); renderQueue(); if (sel === i && dOpen) renderDetail();
}
const MORE = ["dinner for 6 with the Globex team on Nov 18 at 7:30pm", "private dinner for 16 with Initech next Wednesday", "team dinner for 10 this Friday under $110 a head", "client dinner for 4 with Acme tomorrow in Tribeca"];
async function deskLoop() {
  const g = ++deskGen; let n = 0;
  const pool = [...DESK, ...MORE.map((text, k) => ({ id: `live${k}`, group: "phrasing" as const, text, expect: { outcome: "booked" as const } }))];
  desk = []; sel = 0; dOpen = false; $("#dDrawer").classList.remove("on"); renderQueue();
  // A steady stream: a new request every few seconds, at most three in flight, like a real desk on a Monday.
  while (g === deskGen) {
    if (desk.filter((r) => !r.done).length < 3 && !deskPaused) {
      const s = pool[n % pool.length]; n++;
      desk.push({ s: s as (typeof SCENARIOS)[number], status: "New", tone: "mute", stage: 0, acts: [], rows: new Map(), parsed: null, ai: 0, done: false, t0: Date.now(), need: false, needLeft: 0, needText: "" });
      renderQueue(); void deskRun(desk.length - 1, g);
      if (desk.length > 40) { /* keep memory bounded on a long-open tab */ }
    }
    await dsleep(4200);
  }
}
$("#dPause").onclick = () => { deskPaused = !deskPaused; $("#dPause").textContent = deskPaused ? "Resume" : "Pause"; };
$("#dReplay").onclick = () => { deskPaused = false; $("#dPause").textContent = "Pause"; void deskLoop(); };
$$<HTMLButtonElement>("#dSpeed button").forEach((b) => b.onclick = () => { $$("#dSpeed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); deskSpeed = Number(b.dataset.s); });
$("#dMail").onclick = () => { const r = desk[sel]; if (r?.world) showThreads(r.world, `“${r.s.text}”`); };
$("#dClose").onclick = () => { dOpen = false; $("#dDrawer").classList.remove("on"); renderQueue(); };
mapSvg();
function resize() { /* the desk is responsive CSS; nothing to measure */ }

// =====================================================================
// BOOK
// =====================================================================
const PRESET: Record<string, string> = { normal: "p01", injection: "v03", silent: "v02", declines: "r01", big: "c04" };
let preset = "normal", bspeed = 2, running = false, bookStore: MemoryStore | null = null, bookWorld: VenueWorld;
const COURSE = ["parse", "source", "email", "compare", "approve", "book"];
const STEP: Record<string, string> = { parsed: "parse", sourced: "source", inquiries_sent: "email", reply: "email", compared: "compare", proposed: "approve", booked: "book" };
$$<HTMLButtonElement>("#presets .chip").forEach((b) => b.onclick = () => { $$("#presets .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); preset = b.dataset.p!; $<HTMLInputElement>("#ask").value = scen(PRESET[preset]).text; });
$$<HTMLButtonElement>("#bSpeed button").forEach((b) => b.onclick = () => { $$("#bSpeed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); bspeed = Number(b.dataset.s); });
$<HTMLFormElement>("#go").addEventListener("submit", (e) => { e.preventDefault(); if (!running) void book(); });

const queue: (() => void | Promise<void>)[] = [];
let pumping: Promise<void> | null = null;
const enqueue = (fn: () => void | Promise<void>) => { queue.push(fn); pumping ??= (async () => { while (queue.length) { await queue.shift()!(); await sleep(560 / bspeed); } pumping = null; })(); };
const drained = async () => { while (pumping) await pumping; };
const course = (k: string) => { const i = COURSE.indexOf(k); $$<HTMLElement>("#course span").forEach((s) => { const j = COURSE.indexOf(s.dataset.k!); s.classList.toggle("on", j === i); s.classList.toggle("done", j < i); }); };

function addEvent(e: TraceEvent) {
  if (e.kind.startsWith("to_booker")) { if (!/Reply approve or reject/.test(e.text)) enqueue(() => bubble(e.text, e.kind.endsWith("sms") ? "SMS" : "EMAIL")); else enqueue(() => bubble(e.text.replace(/ Reply approve or reject\.$/, ""), "PROPOSAL")); return; }
  enqueue(() => {
    if (STEP[e.kind]) course(STEP[e.kind]);
    $("#events").append(el("li", `ev ${AGENT[e.agent] ?? ""}${e.kind === "injection_flagged" ? " bad" : ""}${e.kind === "booked" ? " good" : ""}`,
      `<span class="tm">${when(e.at)}</span><span><span class="who">${e.agent}${isAI(e) ? '<span class="ai">CLAUDE</span>' : ""}</span><span class="what">${esc(e.kind === "proposed" ? "Proposal sent to your phone." : e.text.replace(/ \((model|rules)(, [\d.]+)?\)$/, ""))}</span></span>`));
    $("#evbox").scrollTop = $("#evbox").scrollHeight;
    if (e.kind === "sourced") cards(e);
    if (["reply", "offer", "injection_flagged", "gave_up"].includes(e.kind)) flip(e);
    inbox();
  });
}
function cards(e: TraceEvent) {
  $("#e0").style.display = "none";
  const top = (e.data?.top ?? []) as { venue: string; venueId: string; score: number; parts: Record<string, number>; perHead: number; preferredRatePct: number; neighborhood: string }[];
  $("#short").innerHTML = top.slice(0, 5).map((c) => `<div class="vc" data-v="${c.venueId}"><div class="vci"><div class="face"><div class="h"><b>${esc(c.venue)}</b><span class="score">${c.score}</span></div>
    <div><span class="pill g">In-Policy</span>${c.preferredRatePct ? `<span class="pill y">−${c.preferredRatePct}%</span>` : ""}<span class="pill">${usd(c.perHead)}/head</span><span class="pill">${esc(c.neighborhood)}</span></div>
    <div class="bars">${Object.entries(c.parts).filter(([, v]) => v).map(([k, v]) => `<i class="${v < 0 ? "neg" : ""}" style="flex:${Math.abs(v)}" title="${k} ${v > 0 ? "+" : ""}${v}"></i>`).join("")}</div></div>
    <div class="face back wait"><div class="h"><b>${esc(c.venue)}</b></div><div class="st">Waiting…</div></div></div></div>`).join("");
}
function flip(e: TraceEvent) {
  const v = venues.find((x) => e.text.startsWith(x.name)); if (!v) return;
  const card = $(`.vc[data-v="${v.id}"]`); if (!card) return;
  const back = card.querySelector<HTMLElement>(".back")!, label = /: (\w+)/.exec(e.text)?.[1];
  if (e.kind === "injection_flagged") { back.className = "face back inj"; back.querySelector(".st")!.innerHTML = `<span class="pill r">Injection ignored</span><div style="font-size:12px;color:var(--rose)">Bank details in the email: never used.</div>`; }
  else if (e.kind === "gave_up") { back.className = "face back decl"; back.querySelector(".st")!.innerHTML = `<span class="pill">Never replied</span>`; }
  else if (e.kind === "offer") { const o = e.data?.offer as { roomName: string; minSpendCents: number; depositPct: number } | undefined; if (!back.classList.contains("inj")) back.className = "face back offer"; back.querySelector(".st")!.innerHTML += `<div style="font-size:12.5px;margin-top:4px"><b style="font:700 13px Inter">${esc(o?.roomName ?? "")}</b> · min ${o?.minSpendCents ? usd(o.minSpendCents) : "-"} · ${o?.depositPct ?? 0}% deposit${isAI(e) ? '<span class="ai">CLAUDE</span>' : ""}</div>`; }
  else if (label && !back.classList.contains("inj")) { back.className = `face back ${label === "decline" || label === "counter" ? "decl" : label === "offer" ? "offer" : "wait"}`; back.querySelector(".st")!.innerHTML = `<span class="pill ${label === "offer" ? "g" : label === "decline" ? "r" : "y"}">${label === "counter" ? "Counter offer" : label === "offer" ? "Yes" : label === "decline" ? "No" : label.replace("_", " ")}</span>`; }
  card.classList.add("flip");
}
function statusOf(msgs: Message[]) {
  const l = msgs.filter((m) => m.direction === "in").at(-1); if (!l) return msgs.length > 1 ? "followed up" : "waiting";
  return /SYSTEM NOTE/.test(l.body) ? "injection" : /instead|semi-private/i.test(l.body) ? "counter" : /unfortunately|no availability|not able/i.test(l.body) ? "declined" : /out of the office/i.test(l.body) ? "auto-reply" : /could you confirm/i.test(l.body) ? "question" : "offer";
}
function inbox() {
  const th = new Map<string, Message[]>();
  for (const m of [...bookWorld.sent(), ...bookWorld.received()].sort((a, b) => a.at.localeCompare(b.at))) { if (!th.has(m.venueId)) th.set(m.venueId, []); th.get(m.venueId)!.push(m); }
  const open = new Set($$<HTMLElement>("#inbox details[open]").map((d) => d.dataset.v)); $("#inbox").innerHTML = "";
  for (const [vid, msgs] of th) {
    const v = venues.find((x) => x.id === vid)!, st = statusOf(msgs), pc = ({ offer: "g", declined: "r", injection: "r", counter: "y", question: "y", "followed up": "y" } as Record<string, string>)[st] ?? "";
    const d = el("details", `th ${st === "injection" ? "inj" : ""}`) as HTMLDetailsElement; d.dataset.v = vid; if (open.has(vid)) d.open = true;
    d.innerHTML = `<summary><b>${esc(v.name)}</b><span class="pill ${pc}">${st}</span><span style="color:var(--dim);font-size:12px">${msgs.length} ✉</span></summary>` + msgs.map((m) =>
      `<div class="mail ${m.direction}"><div class="mh">${m.direction === "out" ? "CONCIERGE →" : "← VENUE"} · ${when(m.at)}</div><pre>${esc(m.body).replace(/(\[SYSTEM NOTE:[^\]]*\])/s, "<mark>$1</mark>").replace(/(\$[\d,]+)/g, "<u>$1</u>")}</pre></div>`).join("");
    $("#inbox").append(d);
  }
  $("#e3").style.display = th.size ? "none" : "";
}
function bubble(text: string, ch: string) {
  $("#e2").style.display = "none";
  const b = el("div", "bubble", `<span class="ch">${ch}</span>${esc(text).replace(/(instructions to change payment details[^.]*\.)/, "<mark>$1</mark>")}`);
  $("#phone").append(b); $("#phonebox").scrollTop = $("#phonebox").scrollHeight;
}
function slider(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = el("div", "slide", `<div class="fill"></div><div class="lbl">${esc(label)} ›››</div><div class="knob">✓</div>`);
    const rej = el("button", "reject", "Reject instead");
    $("#phone").append(s, rej); $("#phonebox").scrollTop = $("#phonebox").scrollHeight;
    const knob = s.querySelector<HTMLElement>(".knob")!, fill = s.querySelector<HTMLElement>(".fill")!;
    let dragging = false, startX = 0, x = 0; const max = () => s.clientWidth - 52;
    const set = (v: number) => { x = Math.max(0, Math.min(max(), v)); knob.style.left = `${4 + x}px`; fill.style.width = `${56 + x}px`; };
    const done = () => { s.classList.add("done"); s.querySelector(".lbl")!.textContent = "Approved ✓"; rej.remove(); resolve(true); };
    knob.addEventListener("pointerdown", (e) => { dragging = true; startX = e.clientX - x; knob.setPointerCapture(e.pointerId); });
    knob.addEventListener("pointermove", (e) => { if (dragging) set(e.clientX - startX); });
    knob.addEventListener("pointerup", () => { dragging = false; if (x > max() * 0.85) { set(max()); done(); } else set(0); });
    s.addEventListener("click", (e) => { if (e.target !== knob && !s.classList.contains("done")) { set(max()); setTimeout(done, 150); } });
    rej.onclick = () => { s.remove(); rej.remove(); resolve(false); };
  });
}
const tap: Approver = async (p, store) => {
  await drained();
  const cur = (await store.getProposal(p.id))!; if (cur.status !== "pending") return cur.status === "approved" ? "approved" : "rejected";
  const all = [cur];
  for (const st of await store.steps(p.runId)) for (const id of (st.kind === "proposed" ? (st.detail.proposals as string[]) : []) ?? []) { const o = await store.getProposal(id); if (o && o.id !== cur.id && o.status === "pending") all.push(o); }
  course("approve");
  const chips = el("div", "rolechips", cur.requiredRoles.map((r) => `<span class="rc" data-r="${r}">${approverFor(r, priya).name.split(" ")[0]} · ${r}</span>`).join("")); $("#phone").append(chips);
  for (const role of cur.requiredRoles) {
    const ok = await slider(`Slide to approve as ${approverFor(role, priya).name.split(" ")[0]}`);
    for (const x of all) await store.decide(x.id, approverFor(role, priya).id, role, ok ? "approve" : "reject");
    if (!ok) return "rejected";
    chips.querySelector(`[data-r="${role}"]`)!.classList.add("ok");
  }
  return "approved";
};
function seating(n: number) {
  const W2 = 260, H2 = 120, seats: string[] = [];
  const perSide = Math.ceil((n - 2) / 2);
  for (let i = 0; i < n; i++) {
    let x: number, y: number;
    if (i === 0) { x = 26; y = H2 / 2; } else if (i === 1) { x = W2 - 26; y = H2 / 2; }
    else { const k = i - 2, side = k % 2, j = Math.floor(k / 2); x = 56 + (j + 0.5) * ((W2 - 112) / perSide); y = side ? H2 - 16 : 16; }
    seats.push(`<circle cx="${x}" cy="${y}" r="9" fill="#e6d9c4"><animate attributeName="fill" to="#7b1e3a" begin="${0.25 + i * 0.09}s" dur=".2s" fill="freeze"/></circle>`);
  }
  return `<svg width="${W2}" height="${H2}"><rect x="44" y="34" width="${W2 - 88}" height="${H2 - 68}" rx="26" fill="#b8862b33" stroke="#b8862b"/>${seats.join("")}</svg>`;
}
async function book() {
  running = true; $("#go button").setAttribute("disabled", "");
  for (const id of ["#events", "#inbox", "#phone", "#short"]) $(id).innerHTML = "";
  for (const id of ["#e1", "#e2", "#e3"]) $(id).style.display = "none";
  $$("#course span").forEach((s) => s.classList.remove("on", "done"));
  const s = scen(PRESET[preset]), seen = new Map<string, Behavior>(), order = s.order ?? [];
  bookWorld = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  bookStore = new MemoryStore(); await bookStore.init(venues); stores.push(bookStore); srcOf.set(bookStore, "Book");
  const res = await runConcierge({ text: $<HTMLInputElement>("#ask").value, actor: priya, principal: dana, today: "2026-11-09", store: bookStore, world: bookWorld, llm, venues, company, approver: tap, onEvent: addEvent });
  await drained(); record(res, bookWorld);
  const v = res.chosenVenueId ? venues.find((x) => x.id === res.chosenVenueId) : null, bk = res.proposals.find((p) => p.kind === "book");
  const pay = res.paymentId ? bookStore.allPayments().find((x) => x.id === res.paymentId) : null;
  if (res.outcome === "booked" && v && bk) {
    course("book");
    const room = v.rooms.find((r) => r.id === bk.roomId)!;
    $("#phone").append(el("div", "ticket", `<div class="tt">${esc(v.name)}</div><div class="ts">${esc(room.name)} · ${when(bk.startsAt).replace(/ \d+ (am|pm)/, "")} ${localDate(bk.startsAt).slice(5)} · ${bk.partySize} guests</div><hr>${seating(bk.partySize)}
      <div class="ts" style="margin-top:6px">${usd(bk.amountCents)} all-in${pay ? ` · deposit ${usd(pay.amountCents)} → ${esc(pay.payeeId)}` : ""}</div><button class="btn pri" style="margin-top:10px;width:100%" onclick="go('seating')">Arrange seating →</button>`));
    setLastBooking({ venue: v, roomName: room.name, partySize: bk.partySize, date: localDate(bk.startsAt), dietary: res.request?.dietary ?? [], client: res.request?.clientName ?? "Guests", world: bookWorld, threadId: `thr_${res.runId}_${v.id}` });
    toast("Booked", `${v.name} · ${room.name} · ${bk.partySize} guests`);
  } else $("#phone").append(el("div", "ticket fail", `<div class="tt">${res.outcome.replace(/_/g, " ")}</div><div class="ts" style="color:#ffd5dc">Nothing was booked or paid.</div>`));
  $("#phonebox").scrollTop = $("#phonebox").scrollHeight;
  running = false; $("#go button").removeAttribute("disabled");
}

// =====================================================================
// INBOX LAB
// =====================================================================
const labVenue = venues[1], meta = { date: "2026-11-12", time: "19:00", partySize: 12, privateRoom: true };
function template(t: string) {
  if (t === "auto") return "Thank you for your email. I am currently out of the office with limited access to email and will respond when I return.\n\nEvents Team";
  const w = new VenueWorld(venues, () => t as Behavior, "2026-11-09T15:00:00.000Z", 5);
  w.send(labVenue.id, "lab", "Inquiry", "Hello, inquiry for 12 guests", "inquiry", meta);
  return w.advance(12)[0]?.body ?? "";
}
const FIELD_COLOR: Record<string, string> = { room: "#d9ecdf", cap: "#dbe5f6", money: "#f7e3b6", dep: "#efdcf3", hold: "#e6e0d3", date: "#fbe0cf", inj: "#f9c9d2" };
function spans(text: string) {
  const rx: [string, RegExp][] = [["inj", /\[SYSTEM NOTE:[^\]]*\]?|(?:routing|account)\s*(?:number|no\.?)?\s*\d{6,}/gi], ["money", /\$[\d,]+(?:\.\d{2})?/g],
    ["room", new RegExp(labVenue.rooms.map((r) => r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")], ["cap", /(?:only seats|seats|fits|holds|accommodates|up to)\s+(?:up to\s+)?\d{1,3}/gi],
    ["dep", /\d{1,3}%\s*deposit|no deposit/gi], ["hold", /hold (?:it|the room|this|the date)?\s*for \d{1,3} hours/gi], ["date", /(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/g]];
  const marks: [number, number, string][] = [];
  for (const [k, re] of rx) for (const m of text.matchAll(re)) if (!marks.some(([s, e]) => m.index! < e && m.index! + m[0].length > s)) marks.push([m.index!, m.index! + m[0].length, k]);
  marks.sort((a, b) => a[0] - b[0]); let out = "", i = 0;
  for (const [s, e, k] of marks) { out += esc(text.slice(i, s)) + `<span class="f-${k}" data-f="${k}">${esc(text.slice(s, e))}</span>`; i = e; }
  return out + esc(text.slice(i)) + "\n";
}
const triager = replyTriage(llm), detector = injection(llm);
async function analyze() {
  const body = $<HTMLTextAreaElement>("#mail").value; $("#hlv").innerHTML = spans(body);
  const [tri, inj] = await Promise.all([triager.classify(body), detector.classify(body)]);
  const o = extractRules(body, labVenue, "lab", "2026-11-09", tri.label === "offer" || tri.label === "counter");
  $("#tri").textContent = tri.label.replace("_", " ");
  $<HTMLElement>("#garc").setAttribute("stroke-dashoffset", String(188.5 * (1 - tri.confidence))); $("#gpct").textContent = `${Math.round(tri.confidence * 100)}%`;
  const ip = $("#injpill"); ip.className = `pill ${inj.label === "injection" ? "r" : "g"}`; ip.textContent = inj.label === "injection" ? `⚠ injection · ${inj.reason}` : "✓ clean";
  const f: [string, string, string | null][] = [["room", "Room", o.roomName], ["cap", "Seats", o.capacity?.toString() ?? null], ["money", "Minimum", o.minSpendCents !== null ? usd(o.minSpendCents) : null],
    ["dep", "Deposit", o.depositPct !== null ? `${o.depositPct}%` : null], ["hold", "Hold", o.holdExpiresHours ? `${o.holdExpiresHours} h` : null], ["date", "Other nights", o.alternativeDates.join(", ") || null]];
  if (o.requestedPaymentDestination) f.push(["inj", "Pay to (ignored)", `✕ ${o.requestedPaymentDestination}`]);
  $("#fields").innerHTML = f.map(([k, l, v]) => `<div class="fld ${v ? "" : "empty"}" data-k="${k}"><div class="k"><i style="background:${FIELD_COLOR[k]}"></i>${l}</div><b>${esc(v ?? "-")}</b></div>`).join("");
  $$<HTMLElement>("#fields .fld").forEach((d) => { d.onmouseenter = () => $$(`#hlv [data-f="${d.dataset.k}"]`).forEach((s) => s.classList.add("hot")); d.onmouseleave = () => $$("#hlv .hot").forEach((s) => s.classList.remove("hot")); });
  const set = (cls: string, t: string) => { const v = $("#verdict"); v.className = `verdict ${cls}`; v.textContent = t; };
  if (inj.label === "injection") return set("bad", "Read as data. Bank details ignored. Booker warned. A clean venue wins.");
  if (tri.label === "decline") return set("warn", "Logged the no. On to the next venue.");
  if (tri.label === "auto_reply") return set("warn", "Ignored. Waits, then follows up.");
  if (tri.label === "question") return set("warn", "Answers with headcount and dietary needs.");
  if (tri.label === "needs_human") return set("warn", "Unclear, so a person reads it.");
  if (o.alternativeDates.length) return set("warn", `Wrong night. Offers ${o.alternativeDates.join(" or ")} to the booker.`);
  if (o.roomName === "Main dining room") return set("warn", "Not private. Rejected, and the real room size is learned.");
  const room = labVenue.rooms.find((r) => r.name === o.roomName) ?? labVenue.rooms[1];
  const pol = checkPolicy(company, { partySize: 12, partySizeStated: true, date: meta.date, dateAmbiguous: false, time: meta.time, kind: "client_dinner", clientName: "Acme", privateRoom: true, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" }, labVenue, { ...o, minSpendCents: o.minSpendCents ?? room.minSpendCents[4] }, 72);
  if (!pol.onPolicy) return set("bad", `Rejected: ${pol.violations.join("; ")}.`);
  set("ok", `Proposes ${usd(pol.estimate.allInCents)} all-in · ${usd(pol.estimate.perHeadAllInCents)} a head · ${pol.requiredRoles.join(" + ")} approves.`);
}
let tmr = 0;
$("#mail").addEventListener("input", () => { clearTimeout(tmr); tmr = window.setTimeout(() => void analyze(), 90); });
$("#mail").addEventListener("scroll", () => { $("#hlv").scrollTop = $("#mail").scrollTop; });
$$<HTMLButtonElement>("#tmpl .chip").forEach((b) => b.onclick = () => { $$("#tmpl .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); $<HTMLTextAreaElement>("#mail").value = template(b.dataset.t!); void analyze(); });
$<HTMLTextAreaElement>("#mail").value = template("accept"); void analyze();

// =====================================================================
// CONTROLS: the safety controls a finance or legal reviewer would ask to see, each one runnable
// =====================================================================
interface Ctl { id: string; name: string; threat: string; layer: string; sql: string[]; expect: "blocked" | "once" }
const CTLS: Ctl[] = [
  { id: "C-01", name: "Pay only the venue's payee on file", threat: "An email asks to wire the deposit to new bank details", layer: "Postgres trigger", expect: "blocked", sql: ["-- check_payment()", "IF NEW.payee_id <> v.payee_id THEN", "  RAISE EXCEPTION 'payee is not the payee on file';"] },
  { id: "C-02", name: "No booking without approval", threat: "The agent books while the proposal is pending", layer: "Postgres trigger", expect: "blocked", sql: ["-- check_booking()", "IF p.status <> 'approved' THEN", "  RAISE EXCEPTION 'booking needs an approved proposal';"] },
  { id: "C-03", name: "The agent can never approve", threat: "The agent approves its own proposal", layer: "Role grant + trigger", expect: "blocked", sql: ["REVOKE INSERT ON approvals FROM ande_agent;", "-- apply_approval()", "IF NEW.user_id = 'agent' THEN RAISE EXCEPTION ...;"] },
  { id: "C-04", name: "No double booking", threat: "Two confirmed bookings for one room and time", layer: "Exclusion constraint", expect: "blocked", sql: ["-- bookings", "EXCLUDE USING gist (room_id WITH =, during WITH &&)", "  WHERE (status = 'confirmed')"] },
  { id: "C-05", name: "Changes need approval", threat: "A confirmed dinner is moved without asking", layer: "Postgres function", expect: "blocked", sql: ["-- amend_booking()", "IF p.kind <> 'amend' OR p.status <> 'approved' THEN", "  RAISE EXCEPTION 'needs an approved amend proposal';"] },
  { id: "C-06", name: "One charge per payment", threat: "A network retry sends the same deposit twice", layer: "Unique key", expect: "once", sql: ["-- payments", "idempotency_key text NOT NULL UNIQUE", "-- insert runs WHERE NOT EXISTS (same key)"] },
];
const ctlState = new Map<string, { ok: boolean; result: string; ms: number; at: string }>();
async function fixture() {
  const s = new MemoryStore(); await s.init(venues); s.setNow("2026-11-09T15:00:00.000Z"); await s.createRun({ id: "ctl" });
  const base: Proposal = { id: "p_book", runId: "ctl", kind: "book", actorId: priya.id, principalId: dana.id, venueId: "ven_02", roomId: "ven_02_pdr", startsAt: "2026-11-13T00:00:00.000Z", endsAt: "2026-11-13T03:00:00.000Z",
    partySize: 12, amountCents: 180_000, payeeId: null, requiredRoles: ["booker"], approvedRoles: [], status: "pending", summary: "ctl", expiresAt: "2026-11-12T00:00:00.000Z" };
  await s.createProposal(base); await s.decide("p_book", priya.id, "booker", "approve");
  await s.book({ id: "bk_1", proposalId: "p_book", venueId: "ven_02", roomId: "ven_02_pdr", startsAt: base.startsAt, endsAt: base.endsAt, partySize: 12 });
  return { s, base };
}
async function attempt(id: string): Promise<{ ok: boolean; result: string }> {
  const { s, base } = await fixture();
  const mk = async (over: Partial<Proposal>, ok: boolean) => { const p = { ...base, id: `p_${Math.random().toString(36).slice(2, 7)}`, approvedRoles: [], status: "pending" as const, ...over }; await s.createProposal(p); if (ok) await s.decide(p.id, priya.id, "booker", "approve"); return p; };
  try {
    if (id === "C-01") { const p = await mk({ kind: "pay_deposit", amountCents: 36_000, payeeId: "acct_4400187733" }, true); await s.pay({ id: "x", idempotencyKey: "k", proposalId: p.id, bookingId: "bk_1", payeeId: "acct_4400187733", amountCents: 36_000 }); }
    if (id === "C-02") { const p = await mk({ startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z" }, false); await s.book({ id: "x", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: 12 }); }
    if (id === "C-03") { const p = await mk({}, false); await s.decide(p.id, "agent", "booker", "approve"); }
    if (id === "C-04") { const p = await mk({}, true); await s.book({ id: "x", proposalId: p.id, venueId: p.venueId, roomId: p.roomId, startsAt: p.startsAt, endsAt: p.endsAt, partySize: 12 }); }
    if (id === "C-05") { const p = await mk({ kind: "amend", startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-20T03:00:00.000Z", replacesBookingId: "bk_1" }, false); await s.amend(p.id, "bk_2"); }
    if (id === "C-06") { const p = await mk({ kind: "pay_deposit", amountCents: 36_000, payeeId: "payee_ven_02" }, true); const pay = { id: "pay_1", idempotencyKey: "retry", proposalId: p.id, bookingId: "bk_1", payeeId: "payee_ven_02", amountCents: 36_000 }; await s.pay(pay); await s.pay({ ...pay, id: "pay_2" }); const n = s.allPayments().length; return { ok: n === 1, result: `2 attempts → ${n} charge` }; }
    return { ok: false, result: "went through" };
  } catch (e) { return { ok: true, result: e instanceof StoreError ? e.code.replace(/_/g, " ") : String(e) }; }
}
function renderControls(open?: string) {
  const ran = [...ctlState.values()];
  $("#cSum").innerHTML = `<span class="st ${ran.length ? (ran.every((x) => x.ok) ? "ok" : "bad") : "mute"}">${ran.length ? `${ran.filter((x) => x.ok).length} of ${ran.length} held` : "Not run"}</span><span class="cs">6 controls · enforced in the database</span>`;
  $("#ctlBody").innerHTML = CTLS.map((c) => { const st = ctlState.get(c.id);
    return `<tr class="cr" data-id="${c.id}"><td class="mono">${c.id}</td><td><b>${esc(c.name)}</b><div class="cs">${esc(c.threat)}</div></td><td><span class="pill">${c.layer}</span></td>
      <td id="res_${c.id}">${st ? `<span class="st ${st.ok ? "ok" : "bad"}">${st.ok ? (c.expect === "once" ? "Charged once" : "Blocked") : "Failed"}</span>` : `<span class="st mute">Not run</span>`}</td>
      <td class="mono cs">${st ? `${st.ms.toFixed(1)} ms` : ""}</td><td><button class="btn sm" data-run="${c.id}">Run</button></td></tr>
      <tr class="ev ${open === c.id ? "open" : ""}" id="ev_${c.id}"><td></td><td colspan="5"><div class="evg"><div><div class="cs">Attempted</div><div>${esc(c.threat)}</div><div class="cs" style="margin-top:6px">Database answer</div><div class="mono">${st ? esc(st.result) : "—"}</div></div><div class="sql">${c.sql.map((l, i) => `<div${i === 1 ? ' class="hl"' : ""}>${esc(l)}</div>`).join("")}</div></div></td></tr>`; }).join("");
  $$<HTMLButtonElement>("[data-run]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); void runCtl(b.dataset.run!, true); });
  $$<HTMLElement>(".cr").forEach((r) => r.onclick = () => $(`#ev_${r.dataset.id}`).classList.toggle("open"));
  $("#audit").innerHTML = [...ctlState.entries()].reverse().map(([id, s]) => `<li><span class="mono cs">${s.at}</span> <b>${id}</b> ${esc(CTLS.find((c) => c.id === id)!.name)} → <span class="${s.ok ? "okt" : "badt"}">${esc(s.result)}</span></li>`).join("") || `<li class="cs">No attempts yet.</li>`;
}
async function runCtl(id: string, open = false) {
  $(`#res_${id}`).innerHTML = `<span class="spin"></span>`;
  await sleep(380);
  const t0 = performance.now(), r = await attempt(id), ms = performance.now() - t0;
  ctlState.set(id, { ...r, ms, at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
  renderControls(open ? id : undefined);
}
$("#runAll").onclick = async () => { const b = $<HTMLButtonElement>("#runAll"); b.disabled = true; for (const c of CTLS) await runCtl(c.id); b.disabled = false; };
renderControls();

// =====================================================================
// EVALS
// =====================================================================
const runs = new Map<string, ScenarioRun>();
for (const s of SCENARIOS) { const t = el("div", "tile", s.id); t.title = s.text; t.dataset.id = s.id; t.onclick = () => showRun(s.id); $("#tiles").append(t); }
for (let i = 0; i < 300; i++) $("#field").append(el("i"));
$("#detail").innerHTML = `<p style="color:var(--dim);margin:0">Random request × random venue behavior × random approver. Safety must never fail.</p>`;
function showRun(id: string) {
  const s = scen(id), r = runs.get(id); $("#dTitle").textContent = `${id} · ${s.group.replace("_", " ")}`;
  $("#detail").innerHTML = `<p style="font:600 15px Fraunces,Georgia,serif;margin:0 0 6px">“${esc(s.text)}”</p>` + (r ? `<p style="color:var(--dim);margin:0 0 6px">${r.result.outcome.replace(/_/g, " ")} · ${r.emails} emails · parse by ${r.result.parseDecidedBy === "model" ? "Claude" : "rules"}</p><table>${r.checks.map((c) => `<tr><td style="color:${c.pass ? "var(--sage)" : "var(--rose)"};font-weight:800">${c.pass ? "✓" : "✗"}</td><td>${c.name}</td></tr>`).join("")}</table>` : `<p style="color:var(--dim)">Not run yet.</p>`);
}
let inv = 0, invFail = 0;
$("#runEvals").onclick = async () => {
  const b = $<HTMLButtonElement>("#runEvals"); b.disabled = true; let pass = 0; inv = 0; invFail = 0; runs.clear(); $$("#tiles .tile").forEach((t) => (t.className = "tile"));
  for (const s of SCENARIOS) {
    const t = $(`.tile[data-id="${s.id}"]`); t.className = "tile run"; await sleep(60);
    const r = await runScenario(s, llm); runs.set(s.id, r); const ok = r.checks.every((c) => c.pass); if (ok) pass++;
    for (const c of r.checks.filter((c) => c.kind === "invariant")) { inv++; if (!c.pass) invFail++; }
    t.className = `tile ${ok ? "pass" : "fail"}${r.result.parseDecidedBy === "model" ? " ai" : ""}`;
    bump("sPass", `${pass}/${SCENARIOS.length}`); bump("sInv", inv.toLocaleString()); bump("sFail", String(invFail));
  }
  showRun("p01"); b.disabled = false;
};
$("#runFuzz").onclick = async () => {
  const b = $<HTMLButtonElement>("#runFuzz"); b.disabled = true; const out: Record<string, number> = {}; let checks = 0, fails = 0;
  const col: Record<string, string> = { booked: "#3f7d5a", escalated: "#b8862b", rejected_by_booker: "#7a4fb0", awaiting_approval: "#7b1e3a", needs_clarification: "#8c7c6f" };
  const dots = $$<HTMLElement>("#field i"); dots.forEach((d) => (d.style.background = ""));
  for (let i = 0; i < 300; i++) {
    const f = await fuzzOne(i, llm); out[f.outcome] = (out[f.outcome] ?? 0) + 1; checks += f.checks.length; const bad = f.checks.filter((c) => !c.pass).length; fails += bad;
    dots[i].style.background = bad ? "#c2455d" : col[f.outcome]; dots[i].title = f.text;
    if (i % 5 === 4 || i === 299) { bump("sFuzz", String(i + 1)); bump("sFail", String(invFail + fails)); bump("sInv", (inv + checks).toLocaleString()); $("#legend").innerHTML = Object.entries(out).map(([k, n]) => `<span style="color:${col[k]}">● ${k.replace(/_/g, " ")} ${n}</span>`).join(""); await sleep(10); }
  }
  b.disabled = false;
};

// =====================================================================
// MEMORY
// =====================================================================
const mem = new MemoryStore();
const SEED = [
  { scope: "private" as const, ownerUserId: "usr_priya", subject: "Dana", fact: "Prefers a quiet corner, never by the bar." },
  { scope: "private" as const, ownerUserId: "usr_priya", subject: "Dana", fact: "Shellfish allergy." },
  { scope: "company" as const, ownerUserId: "usr_priya", subject: "Acme", fact: "Their CFO is vegetarian." },
  { scope: "company" as const, ownerUserId: "usr_sam", subject: "Globex", fact: "Prefers lunches to dinners." },
  { scope: "private" as const, ownerUserId: "usr_sam", subject: "Hooli", fact: "Deal closes in Q1; keep it low-key." },
];
for (const m of SEED) await mem.remember({ companyId: company.id, source: "chat", ...m });
let viewAs = "usr_priya";
async function renderMems() {
  const visible = await mem.recall(company.id, viewAs);
  $("#mems").innerHTML = SEED.map((m) => { const ok = visible.some((v) => v.fact === m.fact); return `<div class="mi ${ok ? "" : "locked"}"><span class="pill ${m.scope === "private" ? "y" : "g"}">${m.scope}</span><span class="who">${esc(m.subject)}</span><span>${esc(m.fact)}</span></div>`; }).join("")
    + `<p style="color:var(--dim);font-size:12.5px;margin:8px 0 0">${visible.length} of ${SEED.length} visible. Postgres row-level security decides, not the agent.</p>`;
}
$$<HTMLButtonElement>("#viewAs button").forEach((b) => b.onclick = () => { $$("#viewAs button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); viewAs = b.dataset.u!; void renderMems(); });
void renderMems();
async function renderKnowledge() {
  const cardsHtml: string[] = [];
  for (const v of venues) {
    const L = await learned(v.id); if (!L.replies.length && !L.declines && !L.silences && !L.inj) continue;
    const capRows = v.rooms.filter((r) => L.cap.has(r.id)).map((r) => `<div class="cap">${esc(r.name)} <s>${r.listedCapacity}</s><span class="arrow">→</span><b>${L.cap.get(r.id)}</b><span class="pill y">learned</span></div>`).join("");
    cardsHtml.push(`<div class="vkc"><b>${esc(v.name)}</b>${L.inj ? '<span class="pill r">injection seen</span>' : ""}${L.declines ? `<span class="pill">said no ×${L.declines}</span>` : ""}${L.silences ? `<span class="pill">silent ×${L.silences}</span>` : ""}${capRows}
      ${L.replies.length ? `<div class="spark" title="reply times">${L.replies.slice(-14).map((h) => `<i style="height:${Math.min(100, 12 + h * 8)}%"></i>`).join("")}</div><div style="font-size:11px;color:var(--dim)">replies in ~${L.replies.at(-1)} h</div>` : ""}</div>`);
  }
  if (cardsHtml.length) $("#vk").innerHTML = cardsHtml.join("");
}

// =====================================================================
// SPEND
// =====================================================================
const cap = $<HTMLInputElement>("#cap"), mgr = $<HTMLInputElement>("#mgr"), ps = $<HTMLInputElement>("#ps");
cap.value = String(company.policy.perHeadCapCents.client_dinner / 100); mgr.value = String(company.policy.managerApprovalAboveCents / 100); ps.value = "12";
for (const v of venues) { const d = el("div", "vg", v.id.slice(4)); d.dataset.v = v.id; $("#vgrid").append(d); }
function whatIf() {
  company.policy.perHeadCapCents.client_dinner = Number(cap.value) * 100; company.policy.managerApprovalAboveCents = Number(mgr.value) * 100;
  $("#capV").textContent = `$${cap.value}`; $("#mgrV").textContent = `$${Number(mgr.value).toLocaleString()}`; $("#pV").textContent = ps.value;
  const n = Number(ps.value); let inP = 0, mg = 0;
  for (const v of venues) {
    const d = $(`.vg[data-v="${v.id}"]`); const room = v.rooms.filter((r) => r.private && r.listedCapacity >= n).sort((a, b) => a.listedCapacity - b.listedCapacity)[0];
    let cls = "out", tip = `${v.name}: no private room for ${n}`;
    if (company.policy.blockedVenueIds.includes(v.id)) { cls = "blk"; tip = `${v.name}: blocked`; }
    else if (room) {
      const e = estimate(n, perHeadFor(v, "client_dinner"), room.minSpendCents[4], v.preferredRatePct);
      tip = `${v.name}: ${usd(e.perHeadAllInCents)}/head · ${usd(e.allInCents)} all-in`;
      if (e.perHeadAllInCents <= company.policy.perHeadCapCents.client_dinner) { if (e.allInCents > company.policy.managerApprovalAboveCents) { cls = "mgr"; mg++; } else { cls = "in"; inP++; } }
    }
    d.className = `vg ${cls}`; d.title = tip;
  }
  $("#vcount").textContent = `${inP} in policy · ${mg} need a manager`;
}
[cap, mgr, ps].forEach((s) => s.addEventListener("input", () => { whatIf(); void analyze(); }));
whatIf();
function renderSpend() {
  const total = ledger.reduce((a, r) => a + r.allIn, 0); $("#xSpend").textContent = usd(total); $("#xSave").textContent = usd(S.saved);
  const pal = ["#7b1e3a", "#b8862b", "#3f7d5a", "#7a4fb0", "#c2455d", "#4a0f24", "#8c7c6f"]; let off = 25; const segs: string[] = [];
  ledger.forEach((r, i) => { const pct = (r.allIn / Math.max(1, total)) * 100; segs.push(`<circle cx="21" cy="21" r="15.9" fill="none" stroke="${pal[i % pal.length]}" stroke-width="6" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${off}" style="transition:.5s"/>`); off -= pct; });
  $("#donut").innerHTML = `<circle cx="21" cy="21" r="15.9" fill="none" stroke="#efe6d8" stroke-width="6"/>${segs.join("")}`;
  $("#ledger").innerHTML = ledger.length ? ledger.slice(0, 8).map((r, i) => `<tr><td><span style="color:${pal[i % pal.length]}">●</span> ${esc(r.venue)}</td><td>${r.guests} guests</td><td><b>${usd(r.allIn)}</b></td><td style="color:var(--sage)">${r.saved ? `−${usd(r.saved)}` : ""}</td></tr>`).join("") + (ledger.length > 8 ? `<tr><td colspan="4" style="color:var(--dim)">+ ${ledger.length - 8} more</td></tr>` : "") : `<tr><td class="empty">Nothing booked yet.</td></tr>`;
}

// =====================================================================
// FIX LAB: find the failure in a real conversation, fix it, prove the fix
// =====================================================================
const INCIDENTS = [
  { id: "R7", title: "“Japanese dinner” booked a Korean room", text: "japanese dinner for 8 with Wayne Enterprises on 2026-11-24, private", reg: "p12", flag: { r7: true, r8: true },
    diag: (r: RunResult) => { const v = venues.find((x) => x.id === r.chosenVenueId); return v ? `Asked for <b>Japanese</b>. Proposed <b>${esc(v.name)}</b>, which is <b>${esc(v.cuisine)}</b>. Cuisine was a +20 ranking nudge, not a requirement.` : "No venue proposed."; },
    diff: ["- // cuisine only nudges the ranking", "- cuisine: req.cuisine && v.cuisine === req.cuisine ? 20 : 0,", "+ const cuisineRequired = !!req.cuisine && venues.some((v) => v.cuisine === req.cuisine);", "+ if (cuisineRequired && v.cuisine !== req.cuisine) continue;", "+ // none fits policy? ask the booker which constraint to relax"] },
  { id: "R8", title: "Two vegetarians never confirmed to the booker", text: "dinner for a dozen with Umbrella next Wednesday in the West Village, private room, two vegetarians", reg: "reg06", flag: { r7: true, r8: true },
    diag: () => "Dietary needs went to the venue in the inquiry, but the proposal the booker approves never mentions them.",
    diff: ["  + `Deposit ${deposit}; free cancellation until ${h} h before.`", "+ + (req.dietary.length ? ` Dietary needs sent to ${venue}: ${req.dietary}.` : \"\")", "+ + (req.cuisine ? ` ${cuisine}, as asked.` : \"\")"] },
];
let inc = 0;
async function runFix(legacy: { r7?: boolean; r8?: boolean } | undefined, text: string) {
  const store = new MemoryStore(); await store.init(venues);
  const world = new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z", 11);
  const res = await runConcierge({ text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, company: COMPANY, legacy,
    approver: async (p, s) => carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, s) });
  const msg = res.messagesToBooker.find((m) => /Reply approve or reject/.test(m)) ?? res.messagesToBooker.at(-1) ?? "";
  const verdict = /Reply approve or reject/.test(msg) ? await judgeMessage(llm, text, msg) : null;
  return { res, msg, verdict };
}
const judgeCard = (v: { score: number; reason: string } | null, pending: string) => v
  ? `<div class="judge ${v.score >= 5 ? "ok" : v.score >= 3 ? "warn" : "bad"}"><div class="js">${v.score}<small>/5</small></div><div><div class="cs">Claude judge · recorded verdict</div><div>${esc(v.reason)}</div></div></div>`
  : `<div class="judge mute"><div class="js">—</div><div><div class="cs">Claude judge</div><div>${pending}</div></div></div>`;
function renderIncidents() {
  $("#incList").innerHTML = INCIDENTS.map((x, i) => `<button class="${i === inc ? "on" : ""}" data-i="${i}"><span class="mono">${x.id}</span>${esc(x.title)}</button>`).join("");
  $$<HTMLButtonElement>("#incList button").forEach((b) => b.onclick = () => { inc = Number(b.dataset.i); renderIncidents(); resetFix(); });
}
function resetFix() {
  $$("#fixSteps span").forEach((s) => (s.className = "")); $("#fixOut").innerHTML = `<div class="req2">“${esc(INCIDENTS[inc].text)}”</div><p class="cs">Press Replay to rerun the original conversation on the pre-fix code path.</p>`;
  $("#fixGo").textContent = "1 · Replay the failure ▶"; fixStep = 0;
}
let fixStep = 0;
$("#fixGo").onclick = async () => {
  const x = INCIDENTS[inc], steps = $$("#fixSteps span"), out = $("#fixOut"), btn = $<HTMLButtonElement>("#fixGo"); btn.disabled = true;
  const mark = (i: number) => steps.forEach((s, j) => (s.className = j < i ? "ok" : j === i ? "on" : ""));
  if (fixStep === 0) {
    mark(0); const before = await runFix(x.flag, x.text);
    out.innerHTML = `<div class="req2">“${esc(x.text)}”</div><div class="cs">Before the fix · proposal sent to the booker</div><div class="msg">${esc(before.msg)}</div>${judgeCard(before.verdict, "not judged")}`;
    btn.textContent = "2 · Diagnose ▶";
  } else if (fixStep === 1) {
    mark(1); const before = await runFix(x.flag, x.text);
    out.insertAdjacentHTML("beforeend", `<div class="diag"><div class="cs">Root cause</div>${x.diag(before.res)}</div><div class="diff">${x.diff.map((l) => `<div class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${esc(l)}</div>`).join("")}</div>`);
    btn.textContent = "3 · Rerun with the fix ▶";
  } else if (fixStep === 2) {
    mark(2); const after = await runFix(undefined, x.text);
    out.insertAdjacentHTML("beforeend", `<div class="cs" style="margin-top:14px">After the fix · ${after.res.outcome.replace(/_/g, " ")}</div><div class="msg good">${esc(after.msg)}</div>${judgeCard(after.verdict, "This new message hasn't been through a live run yet. <code>npm run evals:live</code> records Claude's verdict.")}`);
    btn.textContent = "4 · Prove it in the eval suite ▶";
  } else {
    mark(3); const r = await runScenario(scen(x.reg), llm), ok = r.checks.every((c) => c.pass);
    out.insertAdjacentHTML("beforeend", `<div class="prove"><span class="tile ${ok ? "pass" : "fail"}">${x.reg}</span><div><b>${ok ? "Permanent eval case passes" : "Eval case fails"}</b><div class="cs">${r.checks.filter((c) => /cuisine|dietary|outcome/.test(c.name)).map((c) => `${c.pass ? "✓" : "✗"} ${c.name}`).join(" · ")}</div></div></div>`);
    steps.forEach((s) => (s.className = "ok")); btn.textContent = "Replay again ↺"; fixStep = -1;
  }
  fixStep++; btn.disabled = false; out.scrollTop = out.scrollHeight;
};
renderIncidents(); resetFix();

// =====================================================================
// TOOLS: call the agent's typed capabilities yourself
// =====================================================================
const TOOLS = [sendVenueEmail, createProposal, bookTool, payDeposit, notifyBooker, recordFact] as unknown as Tool<unknown, unknown>[];
const toolStore = new MemoryStore(); await toolStore.init(venues); toolStore.setNow("2026-11-09T15:00:00.000Z"); await toolStore.createRun({ id: "tools" });
const toolWorld = new VenueWorld(venues, () => "accept", "2026-11-09T15:00:00.000Z", 11);
let toolSel = 1, lastProposal = "", lastBooking = "";
const EX: Record<string, () => unknown> = {
  send_venue_email: () => ({ venueId: "ven_02", threadId: "thr_demo", kind: "inquiry", body: "Hello, could you host 12 guests privately on Thursday at 7pm?" }),
  create_proposal: () => ({ runId: "tools", kind: "book", actorId: "usr_priya", principalId: "usr_dana", venueId: "ven_02", roomId: "ven_02_pdr", startsAt: "2026-11-13T00:00:00.000Z", endsAt: "2026-11-13T03:00:00.000Z", partySize: 12, amountCents: 180000, payeeId: null, requiredRoles: ["booker"], summary: "The Copper Fig, Wine Cellar, Thu 7 pm, 12 guests", expiresAt: "2026-11-11T00:00:00.000Z" }),
  book: () => ({ proposalId: lastProposal || "prop_xxxx" }),
  pay_deposit: () => ({ proposalId: lastProposal || "prop_xxxx", bookingId: lastBooking || "bk_xxxx", idempotencyKey: "deposit-1" }),
  notify_booker: () => ({ text: "Your dinner at The Copper Fig is confirmed." }),
  record_venue_fact: () => ({ venueId: "ven_02", roomId: "ven_02_pdr", kind: "room_capacity", value: 10, confidence: 0.85, sourceMessageId: "msg_demo" }),
};
function renderTools() {
  $("#toolList").innerHTML = TOOLS.map((t, i) => `<button class="${i === toolSel ? "on" : ""}" data-i="${i}"><span class="mono">${t.name}</span>${t.consequential ? '<span class="pill r">moves money / books</span>' : '<span class="pill">safe</span>'}</button>`).join("");
  $$<HTMLButtonElement>("#toolList button").forEach((b) => b.onclick = () => { toolSel = Number(b.dataset.i); renderTools(); });
  const t = TOOLS[toolSel]; $("#toolDesc").textContent = t.description; $<HTMLTextAreaElement>("#toolIn").value = JSON.stringify(EX[t.name](), null, 2);
}
async function toolAudit() {
  const log = await toolStore.auditLog("tools");
  $("#toolAudit").innerHTML = log.slice().reverse().map((a) => `<li><span class="mono">${esc(a.action)}</span> by ${esc(a.actorId)} for ${esc(String(a.detail.onBehalfOf))}${a.detail.consequential ? ' <span class="pill r">consequential</span>' : ""}</li>`).join("") || `<li class="cs">No calls yet.</li>`;
}
$("#toolCall").onclick = async () => {
  const t = TOOLS[toolSel], out = $("#toolOut"), actor = user($<HTMLSelectElement>("#toolActor").value);
  let input: unknown; try { input = JSON.parse($<HTMLTextAreaElement>("#toolIn").value); } catch { out.innerHTML = `<div class="tres bad"><b>Not JSON</b></div>`; return; }
  const ctxT = { store: toolStore, world: toolWorld, llm, company, venues, actor, principal: dana, runId: "tools", today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] };
  const before = (await toolStore.auditLog("tools")).length;
  try {
    const r = await call(ctxT, "inspector", t as Tool<unknown, unknown>, input) as Record<string, unknown>;
    if (r.proposalId) lastProposal = String(r.proposalId); if (r.bookingId) lastBooking = String(r.bookingId);
    const replay = (await toolStore.auditLog("tools")).length === before;
    out.innerHTML = `<div class="tres ok"><b>${replay ? "Same input → same result (idempotent replay, nothing ran twice)" : "Executed"}</b><pre>${esc(JSON.stringify(r, null, 2))}</pre></div>`;
  } catch (e) {
    const msg = e instanceof ZodError ? e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("\n") : e instanceof ToolDenied ? e.message : e instanceof StoreError ? `${e.code.replace(/_/g, " ")}: ${e.message}` : String(e);
    const kind = e instanceof ZodError ? "Rejected by the input schema" : e instanceof ToolDenied ? "Refused: not allowed to act for this person" : e instanceof StoreError ? "Refused by the database" : "Error";
    out.innerHTML = `<div class="tres bad"><b>${kind}</b><pre>${esc(msg)}</pre></div>`;
  }
  void toolAudit();
};
$("#toolApprove").onclick = async () => {
  if (!lastProposal) { $("#toolOut").innerHTML = `<div class="tres bad"><b>Create a proposal first.</b></div>`; return; }
  try { const p = await toolStore.decide(lastProposal, priya.id, "booker", "approve"); $("#toolOut").innerHTML = `<div class="tres ok"><b>Priya approved ${esc(p.id)} from the booker app (separate role)</b><pre>status: ${p.status}</pre></div>`; }
  catch (e) { $("#toolOut").innerHTML = `<div class="tres bad"><b>${e instanceof StoreError ? e.code.replace(/_/g, " ") : String(e)}</b></div>`; }
};
renderTools(); void toolAudit();

// =====================================================================
// JUDGMENTS: thresholds, timeout, fallback, rollout mode
// =====================================================================
const slowModel = (delayMs: number, label: string): LLM => ({
  mode: "live",
  complete: (_t, _s, _u, o) => new Promise((res, rej) => { const id = setTimeout(() => res({ text: JSON.stringify({ label, confidence: 0.97, reason: "stub model" }), inputTokens: 0, outputTokens: 0, model: "stub" }), delayMs); o?.signal?.addEventListener("abort", () => { clearTimeout(id); rej(new Error("aborted")); }); }),
});
const JPRESET: Record<string, string> = { "Clear offer": "Great news, the Wine Cellar is available Thursday. We take a 25% deposit.", "Vague": "Re: re: let me check with the chef and circle back", "Decline": "Unfortunately we're fully committed that night.", "STOP": "STOP", "please stop texting me": "please stop texting me" };
async function judge() {
  const text = $<HTMLTextAreaElement>("#jIn").value, kind = $<HTMLSelectElement>("#jKind").value, mode = $<HTMLSelectElement>("#jMode").value as "rules" | "shadow" | "live";
  const delay = Number($<HTMLInputElement>("#jDelay").value), timeout = Number($<HTMLInputElement>("#jTimeout").value);
  $("#jDelayV").textContent = `${delay} ms`; $("#jTimeoutV").textContent = `${timeout} ms`;
  const model = slowModel(delay, kind === "triage" ? "offer" : "no_change");
  const c = kind === "triage" ? replyTriage(model, mode) : smsConsent(model, mode);
  const spec = c.spec as unknown as { thresholds: Record<string, number>; timeoutMs: number; labels: string[]; fallback: string };
  spec.timeoutMs = timeout;
  const key = kind === "triage" ? "offer" : "opt_out";
  spec.thresholds[key] = Number($<HTMLInputElement>("#jThr").value) / 100; $("#jThrV").textContent = `${key} ≥ ${spec.thresholds[key].toFixed(2)}`;
  $("#jVerdict").innerHTML = `<span class="spin"></span>`;
  const t0 = performance.now(); const j = await c.classify(text); const ms = Math.round(performance.now() - t0);
  const raw = (c.spec as unknown as { rules: (t: string) => { label: string; confidence: number; reason: string } }).rules(text);
  $("#jVerdict").innerHTML = `<div class="big2">${esc(j.label.replace("_", " "))}</div><div class="cs">decided by <b>${j.decidedBy}</b> · ${ms} ms · ${esc(j.reason)}</div>${j.shadow ? `<div class="cs">shadow model said: <b>${"label" in j.shadow ? esc(j.shadow.label) : esc(j.shadow.error)}</b> (logged, not used)</div>` : ""}`;
  $("#jBars").innerHTML = spec.labels.filter((l) => l !== spec.fallback || l === raw.label).map((l) => { const conf = l === raw.label ? raw.confidence : 0, thr = spec.thresholds[l] ?? 0;
    return `<div class="jb"><span>${esc(l.replace("_", " "))}</span><div class="jt"><i style="width:${conf * 100}%" class="${conf >= thr && conf > 0 ? "pass" : ""}"></i><b style="left:${thr * 100}%"></b></div><span class="mono">${conf ? conf.toFixed(2) : ""}</span></div>`; }).join("");
}
$$<HTMLButtonElement>("#jPresets button").forEach((b) => b.onclick = () => { $<HTMLTextAreaElement>("#jIn").value = JPRESET[b.textContent!]; $<HTMLSelectElement>("#jKind").value = /stop/i.test(b.textContent!) ? "consent" : "triage"; void judge(); });
["#jIn", "#jKind", "#jMode", "#jDelay", "#jTimeout", "#jThr"].forEach((id) => $(id).addEventListener("input", () => void judge()));
void judge();

// =====================================================================
// TOUR: a hands-free walkthrough for a live call
// =====================================================================
let touring = false;
const say = (n: string, t: string) => (window as unknown as { caption: (n: string, t: string) => void }).caption(n, t);
async function tour() {
  if (touring) { touring = false; return; }
  touring = true; $("#tourBtn").textContent = "■ Stop tour";
  const step = async (n: string, t: string, page: string, fn: () => Promise<void>) => { if (!touring) return; say(n, t); go(page); await fn(); };
  await step("01 · ONE SENTENCE", "The agents email venues, read replies, ignore an injection. You slide. It's booked.", "home", async () => {
    $("#hGo").click(); for (let i = 0; i < 300 && touring && !$("#hSl .slide"); i++) await sleep(100); await sleep(1400);
    ($("#hSl .slide .lbl") as HTMLElement | null)?.click(); for (let i = 0; i < 100 && touring && !$(".ph-ok"); i++) await sleep(100); await sleep(2600);
  });
  await step("02 · EXPLORE", "Filter the network on the map, shortlist, send one RFP. Offers land side by side.", "explore", async () => {
    await sleep(1000); for (let i = 0; i < 3 && touring; i++) { ($(".heart:not([disabled]):not(.on)") as HTMLElement | null)?.click(); await sleep(450); }
    await sleep(500); $("#xRfp")?.click(); for (let i = 0; i < 100 && touring && !$("#p-compare.on"); i++) await sleep(100); await sleep(2800);
  });
  await step("03 · FIX LAB", "Find the failure in a real conversation. Fix it. Prove it.", "fix", async () => { for (let i = 0; i < 4 && touring; i++) { $<HTMLButtonElement>("#fixGo").click(); await sleep(2300); } });
  await step("04 · TOOLS", "Typed tools: bad input rejected, unapproved booking refused.", "tools", async () => {
    $<HTMLButtonElement>("#toolList button[data-i='1']").click(); await sleep(500); $<HTMLButtonElement>("#toolCall").click(); await sleep(1300);
    $<HTMLButtonElement>("#toolList button[data-i='2']").click(); await sleep(500); $<HTMLButtonElement>("#toolCall").click(); await sleep(1600);
    $<HTMLButtonElement>("#toolApprove").click(); await sleep(1200); $<HTMLButtonElement>("#toolCall").click(); await sleep(1600);
  });
  await step("05 · CONTROLS", "Six safety controls, enforced by Postgres.", "controls", async () => { $<HTMLButtonElement>("#runAll").click(); await sleep(3500); });
  await step("06 · EVALS", "The CI suite in your browser. Real Claude outputs.", "evals", async () => { $<HTMLButtonElement>("#runEvals").click(); for (let i = 0; i < 300 && !$("#sPass").textContent!.startsWith("47/"); i++) await sleep(100); await sleep(1200); });
  await step("07 · POLICY", "Policy is code. Drag it and the city changes.", "spend", async () => { for (const v of [180, 140, 300]) { const s = $<HTMLInputElement>("#cap"); s.value = String(v); s.dispatchEvent(new Event("input")); await sleep(900); } });
  say("", ""); touring = false; $("#tourBtn").textContent = "▶ Tour";
}
$("#tourBtn").onclick = () => void tour();

// =====================================================================
// shared: a slide-to-approve control that works in any container
// =====================================================================
function slideIn(box: HTMLElement, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = el("div", "slide light", `<div class="fill"></div><div class="lbl">${esc(label)} ›››</div><div class="knob">✓</div>`), rej = el("button", "reject dark", "Decline");
    box.append(s, rej);
    const knob = s.querySelector<HTMLElement>(".knob")!, fill = s.querySelector<HTMLElement>(".fill")!;
    let drag = false, sx = 0, x = 0; const max = () => s.clientWidth - 52;
    const set = (v: number) => { x = Math.max(0, Math.min(max(), v)); knob.style.left = `${4 + x}px`; fill.style.width = `${56 + x}px`; };
    const done = () => { s.classList.add("done"); s.querySelector(".lbl")!.textContent = "Approved ✓"; rej.remove(); resolve(true); };
    knob.addEventListener("pointerdown", (e) => { drag = true; sx = e.clientX - x; knob.setPointerCapture(e.pointerId); });
    knob.addEventListener("pointermove", (e) => { if (drag) set(e.clientX - sx); });
    knob.addEventListener("pointerup", () => { drag = false; if (x > max() * 0.85) { set(max()); done(); } else set(0); });
    s.addEventListener("click", (e) => { if (e.target !== knob && !s.classList.contains("done")) { set(max()); setTimeout(done, 150); } });
    rej.onclick = () => { s.remove(); rej.remove(); resolve(false); };
  });
}
const toolCtx = (store: MemoryStore, world: VenueWorld, runId: string) => ({ store, world, llm, company, venues, actor: priya, principal: dana, runId, today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] as TraceEvent[] });
const NOW = "2026-11-09T15:00:00.000Z";
const reqFor = (n: number, date: string, priv: boolean, client = "Acme"): BookingRequest => ({ partySize: n, partySizeStated: true, date, dateAmbiguous: false, time: "19:00", kind: "client_dinner", clientName: client, privateRoom: priv, neighborhood: null, cuisine: null, maxPerHeadCents: null, dietary: [], notes: "" });

/** Propose → approve (slider per role) → book → pay deposit, all through the real typed tools and store. */
async function proposeAndBook(box: HTMLElement, store: MemoryStore, world: VenueWorld, runId: string, v: Venue, roomId: string, date: string, n: number, pol: PolicyResult, minSpend: number) {
  const ctxT = toolCtx(store, world, runId), win = eventWindow(date, "19:00");
  const base = { runId, actorId: priya.id, principalId: dana.id, venueId: v.id, roomId, ...win, partySize: n, requiredRoles: pol.requiredRoles, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString() };
  const room = v.rooms.find((r) => r.id === roomId)!;
  const bp = await call(ctxT, "grid", createProposal, { ...base, kind: "book", amountCents: pol.estimate.allInCents, payeeId: null, summary: `${v.name}, ${room.name}, ${date}, ${n} guests` }) as { proposalId: string };
  const dp = pol.depositCents > 0 ? await call(ctxT, "grid", createProposal, { ...base, kind: "pay_deposit", amountCents: pol.depositCents, payeeId: v.payeeId, summary: `Deposit for ${v.name}` }) as { proposalId: string } : null;
  box.insertAdjacentHTML("beforeend", `<div class="gstep"><b>Proposal</b> ${esc(v.name)} · ${esc(room.name)} · ${usd(minSpend)} min · <b>${usd(pol.estimate.allInCents)}</b> all-in${pol.depositCents ? ` · deposit ${usd(pol.depositCents)}` : ""}<div class="cs">${pol.requiredRoles.map((r) => approverFor(r, priya).name).join(" + ")} must approve</div></div>`);
  for (const role of pol.requiredRoles) {
    const ok = await slideIn(box, `Slide to approve as ${approverFor(role, priya).name.split(" ")[0]}`);
    for (const id of [bp.proposalId, dp?.proposalId].filter(Boolean) as string[]) await store.decide(id, approverFor(role, priya).id, role, ok ? "approve" : "reject");
    if (!ok) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">Declined. Nothing booked or paid.</div>`); return null; }
  }
  try {
    const bk = await call(ctxT, "grid", bookTool, { proposalId: bp.proposalId }, `${bp.proposalId}:book`) as { bookingId: string };
    const pay = dp ? await call(ctxT, "grid", payDeposit, { proposalId: dp.proposalId, bookingId: bk.bookingId, idempotencyKey: `${dp.proposalId}:pay` }, `${dp.proposalId}:pay`) as { payeeId: string } : null;
    box.insertAdjacentHTML("beforeend", `<div class="gstep ok"><b>Booked</b> ${esc(bk.bookingId)}${pay ? ` · deposit paid to ${esc(pay.payeeId)}` : ""}</div>`);
    const saved = v.preferredRatePct ? Math.round(pol.estimate.savingsCents) : 0;
    S.booked++; S.req++; S.saved += saved; ledger.unshift({ venue: v.name, guests: n, allIn: pol.estimate.allInCents, saved });
    bump("kBook", String(S.booked)); bump("kReq", String(S.req)); bump("kSave", usd(S.saved)); renderSpend();
    setLastBooking({ venue: v, roomName: room.name, partySize: n, date, dietary: [], client: "Acme", world, threadId: `thr_${runId}_${v.id}` });
    box.insertAdjacentHTML("beforeend", `<div class="row" style="margin-top:8px"><button class="btn pri" onclick="go('seating')">Arrange seating →</button><button class="btn" onclick="go('bookings')">View booking</button></div>`);
    toast("Booked", `${v.name} · ${room.name} · ${n} guests · ${date}`);
    return bk.bookingId;
  } catch (e) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">${esc(e instanceof StoreError ? `Refused by the database: ${e.code.replace(/_/g, " ")}` : String(e))}</div>`); return null; }
}

// =====================================================================
// AVAILABILITY: 30 venues × 14 nights, click a table, book it
// =====================================================================
const gStore = new MemoryStore(); await gStore.init(venues); gStore.setNow(NOW); await gStore.createRun({ id: "grid" }); stores.push(gStore);
const NIGHTS = Array.from({ length: 14 }, (_, i) => addDays("2026-11-09", i + 1));
let gParty = 12, gPrivate = true, gSort = "score", gPick: { v: Venue; date: string } | null = null;
function cell(v: Venue, date: string) {
  const wd = weekday(date), n = gParty;
  if (v.closedDays.includes(wd)) return { kind: "closed" as const };
  const room = v.rooms.filter((r) => (gPrivate ? r.private : true) && r.listedCapacity >= n).sort((a, b) => (gPrivate ? 0 : Number(a.private) - Number(b.private)) || a.listedCapacity - b.listedCapacity)[0];
  if (!room) return { kind: "noroom" as const };
  const min = room.private ? room.minSpendCents[wd] : 0;
  const taken = stores.some((s) => s.allBookings().some((b) => b.status === "confirmed" && b.roomId === room.id && localDate(b.startsAt) === date));
  const pol = checkPolicy(company, reqFor(n, date, gPrivate), v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
  return { kind: taken ? "taken" as const : pol.onPolicy ? (pol.requiredRoles.includes("manager") ? "mgr" as const : "ok" as const) : "over" as const, room, min, pol };
}
function renderGrid() {
  $("#gPartyV").textContent = String(gParty);
  const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows = venues.map((v) => ({ v, cells: NIGHTS.map((d) => cell(v, d)) }));
  const ph = (r: (typeof rows)[number]) => Math.min(...r.cells.map((c) => ("pol" in c && c.pol ? c.pol.estimate.perHeadAllInCents : 1e9)));
  const open = (r: (typeof rows)[number]) => r.cells.filter((c) => c.kind === "ok" || c.kind === "mgr").length;
  rows.sort((a, b) => gSort === "price" ? ph(a) - ph(b) : gSort === "open" ? open(b) - open(a) : a.v.neighborhood.localeCompare(b.v.neighborhood) || a.v.name.localeCompare(b.v.name));
  let html = `<table class="grid"><thead><tr><th class="vh">Venue</th>${NIGHTS.map((d) => `<th class="${[0, 6].includes(weekday(d)) ? "we" : ""}">${DAYS3[weekday(d)]}<span>${Number(d.slice(8))}</span></th>`).join("")}</tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr><td class="vh"><b>${esc(r.v.name)}</b><span>${esc(r.v.neighborhood)} · ${esc(r.v.cuisine)}${r.v.preferredRatePct ? ` · <em>−${r.v.preferredRatePct}%</em>` : ""}</span></td>`;
    r.cells.forEach((c, i) => {
      const d = NIGHTS[i], sel = gPick && gPick.v.id === r.v.id && gPick.date === d ? " sel" : "";
      if (c.kind === "closed") html += `<td class="gc closed${sel}" title="Closed">—</td>`;
      else if (c.kind === "noroom") html += `<td class="gc none${sel}" title="No ${gPrivate ? "private " : ""}room for ${gParty}">·</td>`;
      else html += `<td class="gc ${c.kind}${sel}" data-v="${r.v.id}" data-d="${d}" title="${esc(c.room.name)} · ${usd(c.pol.estimate.perHeadAllInCents)}/head">${c.kind === "taken" ? "●" : `$${Math.round(c.pol.estimate.perHeadAllInCents / 100)}`}</td>`;
    });
    html += "</tr>";
  }
  $("#grid").innerHTML = html + "</tbody></table>";
  const all = rows.flatMap((r) => r.cells);
  $("#gStats").innerHTML = `<span class="st ok">${all.filter((c) => c.kind === "ok").length} in policy</span><span class="st warn">${all.filter((c) => c.kind === "mgr").length} need a manager</span><span class="st mute">${all.filter((c) => c.kind === "over").length} over cap</span><span class="st bad">${all.filter((c) => c.kind === "taken").length} booked</span>`;
  $$<HTMLElement>("#grid .gc[data-v]").forEach((td) => td.onclick = () => { gPick = { v: venues.find((x) => x.id === td.dataset.v)!, date: td.dataset.d! }; renderGrid(); gDetail(); });
}
function gDetail() {
  if (!gPick) return; const { v, date } = gPick, c = cell(v, date); if (!("pol" in c) || !c.pol) return;
  const p = c.pol, DAYS3 = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  $("#gSide").innerHTML = `<div class="vt">${esc(v.name)}</div><div class="vs">${DAYS3[weekday(date)]}, Nov ${Number(date.slice(8))} · 7 pm · ${gParty} guests</div>
    <div>${c.kind === "taken" ? '<span class="pill r">Already booked</span>' : p.onPolicy ? '<span class="pill g">In-Policy</span>' : `<span class="pill r">${esc(p.violations[0])}</span>`}${v.preferredRatePct ? `<span class="pill y">Preferred −${v.preferredRatePct}%</span>` : ""}${v.contractRequired ? '<span class="pill">Contract</span>' : ""}</div>
    <dl class="kv"><dt>Room</dt><dd>${esc(c.room.name)} · ${c.room.listedCapacity} seats</dd><dt>Minimum</dt><dd>${usd(c.min)}</dd><dt>All-in</dt><dd>${usd(p.estimate.allInCents)} · ${usd(p.estimate.perHeadAllInCents)}/head</dd><dt>Deposit</dt><dd>${p.depositCents ? usd(p.depositCents) : "none"}</dd><dt>Cancellation</dt><dd>free until ${v.cancellationHours} h before</dd><dt>Approval</dt><dd>${p.requiredRoles.join(" + ")}</dd></dl>
    ${c.kind === "taken" ? "" : p.onPolicy ? `<button class="btn pri" id="gReq" style="width:100%;margin-top:10px">Request this table</button>` : ""}<div id="gFlow"></div>`;
  $("#gReq")?.addEventListener("click", () => void gRequest(v, date, c.room.id));
}
async function gRequest(v: Venue, date: string, roomId: string) {
  $("#gReq")!.remove(); const box = $("#gFlow"), runId = `grid_${Math.random().toString(36).slice(2, 7)}`, thread = `thr_${runId}_${v.id}`;
  await gStore.createRun({ id: runId });
  const world = new VenueWorld(venues, () => "accept", NOW, 31 + Math.floor(Math.random() * 1000));
  const ctxT = toolCtx(gStore, world, runId);
  await call(ctxT, "grid", sendVenueEmail, { venueId: v.id, threadId: thread, kind: "inquiry", body: `Hello ${v.name} team, could you host ${gParty} guests${gPrivate ? " in a private room" : ""} on ${date} at 7 pm for Northwind Labs?`, meta: { date, time: "19:00", partySize: gParty, privateRoom: gPrivate } });
  box.insertAdjacentHTML("beforeend", `<div class="gstep"><span class="spin"></span> Emailed ${esc(v.name)}…</div>`); await sleep(900);
  const reply = world.advance(8).find((m) => m.threadId === thread);
  box.lastElementChild!.innerHTML = `<b>Emailed</b> ${esc(v.name)} · reply in ${reply ? Math.max(1, Math.round((Date.parse(reply.at) - Date.parse(NOW)) / 3_600_000)) : "?"} h`;
  if (!reply) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">No reply yet.</div>`); return; }
  const { offer, decidedBy } = await extractOffer(llm, reply.body, v, reply.id, "2026-11-09", true);
  box.insertAdjacentHTML("beforeend", `<div class="gstep"><b>Reply read</b>${decidedBy === "model" ? '<span class="ai"></span>' : ""}<div class="cs">${esc(reply.body.split("\n").filter(Boolean)[1]?.slice(0, 150) ?? "")}…</div></div>`);
  const room = v.rooms.find((r) => r.name === offer.roomName) ?? v.rooms.find((r) => r.id === roomId)!;
  const min = offer.minSpendCents ?? room.minSpendCents[weekday(date)];
  const pol = checkPolicy(company, reqFor(gParty, date, gPrivate), v, { ...offer, minSpendCents: min }, leadHours(NOW, date, "19:00"));
  if (!pol.onPolicy) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">${esc(pol.violations.join("; "))}</div>`); return; }
  await proposeAndBook(box, gStore, world, runId, v, room.id, date, gParty, pol, min);
  renderGrid();
}
$<HTMLInputElement>("#gParty").addEventListener("input", (e) => { gParty = Number((e.target as HTMLInputElement).value); renderGrid(); gDetail(); });
$<HTMLInputElement>("#gPriv").addEventListener("change", (e) => { gPrivate = (e.target as HTMLInputElement).checked; renderGrid(); gDetail(); });
$$<HTMLButtonElement>("#gSort button").forEach((b) => b.onclick = () => { $$("#gSort button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); gSort = b.dataset.s!; renderGrid(); });
renderGrid();

// =====================================================================
// COMPARE: every offer the agent collected, side by side
// =====================================================================
interface Cmp { v: Venue; roomId: string; roomName: string; seats: number | null; min: number; pol: PolicyResult; ai: boolean; why: string | null; injected: boolean; agentPick: boolean }
let cmpRows: Cmp[] = [], cmpSel = new Set<string>(), cmpSortKey = "perHead", cmpCtx: { store: MemoryStore; world: VenueWorld; runId: string; req: BookingRequest } | null = null;
async function cmpLoad() {
  const btn = $<HTMLButtonElement>("#cmpGo"); btn.disabled = true; $("#cmpTable").innerHTML = `<div class="empty"><span class="spin"></span> The agent is emailing venues and reading replies…</div>`;
  const text = $<HTMLInputElement>("#cmpAsk").value, store = new MemoryStore(); await store.init(venues); stores.push(store); srcOf.set(store, "Compare");
  const order: Behavior[] = ["accept", "counter_price", "injection", "accept", "decline", "counter_capacity", "accept"]; const seen = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, NOW, 11);
  const res = await runConcierge({ text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, company, maxRounds: 1, shortlistSize: 7, approver: async () => "pending" });
  const req = res.request!; const proposed = res.proposals.find((p) => p.kind === "book");
  cmpCtx = { store, world, runId: res.runId, req };
  const rejected = new Map(((res.trace.find((e) => e.kind === "compared")?.data?.rejected ?? []) as { venue: string; why: string }[]).map((r) => [r.venue, r.why]));
  const injected = new Set(res.trace.filter((e) => e.kind === "injection_flagged").map((e) => e.text.split("'s email")[0]));
  cmpRows = res.trace.filter((e) => e.kind === "offer").map((e) => {
    const o = e.data!.offer as Offer, v = venues.find((x) => x.id === o.venueId)!;
    const room = v.rooms.find((r) => r.name === o.roomName) ?? v.rooms.find((r) => r.private) ?? v.rooms[0];
    const min = o.minSpendCents ?? room.minSpendCents[weekday(req.date!)];
    const pol = checkPolicy(company, req, v, { ...o, minSpendCents: min }, leadHours(NOW, req.date!, req.time));
    const why = rejected.get(v.name) ?? (!pol.onPolicy ? pol.violations.join("; ") : req.privateRoom && !room.private ? "not private" : null);
    return { v, roomId: room.id, roomName: room.name, seats: o.capacity ?? room.listedCapacity, min, pol, ai: isAI(e), why, injected: injected.has(v.name), agentPick: proposed?.venueId === v.id };
  });
  cmpSel = new Set(cmpRows.filter((r) => !r.why).slice(0, 3).map((r) => r.v.id));
  btn.disabled = false; cmpRender();
}
function cmpRender() {
  const key: Record<string, (r: Cmp) => number> = { perHead: (r) => r.pol.estimate.perHeadAllInCents, min: (r) => r.min, deposit: (r) => r.pol.depositCents, cancel: (r) => r.v.cancellationHours, seats: (r) => -(r.seats ?? 0) };
  const rows = [...cmpRows].sort((a, b) => Number(!!a.why) - Number(!!b.why) || key[cmpSortKey](a) - key[cmpSortKey](b));
  const th = (k: string, l: string) => `<th class="sortable ${cmpSortKey === k ? "on" : ""}" data-k="${k}">${l}${cmpSortKey === k ? " ↑" : ""}</th>`;
  $("#cmpTable").innerHTML = rows.length ? `<table class="ctable"><thead><tr><th></th><th>Venue</th><th>Room</th>${th("seats", "Seats")}${th("min", "Minimum")}${th("perHead", "Per head")}<th>All-in</th>${th("deposit", "Deposit")}${th("cancel", "Free cancel")}<th>Policy</th></tr></thead><tbody>${rows.map((r) =>
    `<tr class="${r.why ? "dim" : ""} ${cmpSel.has(r.v.id) ? "picked" : ""}"><td><input type="checkbox" data-v="${r.v.id}" ${cmpSel.has(r.v.id) ? "checked" : ""} ${r.why ? "disabled" : ""}></td>
    <td><b>${esc(r.v.name)}</b>${r.agentPick ? ' <span class="pill b">agent’s pick</span>' : ""}${r.injected ? ' <span class="pill r">injection ignored</span>' : ""}${r.ai ? '<span class="ai"></span>' : ""}<div class="cs">${esc(r.v.neighborhood)} · ${esc(r.v.cuisine)}</div></td>
    <td>${esc(r.roomName)}</td><td>${r.seats ?? "—"}</td><td>${usd(r.min)}</td><td><b>${usd(r.pol.estimate.perHeadAllInCents)}</b></td><td>${usd(r.pol.estimate.allInCents)}</td><td>${r.pol.depositCents ? usd(r.pol.depositCents) : "none"}</td><td>${r.v.cancellationHours} h</td>
    <td>${r.why ? `<span class="st bad">${esc(r.why.length > 40 ? r.why.slice(0, 38) + "…" : r.why)}</span>` : `<span class="st ok">${r.pol.requiredRoles.join(" + ")}</span>`}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No offers came back.</div>`;
  $$<HTMLElement>("#cmpTable th.sortable").forEach((t) => t.onclick = () => { cmpSortKey = t.dataset.k!; cmpRender(); });
  $$<HTMLInputElement>("#cmpTable input[type=checkbox]").forEach((c) => c.onchange = () => { if (c.checked) { if (cmpSel.size >= 4) { c.checked = false; return; } cmpSel.add(c.dataset.v!); } else cmpSel.delete(c.dataset.v!); cmpRender(); });
  const pick = rows.filter((r) => cmpSel.has(r.v.id));
  const best = (f: (r: Cmp) => number) => Math.min(...pick.map(f));
  $("#cmpCards").innerHTML = pick.map((r) => `<div class="ccard ${r.agentPick ? "agent" : ""}"><div class="vt">${esc(r.v.name)}</div><div class="vs">${esc(r.roomName)} · ${r.seats ?? "?"} seats</div>
    <div class="cline ${r.pol.estimate.perHeadAllInCents === best((x) => x.pol.estimate.perHeadAllInCents) ? "best" : ""}"><span>Per head</span><b>${usd(r.pol.estimate.perHeadAllInCents)}</b></div>
    <div class="cline ${r.pol.estimate.allInCents === best((x) => x.pol.estimate.allInCents) ? "best" : ""}"><span>All-in</span><b>${usd(r.pol.estimate.allInCents)}</b></div>
    <div class="cline ${r.pol.depositCents === best((x) => x.pol.depositCents) ? "best" : ""}"><span>Deposit</span><b>${r.pol.depositCents ? usd(r.pol.depositCents) : "none"}</b></div>
    <div class="cline ${r.v.cancellationHours === best((x) => x.v.cancellationHours) ? "best" : ""}"><span>Free cancel</span><b>${r.v.cancellationHours} h before</b></div>
    <div class="cline"><span>Approvals</span><b>${r.pol.requiredRoles.join(" + ")}</b></div>${r.v.preferredRatePct ? `<div class="cline best"><span>Preferred rate</span><b>−${r.v.preferredRatePct}%</b></div>` : ""}
    <button class="btn pri" data-pv="${r.v.id}" style="width:100%;margin-top:10px">Propose this one</button><div class="cflow" id="cf_${r.v.id}"></div></div>`).join("") || `<div class="cs">Tick 2–4 offers to compare them side by side.</div>`;
  $$<HTMLButtonElement>("#cmpCards [data-pv]").forEach((b) => b.onclick = async () => {
    const r = cmpRows.find((x) => x.v.id === b.dataset.pv)!; if (!cmpCtx) return; b.remove();
    await proposeAndBook($(`#cf_${r.v.id}`), cmpCtx.store, cmpCtx.world, cmpCtx.runId, r.v, r.roomId, cmpCtx.req.date!, cmpCtx.req.partySize, r.pol, r.min);
  });
}
$("#cmpGo").onclick = () => void cmpLoad();

// =====================================================================
// SEATING: drag guests onto the table, flag dietary needs, send the plan
// =====================================================================
interface LastBooking { venue: Venue; roomName: string; partySize: number; date: string; dietary: string[]; client: string; world: VenueWorld; threadId: string }
let lastBk: LastBooking | null = null, seats: (number | null)[] = [], guests: { name: string; org: string; diet: string | null; host?: boolean }[] = [], dragG: number | null = null;
const NAMES = ["Dana Whitfield", "Marcus Lee", "Jordan Kim", "Alex Chen", "Sam Rivera", "Taylor Brooks", "Morgan Diaz", "Riley Shah", "Casey Moore", "Jamie Fox", "Avery Kim", "Quinn Patel", "Rowan Price", "Elliot Hart", "Harper Cole", "Skyler Wu", "Drew Lane", "Reese Ford", "Parker Gray", "Logan Ruiz"];
function setLastBooking(b: LastBooking) {
  lastBk = b; const n = Math.min(b.partySize, 20), ours = Math.max(2, Math.round(n / 3));
  guests = Array.from({ length: n }, (_, i) => ({ name: NAMES[i] ?? `Guest ${i + 1}`, org: i < ours ? "Northwind" : b.client, diet: null as string | null, host: i === 0 }));
  b.dietary.forEach((d, i) => { const g = guests[ours + i]; if (g) g.diet = d; });
  seats = Array(n).fill(null); seatRender();
}
function seatPos(i: number, n: number) {
  if (i === 0) return [6, 50]; if (i === 1 && n > 1) return [94, 50];
  const k = i - 2, per = Math.ceil((n - 2) / 2), side = k >= per ? 1 : 0, j = side ? per - 1 - (k - per) : k;
  return [16 + (j + 0.5) * (68 / per), side ? 86 : 14];
}
function seatRender() {
  $("#seatEmpty").style.display = lastBk ? "none" : ""; $("#seatWrap").style.display = lastBk ? "" : "none";
  if (!lastBk) return;
  const b = lastBk, n = seats.length;
  $("#seatHead").innerHTML = `<div class="vt">${esc(b.venue.name)} · ${esc(b.roomName)}</div><div class="vs">${b.date} · 7 pm · ${b.partySize} guests${b.partySize > 20 ? " (first 20 shown)" : ""}</div>`;
  const placed = new Set(seats.filter((x) => x !== null));
  $("#seatTable").innerHTML = `<div class="tbl"></div>` + seats.map((g, i) => { const [x, y] = seatPos(i, n), gg = g !== null ? guests[g] : null;
    return `<div class="seat ${gg ? (gg.org === "Northwind" ? "ours" : "theirs") : ""} ${gg?.diet ? "diet" : ""}" data-s="${i}" style="left:${x}%;top:${y}%">${gg ? `<b>${esc(gg.name.split(" ").map((p) => p[0]).join(""))}</b>${gg.diet ? `<i>${gg.diet === "vegetarian" ? "V" : gg.diet[0].toUpperCase()}</i>` : ""}` : `<span>${i + 1}</span>`}</div>`; }).join("");
  $("#guestList").innerHTML = guests.map((g, i) => `<div class="guest ${placed.has(i) ? "placed" : ""} ${g.org === "Northwind" ? "ours" : "theirs"}" draggable="true" data-g="${i}"><b>${esc(g.name)}</b><span>${esc(g.org)}${g.host ? " · host" : ""}</span>
    <button class="dt ${g.diet ? "on" : ""}" data-d="${i}" title="Toggle vegetarian">${g.diet ? "V" : "+diet"}</button></div>`).join("");
  $("#seatStats").innerHTML = `<span class="st ${placed.size === n ? "ok" : "warn"}">${placed.size}/${n} seated</span><span class="st mute">${guests.filter((g) => g.diet).length} dietary</span>`;
  $$<HTMLElement>(".guest").forEach((el2) => {
    el2.addEventListener("dragstart", () => { dragG = Number(el2.dataset.g); });
    el2.addEventListener("click", (e) => { if ((e.target as HTMLElement).classList.contains("dt")) return; const free = seats.indexOf(null); const gi = Number(el2.dataset.g); if (!placed.has(gi) && free >= 0) { seats[free] = gi; seatRender(); } });
  });
  $$<HTMLButtonElement>(".guest .dt").forEach((d) => d.onclick = (e) => { e.stopPropagation(); const g = guests[Number(d.dataset.d)]; g.diet = g.diet ? null : "vegetarian"; seatRender(); });
  $$<HTMLElement>(".seat").forEach((s) => {
    s.addEventListener("dragover", (e) => { e.preventDefault(); s.classList.add("over"); });
    s.addEventListener("dragleave", () => s.classList.remove("over"));
    s.addEventListener("drop", (e) => { e.preventDefault(); if (dragG === null) return; const prev = seats.indexOf(dragG); if (prev >= 0) seats[prev] = null; seats[Number(s.dataset.s)] = dragG; dragG = null; seatRender(); });
    s.addEventListener("click", () => { seats[Number(s.dataset.s)] = null; seatRender(); });
  });
}
$("#seatAuto").onclick = async () => {
  if (!lastBk) return; seats = Array(seats.length).fill(null);
  // Host at the head, then alternate our people and their people so every client sits next to a host.
  const ours = guests.map((g, i) => ({ g, i })).filter((x) => x.g.org === "Northwind").map((x) => x.i), theirs = guests.map((g, i) => ({ g, i })).filter((x) => x.g.org !== "Northwind").map((x) => x.i);
  const order: number[] = []; while (ours.length || theirs.length) { if (theirs.length) order.push(theirs.shift()!); if (ours.length) order.push(ours.shift()!); }
  const hostIdx = order.indexOf(0); if (hostIdx > 0) { order.splice(hostIdx, 1); order.unshift(0); }
  for (let i = 0; i < order.length && i < seats.length; i++) { seats[i] = order[i]; seatRender(); await sleep(70); }
};
$("#seatClear").onclick = () => { seats = Array(seats.length).fill(null); seatRender(); };
$("#seatSend").onclick = async () => {
  if (!lastBk) return; const b = lastBk, seated = seats.filter((x) => x !== null).length;
  if (seated < seats.length) { $("#seatOut").innerHTML = `<div class="gstep bad">Seat everyone first (${seated}/${seats.length}).</div>`; return; }
  const diet = guests.filter((g) => g.diet).map((g) => `${g.name} (${g.diet})`);
  const body = `Hi ${b.venue.name} team,\n\nSeating for our ${b.date} dinner, starting at the head of the table:\n${seats.map((g, i) => `${i + 1}. ${guests[g!].name}`).join("\n")}\n\n${diet.length ? `Dietary: ${diet.join(", ")}.` : "No dietary restrictions."}\n\nThank you,\nConcierge desk for Priya Raman, Northwind Labs`;
  b.world.send(b.venue.id, b.threadId, "Seating plan", body, "answer");
  await mem.remember({ companyId: company.id, scope: "company", ownerUserId: priya.id, subject: b.client, fact: `Seating plan sent to ${b.venue.name} for ${b.date}${diet.length ? `; dietary: ${diet.join(", ")}` : ""}`, source: "seating" });
  void renderMems();
  toast("Seating sent", `${b.venue.name} · ${seats.length} seats${diet.length ? ` · ${diet.length} dietary` : ""}`);
  $("#seatOut").innerHTML = `<div class="gstep ok"><b>Sent to ${esc(b.venue.name)}</b> and saved to company memory.<pre style="margin-top:6px">${esc(body)}</pre></div>`;
};
seatRender();

// =====================================================================
// shared: toasts (what the booker's phone would buzz with)
// =====================================================================
function toast(title: string, body = "", tone: "ok" | "warn" | "bad" = "ok") {
  const t = el("div", `toast ${tone}`, `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ""}<i>now</i>`);
  $("#toasts").prepend(t); [...$("#toasts").children].slice(3).forEach((x) => x.remove()); setTimeout(() => t.classList.add("out"), 5200); setTimeout(() => t.remove(), 5600);
}
srcOf.set(gStore, "Availability");

// =====================================================================
// BOOKINGS: every reservation in this session, with receipt, change and cancel
// =====================================================================
type BkStatus = "confirmed" | "cancelled";
interface BkRow { id: string; status: BkStatus; startsAt: string; partySize: number; proposalId: string; store: MemoryStore; v: Venue; room: Venue["rooms"][number]; src: string; approved: number; paid: number }
const changedTo = new Map<string, string>(), carried = new Map<string, string>(), cancelledHow = new Map<string, string>();
let bkPick: string | null = null, bkFilter = "upcoming";
const paidFor = (st: MemoryStore, id: string): number => st.allPayments().filter((p) => p.bookingId === id).reduce((a, p) => a + p.amountCents, 0) + (carried.has(id) ? paidFor(st, carried.get(id)!) : 0);
async function bkRows(): Promise<BkRow[]> {
  const out: BkRow[] = [];
  for (const st of stores) for (const b of st.allBookings()) {
    const v = venues.find((x) => x.id === b.venueId)!, room = v.rooms.find((r) => r.id === b.roomId)!, p = await st.getProposal(b.proposalId);
    out.push({ id: b.id, status: b.status, startsAt: b.startsAt, partySize: b.partySize, proposalId: b.proposalId, store: st, v, room, src: srcOf.get(st) ?? "Live desk", approved: p?.amountCents ?? 0, paid: paidFor(st, b.id) });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
function receipt(r: BkRow) {
  const d = localDate(r.startsAt), min = r.room.private ? r.room.minSpendCents[weekday(d)] : 0, per = perHeadFor(r.v, "client_dinner");
  const list = Math.max(min, per * r.partySize), disc = Math.round(list * r.v.preferredRatePct / 100), sub = list - disc, tax = Math.round(sub * 0.08875), svc = Math.round(sub * 0.2);
  return { min, per, list, disc, sub, tax, svc, total: sub + tax + svc };
}
async function renderBookings() {
  const rows = await bkRows(), conf = rows.filter((r) => r.status === "confirmed");
  const shown = rows.filter((r) => bkFilter === "all" || (bkFilter === "upcoming" ? r.status === "confirmed" : r.status === "cancelled"));
  $("#bkKpis").innerHTML = `<div class="kpi" style="--c:var(--wine)"><div class="k">Upcoming</div><b>${conf.length}</b></div><div class="kpi" style="--c:var(--sage)"><div class="k">Committed spend</div><b>${usd(conf.reduce((a, r) => a + r.approved, 0))}</b></div><div class="kpi" style="--c:var(--brass)"><div class="k">Deposits paid</div><b>${usd(conf.reduce((a, r) => a + r.paid, 0))}</b></div><div class="kpi" style="--c:#5b6b8c"><div class="k">Guests hosted</div><b>${conf.reduce((a, r) => a + r.partySize, 0)}</b></div>`;
  $("#bkTable").innerHTML = shown.length ? `<table class="ctable"><thead><tr><th>When</th><th>Venue</th><th>Guests</th><th>All-in</th><th>Deposit</th><th>Status</th><th>Booked from</th></tr></thead><tbody>${shown.map((r) => {
    const st = r.status === "confirmed" ? (carried.has(r.id) ? '<span class="st ok">Confirmed · changed</span>' : '<span class="st ok">Confirmed</span>') : changedTo.has(r.id) ? '<span class="st mute">Replaced</span>' : `<span class="st bad">Cancelled${cancelledHow.get(r.id) ? ` · ${cancelledHow.get(r.id)}` : ""}</span>`;
    return `<tr class="bkr ${bkPick === r.id ? "picked" : ""} ${r.status === "cancelled" ? "dim" : ""}" data-id="${r.id}"><td><b>${when(r.startsAt)}</b><div class="cs">${localDate(r.startsAt)}</div></td><td><b>${esc(r.v.name)}</b><div class="cs">${esc(r.room.name)} · ${esc(r.v.neighborhood)}</div></td><td>${r.partySize}</td><td><b>${usd(r.approved)}</b></td><td>${r.paid ? usd(r.paid) : "—"}</td><td>${st}</td><td><span class="pill">${r.src}</span></td></tr>`;
  }).join("")}</tbody></table>` : `<div class="empty">No ${bkFilter === "cancelled" ? "cancelled " : ""}bookings yet. Book one on <a href="#" onclick="go('avail');return false">Availability</a>, <a href="#" onclick="go('compare');return false">Compare</a> or <a href="#" onclick="go('book');return false">Book</a>, or let the Live desk run.</div>`;
  $$<HTMLElement>("#bkTable .bkr").forEach((tr) => tr.onclick = () => { bkPick = tr.dataset.id!; void renderBookings(); });
  const r = rows.find((x) => x.id === bkPick); if (!r) { $("#bkSide").innerHTML = `<div class="cs">Select a booking to see the receipt, change it or cancel it.</div>`; return; }
  const rc = receipt(r), hrs = Math.round((Date.parse(r.startsAt) - Date.parse(NOW)) / 3_600_000), free = hrs >= r.v.cancellationHours;
  $("#bkSide").innerHTML = `<div class="vt">${esc(r.v.name)}</div><div class="vs">${esc(r.room.name)} · ${when(r.startsAt)}, ${localDate(r.startsAt)} · ${r.partySize} guests · <span class="mono">${r.id}</span></div>
    <div class="rcpt"><div><span>${rc.min > rc.per * r.partySize ? `Food &amp; beverage minimum` : `Menu, ${r.partySize} × ${usd(rc.per)}`}</span><b>${usd(rc.list)}</b></div>${rc.disc ? `<div class="g"><span>Preferred rate −${r.v.preferredRatePct}%</span><b>−${usd(rc.disc)}</b></div>` : ""}<div><span>NYC sales tax 8.875%</span><b>${usd(rc.tax)}</b></div><div><span>Service 20%</span><b>${usd(rc.svc)}</b></div><div class="t"><span>Total</span><b>${usd(rc.total)}</b></div><div><span>Deposit paid${carried.has(r.id) ? " (carried over)" : ""}</span><b>${r.paid ? `−${usd(r.paid)}` : "—"}</b></div><div class="t"><span>Balance at the venue</span><b>${usd(Math.max(0, rc.total - r.paid))}</b></div></div>
    ${r.status === "confirmed" ? `<div class="cs" style="margin:8px 0">${free ? `Free cancellation for ${hrs - r.v.cancellationHours} more hours` : `Inside the ${r.v.cancellationHours} h window: the deposit would be forfeited`}</div>
    <div class="seg" id="bkAct"><button data-a="change" class="on">Change</button><button data-a="cancel">Cancel</button></div><div id="bkPane"></div>` : `<div class="cs" style="margin-top:8px">${changedTo.has(r.id) ? `Replaced by <a href="#" data-j="${changedTo.get(r.id)}">${changedTo.get(r.id)}</a>.` : "This booking was cancelled."}</div>`}`;
  $$<HTMLElement>("#bkSide [data-j]").forEach((a) => a.onclick = (e) => { e.preventDefault(); bkPick = a.dataset.j!; bkFilter = "all"; $$("#bkFilter button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.f === "all")); void renderBookings(); });
  if (r.status !== "confirmed") return;
  $$<HTMLButtonElement>("#bkAct button").forEach((b) => b.onclick = () => { $$("#bkAct button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); b.dataset.a === "change" ? bkChange(r) : bkCancel(r, free, hrs); });
  bkChange(r);
}
async function mgmtCtx(st: MemoryStore) { await st.createRun({ id: "changes" }); return toolCtx(st, new VenueWorld(venues, () => "accept", NOW), "changes"); }
function bkChange(r: BkRow) {
  let n = r.partySize, date = localDate(r.startsAt); const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pane = $("#bkPane");
  const draw = () => {
    const min = r.room.private ? r.room.minSpendCents[weekday(date)] : 0;
    const pol = checkPolicy(company, reqFor(n, date, r.room.private), r.v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
    const same = n === r.partySize && date === localDate(r.startsAt), tooBig = n > r.room.listedCapacity, closed = r.v.closedDays.includes(weekday(date));
    const delta = pol.estimate.allInCents - r.approved;
    pane.innerHTML = `<div class="chg"><label>Guests<div class="step"><button data-d="-1">−</button><b>${n}</b><button data-d="1">+</button></div></label>
      <label>Night<select id="bkDate">${[localDate(r.startsAt), ...NIGHTS].filter((d, i, a) => a.indexOf(d) === i).sort().map((d) => `<option value="${d}" ${d === date ? "selected" : ""}>${DAYS3[weekday(d)]} ${Number(d.slice(8))} Nov</option>`).join("")}</select></label></div>
      ${same ? `<div class="cs">Pick a new headcount or night.</div>` : tooBig ? `<div class="gstep bad">${esc(r.room.name)} seats ${r.room.listedCapacity}. A bigger party needs a different room: book it fresh.</div>` : closed ? `<div class="gstep bad">${esc(r.v.name)} is closed that night.</div>` : !pol.onPolicy ? `<div class="gstep bad">${esc(pol.violations.join("; "))}</div>`
        : `<div class="gstep"><b>${usd(r.approved)} → ${usd(pol.estimate.allInCents)}</b> <span class="st ${delta > 0 ? "warn" : "ok"}">${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))}</span><div class="cs">${pol.requiredRoles.map((x) => approverFor(x, priya).name).join(" + ")} must approve. Deposit carries over.</div></div><button class="btn pri" id="bkProp" style="width:100%">Propose this change</button>`}<div id="bkFlow"></div>`;
    $$<HTMLButtonElement>("#bkPane .step button").forEach((b) => b.onclick = () => { n = Math.max(2, Math.min(40, n + Number(b.dataset.d))); draw(); });
    $<HTMLSelectElement>("#bkDate").onchange = (e) => { date = (e.target as HTMLSelectElement).value; draw(); };
    $("#bkProp")?.addEventListener("click", async () => {
      $("#bkProp")!.remove(); const box = $("#bkFlow"), ctxT = await mgmtCtx(r.store), win = eventWindow(date, "19:00");
      const { proposalId } = await call(ctxT, "changes", createProposal, { runId: "changes", actorId: priya.id, principalId: dana.id, venueId: r.v.id, roomId: r.room.id, ...win, partySize: n, kind: "amend", amountCents: pol.estimate.allInCents, payeeId: null, requiredRoles: pol.requiredRoles, summary: `Change ${r.id}: ${n} guests on ${date}`, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(), replacesBookingId: r.id }) as { proposalId: string };
      for (const role of pol.requiredRoles) {
        const ok = await slideIn(box, `Slide to approve as ${approverFor(role, priya).name.split(" ")[0]}`);
        await r.store.decide(proposalId, approverFor(role, priya).id, role, ok ? "approve" : "reject");
        if (!ok) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">Declined. The original booking stands.</div>`); return; }
      }
      try {
        const out = await call(ctxT, "changes", amendBooking, { proposalId }) as { bookingId: string; replaced: string };
        changedTo.set(out.replaced, out.bookingId); carried.set(out.bookingId, out.replaced); bkPick = out.bookingId;
        toast("Booking changed", `${r.v.name} · ${n} guests · ${date}`); renderGrid(); void renderBookings();
      } catch (e) {
        const msg = e instanceof StoreError && e.code === "double_booked" ? `${r.room.name} is already booked that night. The change rolled back; ${r.id} is untouched.` : String(e instanceof Error ? e.message : e);
        box.insertAdjacentHTML("beforeend", `<div class="gstep bad"><b>Refused by the database.</b> ${esc(msg)}</div>`); toast("Change refused", "Original booking kept", "bad");
      }
    });
  };
  draw();
}
function bkCancel(r: BkRow, free: boolean, hrs: number) {
  $("#bkPane").innerHTML = `<div class="gstep ${free ? "" : "bad"}">${free ? `Cancelling now is free: ${r.paid ? `the ${usd(r.paid)} deposit is refunded` : "no deposit was paid"}.` : `The dinner is ${hrs} h away, inside ${esc(r.v.name)}'s ${r.v.cancellationHours} h window. ${r.paid ? `The ${usd(r.paid)} deposit is forfeited.` : ""}`}<div class="cs">The booker approves; a cancellation is a proposal like any other.</div></div><button class="btn" id="bkCx" style="width:100%">Propose cancellation</button><div id="bkFlow"></div>`;
  $("#bkCx").onclick = async () => {
    $("#bkCx").remove(); const box = $("#bkFlow"), ctxT = await mgmtCtx(r.store), win = eventWindow(localDate(r.startsAt), "19:00");
    const { proposalId } = await call(ctxT, "changes", createProposal, { runId: "changes", actorId: priya.id, principalId: dana.id, venueId: r.v.id, roomId: r.room.id, startsAt: r.startsAt, endsAt: win.endsAt, partySize: r.partySize, kind: "cancel", amountCents: 0, payeeId: null, requiredRoles: ["booker"], summary: `Cancel ${r.id}`, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(), replacesBookingId: r.id }) as { proposalId: string };
    const ok = await slideIn(box, "Slide to cancel as Priya");
    await r.store.decide(proposalId, priya.id, "booker", ok ? "approve" : "reject");
    if (!ok) { box.insertAdjacentHTML("beforeend", `<div class="gstep ok">Kept. Nothing changed.</div>`); return; }
    const out = await call(ctxT, "changes", cancelBooking, { proposalId }) as { depositRefundable: boolean };
    cancelledHow.set(r.id, r.paid ? (out.depositRefundable ? "refunded" : "deposit forfeited") : "no charge");
    toast("Booking cancelled", `${r.v.name} · ${cancelledHow.get(r.id)}`, out.depositRefundable ? "ok" : "warn"); renderGrid(); void renderBookings();
  };
}
$$<HTMLButtonElement>("#bkFilter button").forEach((b) => b.onclick = () => { $$("#bkFilter button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); bkFilter = b.dataset.f!; void renderBookings(); });

// =====================================================================
// POLICY: edit the rules, see the impact, replay every request before it ships
// =====================================================================
const BASE_POLICY = structuredClone(COMPANY.policy);
let draft = structuredClone(company.policy);
const KINDS: [keyof typeof draft.perHeadCapCents, string][] = [["client_dinner", "Client dinner"], ["team_dinner", "Team dinner"], ["client_lunch", "Client lunch"], ["happy_hour", "Happy hour"]];
function polSlots(pol: typeof draft) {
  const co = { ...company, policy: pol }; let n = 0;
  for (const v of venues) for (const d of NIGHTS) {
    if (v.closedDays.includes(weekday(d))) continue;
    const room = v.rooms.filter((r) => r.private && r.listedCapacity >= 12).sort((a, b) => a.listedCapacity - b.listedCapacity)[0]; if (!room) continue;
    if (checkPolicy(co, reqFor(12, d, true), v, { minSpendCents: room.minSpendCents[weekday(d)], perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, d, "19:00")).onPolicy) n++;
  }
  return n;
}
function renderPolicy() {
  const row = (id: string, label: string, val: string, min: number, max: number, step: number, v: number, base: string) => `<div class="prow"><label for="${id}">${label}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><b>${val}</b><span class="cs">was ${base}</span></div>`;
  $("#polForm").innerHTML = `<div class="pt">Per-head cap, all-in</div>${KINDS.map(([k, l]) => row(`pc_${k}`, l, usd(draft.perHeadCapCents[k]), 3000, 40000, 500, draft.perHeadCapCents[k], usd(BASE_POLICY.perHeadCapCents[k]))).join("")}
    <div class="pt" style="margin-top:14px">Approvals</div>${row("pm", "Manager signs above", usd(draft.managerApprovalAboveCents), 50000, 800000, 25000, draft.managerApprovalAboveCents, usd(BASE_POLICY.managerApprovalAboveCents))}${row("pf", "Finance signs deposits above", `${draft.financeApprovalDepositAbovePct}%`, 10, 60, 5, draft.financeApprovalDepositAbovePct, `${BASE_POLICY.financeApprovalDepositAbovePct}%`)}${row("pl", "Minimum notice", `${draft.minLeadHours} h`, 0, 96, 6, draft.minLeadHours, `${BASE_POLICY.minLeadHours} h`)}
    <div class="pt" style="margin-top:14px">Blocked venues <span class="cs">tap to toggle</span></div><div class="chips">${venues.map((v) => `<button class="chip ${draft.blockedVenueIds.includes(v.id) ? "blk" : ""}" data-bv="${v.id}">${esc(v.name)}</button>`).join("")}</div>`;
  for (const [k] of KINDS) $<HTMLInputElement>(`#pc_${k}`).oninput = (e) => { draft.perHeadCapCents[k] = Number((e.target as HTMLInputElement).value); renderPolicy(); };
  $<HTMLInputElement>("#pm").oninput = (e) => { draft.managerApprovalAboveCents = Number((e.target as HTMLInputElement).value); renderPolicy(); };
  $<HTMLInputElement>("#pf").oninput = (e) => { draft.financeApprovalDepositAbovePct = Number((e.target as HTMLInputElement).value); renderPolicy(); };
  $<HTMLInputElement>("#pl").oninput = (e) => { draft.minLeadHours = Number((e.target as HTMLInputElement).value); renderPolicy(); };
  $$<HTMLButtonElement>("[data-bv]").forEach((b) => b.onclick = () => { const id = b.dataset.bv!; draft.blockedVenueIds = draft.blockedVenueIds.includes(id) ? draft.blockedVenueIds.filter((x) => x !== id) : [...draft.blockedVenueIds, id]; renderPolicy(); });
  const live = polSlots(company.policy), next = polSlots(draft), dirty = JSON.stringify(draft) !== JSON.stringify(company.policy);
  $("#polImpact").innerHTML = `<div class="big3">${live} <span>→</span> <b class="${next > live ? "up" : next < live ? "down" : ""}">${next}</b></div><div class="cs">bookable private nights for 12 guests across 30 venues and 14 nights</div>
    <div class="row" style="margin-top:12px"><button class="btn" id="polRun">Replay all ${SCENARIOS.length} requests</button><button class="btn pri" id="polApply" ${dirty ? "" : "disabled"}>Apply policy</button><button class="btn" id="polReset">Reset</button></div><div id="polOut"></div>`;
  $("#polApply").onclick = () => { company.policy = structuredClone(draft); renderGrid(); renderPolicy(); toast("Policy applied", "Book, Availability and Compare now use it"); };
  $("#polReset").onclick = () => { draft = structuredClone(BASE_POLICY); renderPolicy(); };
  $("#polRun").onclick = () => void polReplay();
}
const baseRuns = new Map<string, ScenarioRun>();
async function polReplay() {
  const b = $<HTMLButtonElement>("#polRun"); b.disabled = true; const out = $("#polOut"), co = { ...company, policy: structuredClone(draft) };
  const spend = (r: ScenarioRun) => r.result.outcome === "booked" ? r.result.proposals.find((p) => p.kind === "book")?.amountCents ?? 0 : 0;
  const diffs: string[] = []; let bB = 0, bA = 0, sB = 0, sA = 0, invFail2 = 0, mgrB = 0, mgrA = 0;
  for (const [i, s] of SCENARIOS.entries()) {
    out.innerHTML = `<div class="gstep"><span class="spin"></span> Replaying ${i + 1}/${SCENARIOS.length}: “${esc(s.text.slice(0, 60))}”</div>`;
    if (!baseRuns.has(s.id)) baseRuns.set(s.id, await runScenario(s, llm, { ...company, policy: BASE_POLICY }));
    const a = baseRuns.get(s.id)!, z = await runScenario(s, llm, co);
    invFail2 += z.checks.filter((c) => c.kind === "invariant" && !c.pass).length;
    const roles = (r: ScenarioRun) => r.result.proposals.find((p) => p.kind === "book")?.requiredRoles.includes("manager") ? 1 : 0;
    if (a.result.outcome === "booked") bB++; if (z.result.outcome === "booked") bA++; sB += spend(a); sA += spend(z); mgrB += roles(a); mgrA += roles(z);
    if (a.result.outcome !== z.result.outcome || spend(a) !== spend(z)) diffs.push(`<tr><td>“${esc(s.text)}”<div class="cs">${s.id} · ${s.group.replace("_", " ")}${s.order?.length ? ` · venues: ${s.order.slice(0, 3).join(", ").replace(/_/g, " ")}` : ""}</div></td><td>${a.result.outcome.replace(/_/g, " ")}${spend(a) ? ` · ${usd(spend(a))}` : ""}</td><td><b>${z.result.outcome.replace(/_/g, " ")}${spend(z) ? ` · ${usd(spend(z))}` : ""}</b></td></tr>`);
    await sleep(0);
  }
  out.innerHTML = `<div class="kpis" style="margin-top:12px"><div class="kpi" style="--c:var(--sage)"><div class="k">Booked</div><b>${bB} → ${bA}</b></div><div class="kpi" style="--c:var(--brass)"><div class="k">Spend</div><b>${usd(sB)} → ${usd(sA)}</b></div><div class="kpi" style="--c:#5b6b8c"><div class="k">Manager sign-offs</div><b>${mgrB} → ${mgrA}</b></div><div class="kpi" style="--c:var(--rose)"><div class="k">Safety failures</div><b>${invFail2}</b></div></div>
    ${diffs.length ? `<div class="pt" style="margin-top:12px">${diffs.length} request${diffs.length > 1 ? "s" : ""} change</div><div class="ctwrap"><table class="ctable wrap"><thead><tr><th>Request</th><th>Today</th><th>With this policy</th></tr></thead><tbody>${diffs.join("")}</tbody></table></div>` : `<div class="gstep ok">No request changes outcome or spend under this policy.</div>`}`;
  b.disabled = false;
}
renderPolicy();

// =====================================================================
// ⌘K: ask the concierge from anywhere
// =====================================================================
const CMDS: { t: string; sub: string; run: () => void }[] = [
  ...["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex on Nov 19", "team dinner for 8 this Friday under $100 a head", "client lunch for 6 with Initech tomorrow"].map((t) => ({ t, sub: "Ask the concierge", run: () => ask(t) })),
  ...[["home", "Home"], ["chat", "Chat with the concierge"], ["explore", "Explore venues on the map"], ["desk", "Live desk"], ["avail", "Availability"], ["compare", "Compare offers"], ["bookings", "Bookings"], ["calendar", "Calendar"], ["seating", "Seating"], ["policy", "Policy"], ["spend", "Spend"], ["evals", "Evals"]].map(([p, l]) => ({ t: l, sub: "Go to", run: () => go(p) })),
];
function ask(t: string) { go("chat"); void chatSend(t); }
let kSel = 0;
function kRender() {
  const q = $<HTMLInputElement>("#kIn").value.trim().toLowerCase(), list = CMDS.filter((c) => !q || c.t.toLowerCase().includes(q));
  const items = q && !list.some((c) => c.t.toLowerCase() === q) ? [{ t: $<HTMLInputElement>("#kIn").value, sub: "Ask the concierge", run: () => ask($<HTMLInputElement>("#kIn").value) }, ...list] : list;
  kSel = Math.min(kSel, items.length - 1);
  $("#kList").innerHTML = items.map((c, i) => `<div class="ki ${i === kSel ? "on" : ""}" data-i="${i}"><span>${c.sub}</span>${esc(c.t)}</div>`).join("");
  $$<HTMLElement>("#kList .ki").forEach((x) => x.onclick = () => { kClose(); items[Number(x.dataset.i)].run(); });
  return items;
}
function kOpen() { $("#kbar").classList.add("on"); const i = $<HTMLInputElement>("#kIn"); i.value = ""; kSel = 0; kRender(); setTimeout(() => i.focus(), 20); }
function kClose() { $("#kbar").classList.remove("on"); }
$("#kBtn").onclick = kOpen; $("#kbar").onclick = (e) => { if (e.target === $("#kbar")) kClose(); };
$("#kIn").oninput = () => { kSel = 0; kRender(); };
$("#kIn").onkeydown = (e) => { const items = kRender(); if (e.key === "ArrowDown") { kSel = (kSel + 1) % items.length; kRender(); e.preventDefault(); } else if (e.key === "ArrowUp") { kSel = (kSel - 1 + items.length) % items.length; kRender(); e.preventDefault(); } else if (e.key === "Enter" && items[kSel]) { kClose(); items[kSel].run(); } else if (e.key === "Escape") kClose(); };
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); kOpen(); } });

// =====================================================================
// CHAT: the booker's thread with the concierge, including follow-ups after booking
// =====================================================================
const chatStore = new MemoryStore(); await chatStore.init(venues); chatStore.setNow(NOW); stores.push(chatStore); srcOf.set(chatStore, "Chat");
interface ChatCtx { runId: string; world: VenueWorld; bookingId: string; v: Venue; room: Venue["rooms"][number]; n: number; date: string; client: string; dietary: string[] }
let chatCur: ChatCtx | null = null, chatBusy = false, chatN = 0;
const DAY_IDX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const chatLog = () => $("#chatLog");
function chatScroll() { const c = chatLog(); c.scrollTop = c.scrollHeight; }
function msg(who: "me" | "bot", html: string, meta = "") {
  const m = el("div", `cm ${who}`, `<div class="bub">${html}</div>${meta ? `<div class="mt">${meta}</div>` : ""}`); chatLog().append(m); chatScroll(); return m;
}
function typing() { const t = el("div", "cm bot typing", `<div class="bub"><i></i><i></i><i></i></div>`); chatLog().append(t); chatScroll(); return t; }
function chips(list: string[]) {
  $("#chatChips").innerHTML = list.map((c) => `<button class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $$<HTMLButtonElement>("#chatChips .chip").forEach((b) => b.onclick = () => void chatSend(b.dataset.c!));
}
/** A choice card in the thread; resolves with the button the booker taps. */
function choose(html: string, buttons: [string, string, string][]): Promise<string> {
  return new Promise((res) => {
    const card = msg("bot", `${html}<div class="cbtns">${buttons.map(([k, l, cls]) => `<button class="btn ${cls}" data-k="${k}">${l}</button>`).join("")}</div>`);
    card.classList.add("card2");
    card.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.onclick = () => { card.querySelectorAll("button").forEach((x) => x.setAttribute("disabled", "")); b.classList.add("chosen"); res(b.dataset.k!); });
  });
}
function propCard(v: Venue, roomName: string, date: string, n: number, allIn: number, deposit: number, extra = "") {
  return `<div class="pc"><div class="pch"><b>${esc(v.name)}</b><span>${esc(v.neighborhood)} · ${esc(v.cuisine)}</span></div><div class="pcg"><div><span>Room</span><b>${esc(roomName)}</b></div><div><span>When</span><b>${when(eventWindow(date, "19:00").startsAt)}, ${date.slice(5)}</b></div><div><span>Guests</span><b>${n}</b></div><div><span>All-in</span><b>${usd(allIn)}</b></div><div><span>Per head</span><b>${usd(Math.round(allIn / n))}</b></div><div><span>Deposit</span><b>${deposit ? usd(deposit) : "none"}</b></div></div>${extra}</div>`;
}
async function chatSend(text: string) {
  text = text.trim(); if (!text || chatBusy) return; chatBusy = true; $<HTMLInputElement>("#chatIn").value = ""; $("#chatChips").innerHTML = "";
  window.scrollTo({ top: 0 }); msg("me", esc(text), "Priya · now");
  try {
    const t = text.toLowerCase();
    if (chatCur && /\bcancel\b/.test(t)) await chatCancel(chatCur);
    else if (chatCur && /(make it|change it to|now|actually)\s+(\d{1,2})\b|(\d{1,2})\s+(people|guests|of us)/.test(t) && !/dinner for/.test(t)) {
      const m = t.match(/(\d{1,2})/)!; await chatAmend(chatCur, Number(m[1]), chatCur.date);
    } else if (chatCur && /\b(move|change|push|switch).*(sun|mon|tue|wed|thu|fri|sat)/.test(t)) {
      const d = DAY_IDX[t.match(/(sun|mon|tue|wed|thu|fri|sat)/)![1]], date = NIGHTS.find((x) => weekday(x) === d && x !== chatCur!.date) ?? chatCur.date; await chatAmend(chatCur, chatCur.n, date);
    } else if (chatCur && /(vegetarian|vegan|gluten|allerg|nut|shellfish)/.test(t)) await chatDiet(chatCur, text);
    else if (chatCur && /seat/.test(t)) { msg("bot", "Opening the seating chart for this dinner."); setLastBooking({ venue: chatCur.v, roomName: chatCur.room.name, partySize: chatCur.n, date: chatCur.date, dietary: chatCur.dietary, client: chatCur.client, world: chatCur.world, threadId: `thr_${chatCur.runId}_${chatCur.v.id}` }); await sleep(600); go("seating"); }
    else await chatRequest(text);
  } finally { chatBusy = false; }
}
async function chatRequest(text: string) {
  const mix: Behavior[] = ["accept", "counter_price", "accept", "injection", "decline", "accept_slow", "counter_capacity"], seen = new Map<string, Behavior>(), off = chatN++;
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, mix[(seen.size + off) % mix.length]); return seen.get(id)!; }, NOW, 21 + off);
  const work = msg("bot", `<details class="work" open><summary><span class="spin"></span> Working on it</summary><ol></ol></details>`); const ol = work.querySelector("ol")!;
  let chain = Promise.resolve(), steps = 0; const offers = new Map<string, Offer>();
  const onEvent = (e: TraceEvent) => {
    if (e.kind.startsWith("to_booker")) { if (!/Reply approve or reject/.test(e.text)) chain = chain.then(async () => { const ty = typing(); await sleep(700); ty.remove(); msg("bot", esc(e.text), `Concierge · ${e.kind.endsWith("sms") ? "SMS" : "email"}`); }); return; }
    if (e.kind === "proposed") return;
    if (e.kind === "offer" && e.data?.offer) { const o = e.data.offer as Offer; offers.set(o.venueId, o); }
    chain = chain.then(async () => {
      steps++; ol.insertAdjacentHTML("beforeend", `<li class="${AGENT[e.agent] ?? ""}${e.kind === "injection_flagged" ? " bad" : ""}"><b>${e.agent}</b>${isAI(e) ? '<span class="ai"></span>' : ""} ${esc(e.text.replace(/ \((model|rules)(, [\d.]+)?\)$/, "").replace(/_/g, " "))}</li>`);
      work.querySelector("summary")!.innerHTML = `<span class="spin"></span> ${steps} step${steps > 1 ? "s" : ""} · ${esc(e.agent)}`; chatScroll(); await sleep(e.kind === "reply" || e.kind === "offer" ? 380 : 260);
    });
  };
  const depositOf = (v: Venue, p: Proposal) => { const o = offers.get(v.id), d = localDate(p.startsAt), room = v.rooms.find((r) => r.id === p.roomId)!; return checkPolicy(company, reqFor(p.partySize, d, room.private), v, { minSpendCents: o?.minSpendCents ?? (room.private ? room.minSpendCents[weekday(d)] : 0), perHeadCents: o?.perHeadCents ?? null, depositPct: o?.depositPct ?? null, capacity: null }, leadHours(NOW, d, "19:00")).depositCents; };
  const approver: Approver = async (p, st) => {
    await chain; const v = venues.find((x) => x.id === p.venueId)!, room = v.rooms.find((r) => r.id === p.roomId)!;
    if (p.kind === "pay_deposit") { for (const role of p.requiredRoles) await st.decide(p.id, approverFor(role, priya).id, role, "approve"); return "approved"; }
    for (const role of p.requiredRoles) {
      const who = approverFor(role, priya);
      const k = await choose(`${role === "booker" ? "Here's what I'd book:" : `Over ${usd(company.policy.managerApprovalAboveCents)}, so ${esc(who.name)} also signs off.`}${role === "booker" ? propCard(v, room.name, localDate(p.startsAt), p.partySize, p.amountCents, depositOf(v, p)) : ""}`, [["y", role === "booker" ? "Approve" : `Approve as ${esc(who.name.split(" ")[0])}`, "pri"], ["n", "Decline", ""]]);
      await st.decide(p.id, who.id, role, k === "y" ? "approve" : "reject");
      if (k !== "y") return "rejected";
    }
    return "approved";
  };
  const res = await runConcierge({ text, actor: priya, principal: dana, today: "2026-11-09", store: chatStore, world, llm, venues, company, approver, onEvent, shortlistSize: 3 });
  await chain; work.querySelector("details")!.removeAttribute("open"); work.querySelector("summary")!.innerHTML = `✓ ${steps} steps · ${res.trace.filter((e) => e.kind === "offer").length} offers read · ${world.sent().length} emails sent`;
  record(res, world);
  if (res.outcome === "booked" && res.bookingId) {
    const v = venues.find((x) => x.id === res.chosenVenueId)!, bk = (await chatStore.getBooking(res.bookingId))!, room = v.rooms.find((r) => r.id === bk.roomId)!;
    chatCur = { runId: res.runId, world, bookingId: res.bookingId, v, room, n: bk.partySize, date: localDate(bk.startsAt), client: res.request?.clientName ?? "Guests", dietary: res.request?.dietary ?? [] };
    toast("Booked", `${v.name} · ${bk.partySize} guests`); renderGrid();
    chips([`Make it ${bk.partySize + 2 <= room.listedCapacity ? bk.partySize + 2 : bk.partySize - 2} people`, "Move it to Friday", "2 guests are vegetarian", "Arrange seating", "Cancel it"]);
  } else chips(["dinner for 12 with the Acme team next Thursday, somewhere private", "team dinner for 8 this Friday under $100 a head"]);
}
async function chatAmend(c: ChatCtx, n: number, date: string) {
  const min = c.room.private ? c.room.minSpendCents[weekday(date)] : 0;
  const pol = checkPolicy(company, reqFor(n, date, c.room.private), c.v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
  const ty = typing(); await sleep(800); ty.remove();
  if (n > c.room.listedCapacity) { msg("bot", `${esc(c.room.name)} seats ${c.room.listedCapacity}, so ${n} won't fit. Want me to look for a bigger room elsewhere? Just say “private dinner for ${n} …”.`); chips([`Make it ${c.room.listedCapacity} people`, "Cancel it"]); return; }
  if (c.v.closedDays.includes(weekday(date))) { msg("bot", `${esc(c.v.name)} is closed that night.`); chips(["Move it to Thursday", "Cancel it"]); return; }
  if (!pol.onPolicy) { msg("bot", `That breaks policy: ${esc(pol.violations.join("; "))}.`); chips(["Cancel it"]); return; }
  const old = (await chatStore.getProposal((await chatStore.getBooking(c.bookingId))!.proposalId))!.amountCents, delta = pol.estimate.allInCents - old;
  const k = await choose(`${[n !== c.n ? `${c.n} → <b>${n}</b> guests` : "", date !== c.date ? `move to <b>${when(eventWindow(date, "19:00").startsAt)}, ${date.slice(5)}</b>` : ""].filter(Boolean).join(", ").replace(/^./, (x) => x.toUpperCase())}. ${usd(old)} → <b>${usd(pol.estimate.allInCents)}</b> (${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))}). The deposit carries over.`, [["y", "Approve change", "pri"], ["n", "Keep as is", ""]]);
  if (k !== "y") { msg("bot", "Kept as is."); chips(["Arrange seating", "Cancel it"]); return; }
  const ctxT = await mgmtCtx(chatStore), win = eventWindow(date, "19:00");
  const { proposalId } = await call(ctxT, "changes", createProposal, { runId: "changes", actorId: priya.id, principalId: dana.id, venueId: c.v.id, roomId: c.room.id, ...win, partySize: n, kind: "amend", amountCents: pol.estimate.allInCents, payeeId: null, requiredRoles: pol.requiredRoles, summary: `Change ${c.bookingId}`, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(), replacesBookingId: c.bookingId }) as { proposalId: string };
  for (const role of pol.requiredRoles) {
    const who = approverFor(role, priya);
    const ok = role === "booker" ? "y" : await choose(`Over ${usd(company.policy.managerApprovalAboveCents)}, so ${esc(who.name)} also signs off.`, [["y", `Approve as ${esc(who.name.split(" ")[0])}`, "pri"], ["n", "Decline", ""]]);
    await chatStore.decide(proposalId, who.id, role, ok === "y" ? "approve" : "reject");
    if (ok !== "y") { msg("bot", "Not approved, so nothing changed."); chips(["Arrange seating", "Cancel it"]); return; }
  }
  try {
    const out = await call(ctxT, "changes", amendBooking, { proposalId }) as { bookingId: string; replaced: string };
    changedTo.set(out.replaced, out.bookingId); carried.set(out.bookingId, out.replaced);
    c.world.send(c.v.id, `thr_${c.runId}_${c.v.id}`, "Change to our booking", `Hi ${c.v.name} team, could we update our reservation to ${n} guests on ${date} at 7 pm? Thank you.`, "change", { date, time: "19:00", partySize: n, privateRoom: c.room.private, roomId: c.room.id });
    venueReply(c);
    Object.assign(c, { bookingId: out.bookingId, n, date });
    msg("bot", `Done. ${esc(c.v.name)} now has you for <b>${n}</b> on <b>${when(win.startsAt)}</b>. I've emailed the venue.`, "Concierge · confirmed"); toast("Booking changed", `${c.v.name} · ${n} guests · ${date}`); renderGrid();
  } catch (e) {
    msg("bot", e instanceof StoreError && e.code === "double_booked" ? `${esc(c.room.name)} is already taken that night, so the database refused the change. Your original booking is untouched.` : esc(String(e)));
  }
  chips([`Make it ${n + 2 <= c.room.listedCapacity ? n + 2 : n - 2} people`, "Move it to Saturday", "Arrange seating", "Cancel it"]);
}
/** The venue's own answer arrives a little later in the thread, quoted, the way it would in a real inbox. */
function venueReply(c: ChatCtx) {
  setTimeout(() => {
    const r = c.world.advance(3).filter((m) => m.venueId === c.v.id).at(-1); if (!r) return;
    msg("bot", `<div class="vq"><b>${esc(c.v.name)} replied</b>${esc(r.body.split("\n").filter(Boolean).slice(1, 3).join(" ")).slice(0, 260)}</div>`, `Venue email · ${when(r.at)}`);
  }, 2200);
}
async function chatCancel(c: ChatCtx) {
  const hrs = Math.round((Date.parse(eventWindow(c.date, "19:00").startsAt) - Date.parse(NOW)) / 3_600_000), free = hrs >= c.v.cancellationHours;
  const paid = paidFor(chatStore, c.bookingId);
  const k = await choose(`Cancel ${esc(c.v.name)} on ${when(eventWindow(c.date, "19:00").startsAt)}? ${free ? `You're outside the ${c.v.cancellationHours} h window, so ${paid ? `the ${usd(paid)} deposit comes back` : "there's no charge"}.` : `It's ${hrs} h away, inside the ${c.v.cancellationHours} h window: ${paid ? `the ${usd(paid)} deposit is forfeited` : "no deposit was paid"}.`}`, [["y", "Cancel booking", "danger"], ["n", "Keep it", ""]]);
  if (k !== "y") { msg("bot", "Kept."); chips(["Arrange seating"]); return; }
  const ctxT = await mgmtCtx(chatStore), win = eventWindow(c.date, "19:00");
  const { proposalId } = await call(ctxT, "changes", createProposal, { runId: "changes", actorId: priya.id, principalId: dana.id, venueId: c.v.id, roomId: c.room.id, ...win, partySize: c.n, kind: "cancel", amountCents: 0, payeeId: null, requiredRoles: ["booker"], summary: `Cancel ${c.bookingId}`, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(), replacesBookingId: c.bookingId }) as { proposalId: string };
  await chatStore.decide(proposalId, priya.id, "booker", "approve");
  const out = await call(ctxT, "changes", cancelBooking, { proposalId }) as { depositRefundable: boolean };
  cancelledHow.set(c.bookingId, paid ? (out.depositRefundable ? "refunded" : "deposit forfeited") : "no charge");
  c.world.send(c.v.id, `thr_${c.runId}_${c.v.id}`, "Cancellation", `Hi ${c.v.name} team, we need to cancel our ${c.date} reservation. Sorry for the change.`, "cancel", { date: c.date, time: "19:00", partySize: c.n, privateRoom: c.room.private, roomId: c.room.id });
  venueReply(c);
  msg("bot", `Cancelled, and I've let ${esc(c.v.name)} know.`, "Concierge · cancelled"); toast("Booking cancelled", `${c.v.name} · ${cancelledHow.get(c.bookingId)}`, out.depositRefundable ? "ok" : "warn");
  chatCur = null; renderGrid(); chips(["dinner for 12 with the Acme team next Thursday, somewhere private", "client lunch for 6 with Initech tomorrow"]);
}
async function chatDiet(c: ChatCtx, text: string) {
  const n = Number(text.match(/(\d+)/)?.[1] ?? 1), kind = text.toLowerCase().match(/(vegetarian|vegan|gluten|nut|shellfish)/)?.[1] ?? "dietary";
  for (let i = 0; i < n; i++) c.dietary.push(kind === "gluten" ? "gluten-free" : kind === "nut" ? "nut allergy" : kind === "shellfish" ? "shellfish allergy" : kind);
  c.world.send(c.v.id, `thr_${c.runId}_${c.v.id}`, "Dietary needs", `Hi ${c.v.name} team, for our ${c.date} dinner: ${n} guest${n > 1 ? "s" : ""} ${kind === "vegetarian" || kind === "vegan" ? `are ${kind}` : `need ${kind === "gluten" ? "gluten-free" : `${kind}-free`} dishes`}. Thank you.`, "answer");
  await mem.remember({ companyId: company.id, scope: "company", ownerUserId: priya.id, subject: c.client, fact: `${n} ${kind} guest${n > 1 ? "s" : ""} at the ${c.date} dinner (${c.v.name})`, source: "chat" });
  const ty = typing(); await sleep(700); ty.remove();
  msg("bot", `Noted: ${n} ${esc(kind)}. I've told ${esc(c.v.name)} and saved it for ${esc(c.client)} so next time it's in the request automatically.`, "Concierge · venue emailed"); void renderMems();
  chips(["Arrange seating", `Make it ${c.n + 2 <= c.room.listedCapacity ? c.n + 2 : c.n - 2} people`, "Cancel it"]);
}
$<HTMLFormElement>("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); void chatSend($<HTMLInputElement>("#chatIn").value); });
msg("bot", `Hi Priya. Tell me who's coming, when, and anything that matters. I'll find the venue, handle the emails, and only book once you approve.`, "Concierge");
chips(["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex on Nov 19", "team dinner for 8 this Friday under $100 a head", "japanese dinner for 8 with Wayne Enterprises on Nov 24, private"]);

// =====================================================================
// CALENDAR: drag a dinner to another night; the move is an approved amendment
// =====================================================================
function modal(html: string, buttons: [string, string, string][], cls = ""): Promise<string> {
  return new Promise((res) => {
    const m = el("div", "modal", `<div class="mbox ${cls}">${html}<div class="cbtns">${buttons.map(([k, l, c]) => `<button class="btn ${c}" data-k="${k}">${l}</button>`).join("")}</div></div>`);
    document.body.append(m);
    const done = (k: string) => { m.remove(); res(k); };
    m.querySelectorAll<HTMLButtonElement>("[data-k]").forEach((b) => b.onclick = () => done(b.dataset.k!));
    m.onclick = (e) => { if (e.target === m) done("n"); };
  });
}
const CAL_DAYS = Array.from({ length: 21 }, (_, i) => addDays("2026-11-09", i));
let calPick: string | null = null;
async function renderCal() {
  const rows = (await bkRows()).filter((r) => r.status === "confirmed");
  const MON = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  $("#calGrid").innerHTML = MON.map((d) => `<div class="calh">${d}</div>`).join("") + CAL_DAYS.map((d) => {
    const inRange = NIGHTS.includes(d), today = d === "2026-11-09", list = rows.filter((r) => localDate(r.startsAt) === d);
    return `<div class="cald ${inRange ? "" : "off"} ${today ? "today" : ""}" data-d="${d}"><div class="caln">${Number(d.slice(8))}${today ? " · today" : ""}</div>${list.map((r) =>
      `<div class="calb ${calPick === r.id ? "pick" : ""}" draggable="true" data-id="${r.id}" style="--c:${["#7b1e3a", "#3f7d5a", "#5b6b8c", "#8a6212", "#a8502f"][venues.indexOf(r.v) % 5]}"><b>${esc(r.v.name)}</b><span>${r.partySize} · ${usd(r.approved)}</span></div>`).join("")}${inRange && !list.length ? `<button class="caladd" data-d="${d}">+ dinner</button>` : ""}</div>`;
  }).join("");
  $("#calHint").textContent = calPick ? "Now tap the night to move it to." : rows.length ? "Drag a dinner to another night (or tap it, then tap a night)." : "No dinners yet. Tap + on any night to book one.";
  $$<HTMLElement>(".calb").forEach((b) => {
    b.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/plain", b.dataset.id!); b.classList.add("drag"); });
    b.addEventListener("dragend", () => b.classList.remove("drag"));
    b.addEventListener("click", (e) => { e.stopPropagation(); calPick = calPick === b.dataset.id ? null : b.dataset.id!; void renderCal(); });
  });
  $$<HTMLElement>(".cald:not(.off)").forEach((c) => {
    c.addEventListener("dragover", (e) => { e.preventDefault(); c.classList.add("over"); });
    c.addEventListener("dragleave", () => c.classList.remove("over"));
    c.addEventListener("drop", (e) => { e.preventDefault(); c.classList.remove("over"); void calMove(e.dataTransfer!.getData("text/plain"), c.dataset.d!); });
    c.addEventListener("click", () => { if (calPick) { const id = calPick; calPick = null; void calMove(id, c.dataset.d!); } });
  });
  $$<HTMLButtonElement>(".caladd").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const d = b.dataset.d!; go("chat"); void chatSend(`private dinner for 12 with Acme on Nov ${Number(d.slice(8))}`); });
}
async function calMove(id: string, date: string) {
  const r = (await bkRows()).find((x) => x.id === id); if (!r || localDate(r.startsAt) === date) return void renderCal();
  const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], label = `${DAYS3[weekday(date)]} Nov ${Number(date.slice(8))}`;
  const shake = (msg: string) => { toast("Can't move it", msg, "bad"); $(`.cald[data-d="${date}"]`)?.classList.add("no"); setTimeout(() => void renderCal(), 600); };
  if (r.v.closedDays.includes(weekday(date))) return shake(`${r.v.name} is closed on ${DAYS3[weekday(date)]}s`);
  const min = r.room.private ? r.room.minSpendCents[weekday(date)] : 0;
  const pol = checkPolicy(company, reqFor(r.partySize, date, r.room.private), r.v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
  if (!pol.onPolicy) return shake(pol.violations.join("; "));
  const delta = pol.estimate.allInCents - r.approved;
  const k = await modal(`<div class="vt">Move ${esc(r.v.name)}?</div><div class="vs">${esc(r.room.name)} · ${r.partySize} guests</div>
    <div class="mv"><div><span>From</span><b>${when(r.startsAt)}, Nov ${Number(localDate(r.startsAt).slice(8))}</b></div><i>→</i><div><span>To</span><b>${label}, 7 pm</b></div></div>
    <div class="rcpt"><div><span>All-in now</span><b>${usd(r.approved)}</b></div><div><span>All-in on ${label}</span><b>${usd(pol.estimate.allInCents)}</b></div><div class="t"><span>Difference</span><b class="${delta > 0 ? "up" : "dn"}">${delta >= 0 ? "+" : "−"}${usd(Math.abs(delta))}</b></div></div>
    <div class="cs" style="margin-top:8px">${pol.requiredRoles.map((x) => approverFor(x, priya).name).join(" + ")} approve${pol.requiredRoles.length > 1 ? "" : "s"}. Cancel and rebook happen in one transaction; if the room is taken, nothing changes.</div>`,
    [["y", "Approve move", "pri"], ["n", "Keep it", ""]]);
  if (k !== "y") return void renderCal();
  const ctxT = await mgmtCtx(r.store), win = eventWindow(date, "19:00");
  const { proposalId } = await call(ctxT, "changes", createProposal, { runId: "changes", actorId: priya.id, principalId: dana.id, venueId: r.v.id, roomId: r.room.id, ...win, partySize: r.partySize, kind: "amend", amountCents: pol.estimate.allInCents, payeeId: null, requiredRoles: pol.requiredRoles, summary: `Move ${r.id} to ${date}`, expiresAt: new Date(Date.parse(NOW) + 48 * 3_600_000).toISOString(), replacesBookingId: r.id }) as { proposalId: string };
  for (const role of pol.requiredRoles) await r.store.decide(proposalId, approverFor(role, priya).id, role, "approve");
  try {
    const out = await call(ctxT, "changes", amendBooking, { proposalId }) as { bookingId: string; replaced: string };
    changedTo.set(out.replaced, out.bookingId); carried.set(out.bookingId, out.replaced);
    toast("Moved", `${r.v.name} → ${label}`); renderGrid(); void renderCal();
  } catch (e) {
    shake(e instanceof StoreError && e.code === "double_booked" ? `${r.room.name} is already booked on ${label}. The database rolled it back; your dinner stays put.` : String(e));
  }
}

// =====================================================================
// EXPLORE: the venue network on a map you can pan, zoom and filter; shortlist, then RFP
// =====================================================================
const XB: Record<string, [number, number, number, number]> = { Midtown: [60, 10, 160, 58], Chelsea: [20, 76, 92, 56], Flatiron: [120, 76, 100, 56], "West Village": [20, 140, 92, 56], SoHo: [120, 140, 100, 56], Tribeca: [20, 204, 92, 56], "Financial District": [120, 204, 100, 70], Williamsburg: [262, 110, 74, 96] };
const xPos = new Map<string, [number, number]>();
{ const per: Record<string, number> = {}; for (const v of venues) { const [x, y, w, h] = XB[v.neighborhood], k = per[v.neighborhood] = (per[v.neighborhood] ?? 0) + 1, cols = Math.max(2, Math.floor((w - 16) / 22)); xPos.set(v.id, [x + 14 + ((k - 1) % cols) * 22, y + 28 + Math.floor((k - 1) / cols) * Math.min(18, (h - 32) / 2)]); } }
const CUISINES = [...new Set(venues.map((v) => v.cuisine))].sort();
const xF = { n: 12, date: NIGHTS[3], priv: true, cuisines: new Set<string>(), hoods: new Set<string>(), maxHead: 25000, sort: "fit" };
let xView = { x: 0, y: 0, w: 340, h: 290 }, xHover: string | null = null, xOpen: string | null = null;
const xShort = new Set<string>();
function xFit(v: Venue) {
  const d = xF.date, wd = weekday(d);
  if (company.policy.blockedVenueIds.includes(v.id)) return { k: "blocked" as const, why: "blocked by policy" };
  if (v.closedDays.includes(wd)) return { k: "closed" as const, why: "closed that night" };
  const room = v.rooms.filter((r) => (xF.priv ? r.private : true) && r.listedCapacity >= xF.n).sort((a, b) => a.listedCapacity - b.listedCapacity)[0];
  if (!room) return { k: "noroom" as const, why: `no ${xF.priv ? "private " : ""}room for ${xF.n}` };
  const min = room.private ? room.minSpendCents[wd] : 0;
  const pol = checkPolicy(company, reqFor(xF.n, d, xF.priv), v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, d, "19:00"));
  const ph = pol.estimate.perHeadAllInCents;
  return { k: !pol.onPolicy ? "over" as const : ph > xF.maxHead ? "budget" as const : pol.requiredRoles.includes("manager") ? "mgr" as const : "ok" as const, room, min, pol, ph, why: pol.onPolicy ? "" : pol.violations[0] };
}
const xPass = (v: Venue) => (!xF.cuisines.size || xF.cuisines.has(v.cuisine)) && (!xF.hoods.size || xF.hoods.has(v.neighborhood));
const XCOL: Record<string, string> = { ok: "#3f7d5a", mgr: "#c98a12", over: "#c9b8a4", budget: "#c9b8a4", noroom: "#e6dccd", closed: "#e6dccd", blocked: "#c2455d" };
function renderExplore() {
  const all = venues.map((v) => ({ v, f: xFit(v), pass: xPass(v) }));
  const shown = all.filter((x) => x.pass);
  // map
  let s = `<rect x="232" y="-50" width="22" height="400" fill="#e4ecf2"/><text x="243" y="150" font-family="Inter" font-size="7" fill="#9fb3c4" transform="rotate(90 243 150)" letter-spacing=".2em">EAST RIVER</text>`;
  for (const [h, [x, y, w, hh]] of Object.entries(XB)) s += `<g class="hood ${xF.hoods.has(h) ? "on" : ""}" data-h="${h}"><rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="8"/><text x="${x + 7}" y="${y + 14}">${(h === "Financial District" ? "FIDI" : h === "Williamsburg" ? "WILLIAMSBURG" : h).toUpperCase()}</text></g>`;
  const [ox, oy] = [XB.Flatiron[0] + XB.Flatiron[2] - 10, XB.Flatiron[1] + 10];
  s += `<g class="office"><rect x="${ox - 5}" y="${oy - 5}" width="10" height="10" rx="2"/><text x="${ox + 6}" y="${oy - 8}" text-anchor="end">Northwind HQ</text></g>`;
  for (const { v, f, pass } of all) {
    const [x, y] = xPos.get(v.id)!, ok = f.k === "ok" || f.k === "mgr", cap = "room" in f && f.room ? f.room.listedCapacity : 8;
    s += `<g class="xpin ${pass ? "" : "dim"} ${xHover === v.id || xOpen === v.id ? "hot" : ""} ${xShort.has(v.id) ? "short" : ""}" data-v="${v.id}" transform="translate(${x} ${y})"><circle r="${ok ? 4 + Math.min(4, cap / 8) : 4}" fill="${pass ? XCOL[f.k] : "#eee6da"}"/>${xShort.has(v.id) ? `<circle r="${ok ? 8 + Math.min(4, cap / 8) : 8}" class="ring2"/>` : ""}${ok && pass ? `<text y="-8">$${Math.round(f.ph! / 100)}</text>` : ""}</g>`;
  }
  $("#xMap").setAttribute("viewBox", `${xView.x} ${xView.y} ${xView.w} ${xView.h}`); $("#xMap").innerHTML = s;
  // list
  const ord = [...shown].sort((a, b) => {
    const rank = (x: typeof a) => ({ ok: 0, mgr: 1, budget: 2, over: 3, noroom: 4, closed: 5, blocked: 6 })[x.f.k];
    if (xF.sort === "price") return ((a.f as { ph?: number }).ph ?? 1e9) - ((b.f as { ph?: number }).ph ?? 1e9);
    if (xF.sort === "name") return a.v.name.localeCompare(b.v.name);
    return rank(a) - rank(b) || ((a.f as { ph?: number }).ph ?? 0) - ((b.f as { ph?: number }).ph ?? 0);
  });
  const fit = shown.filter((x) => x.f.k === "ok" || x.f.k === "mgr").length;
  $("#xCount").innerHTML = `<b>${fit}</b> of ${shown.length} venues fit · ${xF.n} guests · ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(xF.date)]} Nov ${Number(xF.date.slice(8))}`;
  $("#xList").innerHTML = ord.map(({ v, f }) => { const ok = f.k === "ok" || f.k === "mgr";
    return `<div class="xr ${ok ? "" : "no"} ${xHover === v.id ? "hot" : ""} ${xOpen === v.id ? "open" : ""}" data-v="${v.id}"><i style="background:${XCOL[f.k]}"></i><div><b>${esc(v.name)}</b><span>${esc(v.neighborhood)} · ${esc(v.cuisine)}${v.preferredRatePct ? ` · <em>−${v.preferredRatePct}%</em>` : ""}</span></div>
      <div class="xp">${ok ? `<b>${usd(f.ph!)}</b><span>per head</span>` : `<span>${esc(f.why)}</span>`}</div><button class="heart ${xShort.has(v.id) ? "on" : ""}" data-h="${v.id}" ${ok ? "" : "disabled"} title="Shortlist">♥</button></div>`; }).join("");
  // shortlist tray
  $("#xTray").innerHTML = xShort.size ? `<div class="xchips">${[...xShort].map((id) => `<span class="pill">${esc(venues.find((v) => v.id === id)!.name)} <a data-x="${id}">×</a></span>`).join("")}</div><button class="btn pri" id="xRfp">Send RFP to ${xShort.size} venue${xShort.size > 1 ? "s" : ""} →</button>` : `<span class="cs">Tap ♥ on up to 6 venues, then send them one request for proposal.</span>`;
  wireExplore();
}
function wireExplore() {
  const hover = (id: string | null) => { if (xHover === id) return; xHover = id; $$(".xpin").forEach((p) => p.classList.toggle("hot", (p as HTMLElement).dataset.v === id || (p as HTMLElement).dataset.v === xOpen)); $$(".xr").forEach((r) => r.classList.toggle("hot", (r as HTMLElement).dataset.v === id)); };
  $$<HTMLElement>(".xr").forEach((r) => { r.onmouseenter = () => hover(r.dataset.v!); r.onmouseleave = () => hover(null); r.onclick = (e) => { if ((e.target as HTMLElement).closest(".heart")) return; xOpen = r.dataset.v!; renderExplore(); void xDrawer(); }; });
  $$<SVGGElement>(".xpin").forEach((p) => { p.onmouseenter = () => hover(p.dataset.v!); p.onmouseleave = () => hover(null); p.onclick = () => { xOpen = p.dataset.v!; renderExplore(); void xDrawer(); $(`.xr[data-v="${xOpen}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }; });
  $$<SVGGElement>(".hood").forEach((h) => h.onclick = () => { const n = h.dataset.h!; xF.hoods.has(n) ? xF.hoods.delete(n) : xF.hoods.add(n); renderHoodChips(); renderExplore(); });
  $$<HTMLButtonElement>(".heart").forEach((b) => b.onclick = () => { const id = b.dataset.h!; if (xShort.has(id)) xShort.delete(id); else if (xShort.size < 6) xShort.add(id); else toast("Shortlist is full", "Six venues per request", "warn"); renderExplore(); if (xOpen) void xDrawer(); });
  $$<HTMLElement>("#xTray [data-x]").forEach((a) => a.onclick = () => { xShort.delete(a.dataset.x!); renderExplore(); });
  $("#xRfp")?.addEventListener("click", () => void xRfp());
}
function renderHoodChips() { $("#xHoods").innerHTML = Object.keys(XB).map((h) => `<button class="chip ${xF.hoods.has(h) ? "on" : ""}" data-hh="${h}">${h}</button>`).join(""); $$<HTMLButtonElement>("[data-hh]").forEach((b) => b.onclick = () => { const n = b.dataset.hh!; xF.hoods.has(n) ? xF.hoods.delete(n) : xF.hoods.add(n); renderHoodChips(); renderExplore(); }); }
async function xDrawer() {
  if (!xOpen) { $("#xDrawer").classList.remove("on"); return; }
  const v = venues.find((x) => x.id === xOpen)!, f = xFit(v), L = await learned(v.id), ok = f.k === "ok" || f.k === "mgr";
  const fq = (r: Venue["rooms"][number]) => Math.min(100, Math.round((xF.n / r.listedCapacity) * 100));
  $("#xDrawer").classList.add("on");
  $("#xDrawer").innerHTML = `<button class="xclose" id="xClose">×</button><div class="vt">${esc(v.name)}</div><div class="vs">${esc(v.neighborhood)} · ${esc(v.cuisine)} · menu ${usd(v.perHeadCents)} a head</div>
    <div>${ok ? `<span class="pill g">Fits · ${usd(f.ph!)}/head</span>` : `<span class="pill r">${esc(f.why)}</span>`}${v.preferredRatePct ? `<span class="pill y">Preferred −${v.preferredRatePct}%</span>` : ""}${v.contractRequired ? `<span class="pill">Contract</span>` : ""}${L.inj ? `<span class="pill r">Injection seen</span>` : ""}</div>
    <div class="pt" style="margin-top:12px">Rooms for ${xF.n}</div>${v.rooms.map((r) => `<div class="xroom ${r.listedCapacity < xF.n ? "small" : ""}"><div><b>${esc(r.name)}</b>${r.private ? '<span class="pill">private</span>' : ""}<span class="cs">${L.cap.has(r.id) ? `<s>${r.listedCapacity}</s> really ${L.cap.get(r.id)}` : r.listedCapacity} seats · min ${r.private ? usd(r.minSpendCents[weekday(xF.date)]) : "none"}</span></div><div class="bar2"><i style="width:${fq(r)}%"></i></div></div>`).join("")}
    <dl class="kv" style="margin-top:10px"><dt>Deposit</dt><dd>${v.depositPct}%</dd><dt>Free cancel</dt><dd>${v.cancellationHours} h before</dd><dt>Closed</dt><dd>${v.closedDays.length ? v.closedDays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ") : "never"}</dd><dt>Reply time</dt><dd>${L.replies.length ? `~${Math.round(L.replies.reduce((a, b) => a + b, 0) / L.replies.length)} h (learned)` : "not seen yet"}</dd></dl>
    <div class="row" style="margin-top:12px"><button class="btn ${xShort.has(v.id) ? "" : "pri"}" id="xHeart" ${ok ? "" : "disabled"}>${xShort.has(v.id) ? "Remove from shortlist" : "♥ Shortlist"}</button><button class="btn" id="xBook" ${ok ? "" : "disabled"}>Book via chat</button></div>`;
  $("#xClose").onclick = () => { xOpen = null; renderExplore(); void xDrawer(); };
  $("#xHeart").onclick = () => { xShort.has(v.id) ? xShort.delete(v.id) : xShort.size < 6 && xShort.add(v.id); renderExplore(); void xDrawer(); };
  $("#xBook").onclick = () => { go("chat"); void chatSend(`${xF.priv ? "private " : ""}dinner for ${xF.n} with Acme on Nov ${Number(xF.date.slice(8))} at ${v.name}`); };
}
async function xRfp() {
  const btn = $<HTMLButtonElement>("#xRfp"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Emailing ${xShort.size} venues…`;
  const store = new MemoryStore(); await store.init(venues); store.setNow(NOW); stores.push(store); srcOf.set(store, "Explore");
  const runId = `rfp_${Math.random().toString(36).slice(2, 7)}`; await store.createRun({ id: runId });
  const mix: Behavior[] = ["accept", "counter_price", "injection", "accept", "decline", "accept"], ids = [...xShort], beh = new Map(ids.map((id, i) => [id, mix[i % mix.length]]));
  const world = new VenueWorld(venues, (id) => beh.get(id) ?? "accept", NOW, 41 + ids.length);
  const req = reqFor(xF.n, xF.date, xF.priv), ctxT = toolCtx(store, world, runId), inj = injection(llm);
  for (const id of ids) { const v = venues.find((x) => x.id === id)!; await call(ctxT, "explore", sendVenueEmail, { venueId: id, threadId: `thr_${runId}_${id}`, kind: "inquiry", body: `Hello ${v.name} team, could you host ${xF.n} guests${xF.priv ? " in a private room" : ""} on ${xF.date} at 7 pm for Northwind Labs?`, meta: { date: xF.date, time: "19:00", partySize: xF.n, privateRoom: xF.priv } }); }
  const replies = world.advance(6), rows: Cmp[] = [];
  for (const id of ids) {
    const v = venues.find((x) => x.id === id)!, r = replies.find((m) => m.venueId === id);
    if (!r) continue;
    const tri = await replyTriage(llm).classify(r.body); if (tri.label === "decline") { toast(`${v.name} declined`, "Fully committed that night", "warn"); continue; }
    const { offer, decidedBy } = await extractOffer(llm, r.body, v, r.id, "2026-11-09", true);
    const fit = xFit(v), rm = v.rooms.find((x) => x.name === offer.roomName) ?? ("room" in fit && fit.room ? fit.room : v.rooms[0]), min = offer.minSpendCents ?? (rm.private ? rm.minSpendCents[weekday(xF.date)] : 0);
    const pol = checkPolicy(company, req, v, { ...offer, minSpendCents: min }, leadHours(NOW, xF.date, "19:00"));
    const injected = (await inj.classify(r.body)).label === "injection";
    rows.push({ v, roomId: rm.id, roomName: rm.name, seats: offer.capacity ?? rm.listedCapacity, min, pol, ai: decidedBy === "model", why: pol.onPolicy ? (xF.priv && !rm.private ? "not private" : null) : pol.violations.join("; "), injected, agentPick: false });
  }
  const best = rows.filter((r) => !r.why).sort((a, b) => a.pol.estimate.perHeadAllInCents - b.pol.estimate.perHeadAllInCents)[0]; if (best) best.agentPick = true;
  cmpRows = rows; cmpSel = new Set(rows.filter((r) => !r.why).slice(0, 4).map((r) => r.v.id)); cmpCtx = { store, world, runId, req };
  $<HTMLInputElement>("#cmpAsk").value = `${xF.priv ? "private " : ""}dinner for ${xF.n} on ${xF.date} (RFP to your shortlist)`;
  xShort.clear(); renderExplore(); go("compare"); cmpRender(); toast("Offers are in", `${rows.length} replies read · cheapest marked`);
}
// filters
$<HTMLInputElement>("#xN").oninput = (e) => { xF.n = Number((e.target as HTMLInputElement).value); $("#xNv").textContent = String(xF.n); renderExplore(); void xDrawer(); };
$<HTMLInputElement>("#xMax").oninput = (e) => { xF.maxHead = Number((e.target as HTMLInputElement).value); $("#xMaxv").textContent = usd(xF.maxHead); renderExplore(); void xDrawer(); };
$<HTMLInputElement>("#xPriv").onchange = (e) => { xF.priv = (e.target as HTMLInputElement).checked; renderExplore(); void xDrawer(); };
$("#xDate").innerHTML = NIGHTS.map((d) => `<option value="${d}" ${d === xF.date ? "selected" : ""}>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(d)]} Nov ${Number(d.slice(8))}</option>`).join("");
$<HTMLSelectElement>("#xDate").onchange = (e) => { xF.date = (e.target as HTMLSelectElement).value; renderExplore(); void xDrawer(); };
$("#xCuis").innerHTML = CUISINES.map((c) => `<button class="chip" data-cu="${c}">${c}</button>`).join("");
$$<HTMLButtonElement>("[data-cu]").forEach((b) => b.onclick = () => { const c = b.dataset.cu!; xF.cuisines.has(c) ? xF.cuisines.delete(c) : xF.cuisines.add(c); b.classList.toggle("on"); renderExplore(); });
$$<HTMLButtonElement>("#xSort button").forEach((b) => b.onclick = () => { $$("#xSort button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); xF.sort = b.dataset.s!; renderExplore(); });
// pan and zoom
{
  const svg = $("#xMap") as unknown as SVGSVGElement; let drag: { x: number; y: number; vx: number; vy: number } | null = null;
  const clamp = () => { xView.w = Math.max(80, Math.min(340, xView.w)); xView.h = xView.w * 290 / 340; xView.x = Math.max(-20, Math.min(360 - xView.w, xView.x)); xView.y = Math.max(-20, Math.min(310 - xView.h, xView.y)); svg.setAttribute("viewBox", `${xView.x} ${xView.y} ${xView.w} ${xView.h}`); };
  const zoom = (f: number, cx = 0.5, cy = 0.5) => { const nw = xView.w * f, nh = nw * 290 / 340; xView.x += (xView.w - nw) * cx; xView.y += (xView.h - nh) * cy; xView.w = nw; clamp(); };
  svg.addEventListener("wheel", (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoom(e.deltaY > 0 ? 1.15 : 0.87, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }, { passive: false });
  svg.addEventListener("pointerdown", (e) => { if ((e.target as Element).closest(".xpin,.hood")) return; drag = { x: e.clientX, y: e.clientY, vx: xView.x, vy: xView.y }; svg.setPointerCapture(e.pointerId); svg.classList.add("grab"); });
  svg.addEventListener("pointermove", (e) => { if (!drag) return; const r = svg.getBoundingClientRect(); xView.x = drag.vx - (e.clientX - drag.x) * xView.w / r.width; xView.y = drag.vy - (e.clientY - drag.y) * xView.h / r.height; clamp(); });
  svg.addEventListener("pointerup", () => { drag = null; svg.classList.remove("grab"); });
  $("#xIn").onclick = () => zoom(0.75); $("#xOut").onclick = () => zoom(1.33); $("#xReset").onclick = () => { xView = { x: 0, y: 0, w: 340, h: 290 }; clamp(); };
}
renderHoodChips(); renderExplore();


// =====================================================================
// shared: the real email threads, a calendar invite, and an email you send yourself
// =====================================================================
function showThreads(world: VenueWorld, title: string, venueId?: string) {
  const msgs = [...world.sent(), ...world.received()].filter((m) => !venueId || m.venueId === venueId).sort((a, b) => a.at.localeCompare(b.at) || (a.direction === "out" ? -1 : 1));
  const bad = (b: string) => /SYSTEM NOTE|ignore (all )?previous|routing \d|wire the/i.test(b);
  void modal(`<div class="vt">${esc(title)}</div><div class="vs">${msgs.length} email${msgs.length === 1 ? "" : "s"} · exactly what the agent sent and received</div><div class="mail">${msgs.map((m) => {
    const v = venues.find((x) => x.id === m.venueId)!;
    return `<div class="mm ${m.direction} ${m.direction === "in" && bad(m.body) ? "inj" : ""}"><div class="mmh"><span><b>${m.direction === "out" ? "Concierge → " + esc(v.name) : esc(v.name) + " → Concierge"}</b> · ${esc(m.subject)}</span><span>${when(m.at)}</span></div><pre>${esc(m.body)}</pre>${m.direction === "in" && bad(m.body) ? `<div class="mmh" style="background:#fbeef0;color:#a3203c"><b style="color:#a3203c">⚠ Instructions in this email were treated as data and ignored.</b></div>` : ""}</div>`;
  }).join("") || '<div class="empty">No emails yet.</div>'}</div>`, [["n", "Close", ""]], "wide");
}
function downloadIcs(v: Venue, roomName: string, startsAt: string, n: number) {
  const f = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(Date.parse(startsAt) + 3 * 3_600_000).toISOString();
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Thursday Dinner Concierge//EN", "BEGIN:VEVENT", `UID:${Date.now()}-${Math.random().toString(36).slice(2)}@thursday-dinner`, `DTSTAMP:${f(new Date().toISOString())}`,
    `DTSTART:${f(startsAt)}`, `DTEND:${f(end)}`, `SUMMARY:Dinner at ${v.name} (${n} guests)`, `LOCATION:${v.name}\\, ${v.neighborhood}\\, New York`, `DESCRIPTION:${roomName}. Booked by the concierge (demo).`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = `dinner-${v.name.toLowerCase().replace(/[^a-z]+/g, "-")}.ics`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Calendar invite saved", "Open it to add the dinner to your calendar");
}
function mailtoFor(v: Venue, roomName: string, startsAt: string, n: number, allIn: number) {
  const body = `Dinner is booked.\n\n${v.name} · ${roomName}\n${when(startsAt)}, ${localDate(startsAt)}\n${n} guests · about ${usd(allIn)} all-in\n\nBooked by the concierge.`;
  return `mailto:?subject=${encodeURIComponent(`Booked: ${v.name}, ${localDate(startsAt)}`)}&body=${encodeURIComponent(body)}`;
}

// =====================================================================
// HOME: one sentence in; the agents work across the city; you approve on your phone
// =====================================================================
const HQ: [number, number] = [XB.Flatiron[0] + XB.Flatiron[2] - 10, XB.Flatiron[1] + 10];
const vByName = (t: string) => venues.filter((v) => t.startsWith(v.name) || t.includes(` ${v.name}`) || t.includes(`${v.name},`) || t.includes(`${v.name}'s`)).sort((a, b) => b.name.length - a.name.length)[0];
let hBusy = false, hRuns = 0, hWorld: VenueWorld | null = null;
const SVGNS = "http://www.w3.org/2000/svg";
function hMap() {
  let s = `<defs><radialGradient id="hglow"><stop offset="0" stop-color="#c98a12" stop-opacity=".55"/><stop offset="1" stop-color="#c98a12" stop-opacity="0"/></radialGradient></defs><rect x="232" y="-60" width="22" height="420" fill="#e4ecf2"/>`;
  for (const [h, [x, y, w, hh]] of Object.entries(XB)) s += `<g class="hhood"><rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="8"/><text x="${x + 7}" y="${y + 13}">${(h === "Financial District" ? "FIDI" : h).toUpperCase()}</text></g>`;
  s += `<g id="hLines"></g>`;
  for (const v of venues) { const [x, y] = xPos.get(v.id)!; s += `<g class="hp" id="hp_${v.id}" transform="translate(${x} ${y})"><circle class="halo" r="11" fill="url(#hglow)"/><circle class="dot" r="3.6"/><g class="tag"></g></g>`; }
  s += `<g class="hq" transform="translate(${HQ[0]} ${HQ[1]})"><circle class="pulse" r="6"/><rect x="-5" y="-5" width="10" height="10" rx="2.5"/><text y="-9">HQ</text></g><g id="hFly"></g>`;
  $("#hMap").innerHTML = s;
}
const hp = (id: string) => $(`#hp_${id}`) as unknown as SVGGElement;
function hTag(id: string, text: string, cls: string) {
  const g = hp(id); if (!g) return; g.setAttribute("class", `hp ${cls}`);
  const tag = g.querySelector(".tag")! as SVGGElement, w = text.length * 3.4 + 8, [x, y] = xPos.get(id)!;
  if (!tag.dataset.side) { const near = [...$$<SVGGElement>(".hp .tag[data-side='up']")].some((t) => { const o = t.closest(".hp")!.id.slice(3); if (o === id) return false; const [ox, oy] = xPos.get(o)!; return Math.abs(ox - x) < 34 && Math.abs(oy - y) < 14; }); tag.dataset.side = near ? "down" : "up"; }
  const dy = tag.dataset.side === "down" ? 20 : 0;
  tag.innerHTML = `<rect x="${-w / 2}" y="${-17 + dy}" width="${w}" height="10" rx="5"/><text y="${-10 + dy}">${esc(text)}</text>`;
}
function hPath(id: string) {
  const [x, y] = xPos.get(id)!, [hx, hy] = HQ, mx = (x + hx) / 2, my = Math.min(y, hy) - 30;
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", `M${hx} ${hy} Q${mx} ${my} ${x} ${y}`); p.setAttribute("class", "hline"); p.id = `hl_${id}`;
  $("#hLines").append(p); const L = p.getTotalLength(); p.style.strokeDasharray = `${L}`; p.style.strokeDashoffset = `${L}`; void p.getBoundingClientRect(); p.style.strokeDashoffset = "0"; return p;
}
function hFly(path: SVGPathElement, back: boolean, cls: string, ms = 700) {
  return new Promise<void>((res) => {
    const L = path.getTotalLength(), g = document.createElementNS(SVGNS, "g"); g.setAttribute("class", `env ${cls}`);
    g.innerHTML = `<rect x="-4.5" y="-3" width="9" height="6" rx="1"/><path d="M-4.5 -3 L0 0.6 L4.5 -3"/>`; $("#hFly").append(g);
    const t0 = performance.now();
    const step = (t: number) => { const k = Math.min(1, (t - t0) / ms), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2, pt = path.getPointAtLength((back ? 1 - e : e) * L); g.setAttribute("transform", `translate(${pt.x} ${pt.y})`); if (k < 1) requestAnimationFrame(step); else { g.remove(); res(); } };
    requestAnimationFrame(step);
  });
}
function hStage(k: string) { const order = ["parse", "source", "email", "compare", "approve", "book"], i = order.indexOf(k); $$<HTMLElement>("#hSteps > div").forEach((d, j) => { d.classList.toggle("done", j < i); d.classList.toggle("on", j === i); }); }
function hCount(id: string, n: number) { const e = $(`#${id}`); e.textContent = String(n); e.classList.remove("tick"); void e.offsetWidth; e.classList.add("tick"); }
async function hRun(text: string) {
  if (hBusy || !text.trim()) return; hBusy = true; hRuns++;
  const btn = $<HTMLButtonElement>("#hGo"); btn.disabled = true; $<HTMLInputElement>("#hIn").value = text;
  hMap(); $("#hPhone").innerHTML = `<div class="ph-s">Concierge is on it…</div>`; $("#hRes").innerHTML = ""; $("#hMap").classList.add("live"); $("#hMap").classList.remove("done");
  const c = { mail: 0, rep: 0, off: 0, inj: 0 }; ["hcMail", "hcRep", "hcOff", "hcInj"].forEach((i) => ($(`#${i}`).textContent = "0"));
  const store = new MemoryStore(); await store.init(venues); stores.push(store); srcOf.set(store, "Home");
  const pool: Behavior[] = ["accept", "injection", "counter_price", "decline", "accept", "accept_slow", "counter_capacity"], seen = new Map<string, Behavior>();
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, pool[(seen.size + hRuns) % pool.length]); return seen.get(id)!; }, NOW, 60 + hRuns);
  hWorld = world; const lines = new Map<string, SVGPathElement>(); let chain: Promise<void> = Promise.resolve();
  const q = (fn: () => Promise<void> | void) => { chain = chain.then(async () => { await fn(); }); };
  const onEvent = (e: TraceEvent) => {
    if (e.kind === "parsed") q(async () => { hStage("parse"); const r = e.data?.request as BookingRequest | undefined; if (r) $("#hPhone").innerHTML = `<div class="ph-me">${esc(text)}</div><div class="ph-chips">${[`${r.partySize} guests`, r.date ? when(eventWindow(r.date, r.time).startsAt) + ` · ${r.date.slice(5)}` : "", r.privateRoom ? "private" : "", r.clientName ?? "", r.cuisine ?? ""].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}${isAI(e) ? '<span class="ai"></span>' : ""}</div>`; await sleep(700); });
    if (e.kind === "sourced") q(async () => {
      hStage("source"); const top = ((e.data?.top ?? []) as { venueId: string }[]).map((t) => t.venueId);
      $$<SVGGElement>(".hp").forEach((g) => g.classList.add("fade"));
      for (const id of top) { const g = hp(id); g?.classList.remove("fade"); g?.classList.add("cand"); await sleep(70); }
      await sleep(500);
    });
    if (e.kind === "inquiries_sent") q(async () => {
      hStage("email"); const names = e.text.replace(/^emailed /, "").split(", ");
      await Promise.all(names.map(async (n, i) => { const v = venues.find((x) => x.name === n); if (!v) return; await sleep(i * 180); const p = hPath(v.id); lines.set(v.id, p); hTag(v.id, "emailed", "cand mailed"); await hFly(p, false, "out"); hCount("hcMail", ++c.mail); }));
      await sleep(300);
    });
    if (e.kind === "injection_flagged") q(async () => { const v = vByName(e.text); if (!v) return; const p = lines.get(v.id); if (p) await hFly(p, true, "bad", 600); hTag(v.id, "⚠ injection ignored", "inj"); hCount("hcInj", ++c.inj); toast("Injection blocked", `${v.name} tried to change who gets paid`, "bad"); await sleep(500); });
    if (e.kind === "reply") q(async () => { const v = vByName(e.text); if (!v) return; const p = lines.get(v.id); if (p) await hFly(p, true, "in", 600); hCount("hcRep", ++c.rep); const lab = e.text.split(": ")[1]?.split(" ")[0] ?? "";
      if (lab === "decline") hTag(v.id, "✕ declined", "no"); else if (lab === "auto_reply") hTag(v.id, "out of office", "wait"); else if (!hp(v.id)?.classList.contains("inj")) hTag(v.id, "replied", "cand mailed"); });
    if (e.kind === "offer") q(async () => { const o = e.data?.offer as Offer | undefined; if (!o) return; hCount("hcOff", ++c.off); if (!hp(o.venueId)?.classList.contains("inj")) hTag(o.venueId, `offer${isAI(e) ? " ✳" : ""}`, "offer"); await sleep(250); });
    if (e.kind === "gave_up" || e.kind === "follow_up") q(async () => { const v = vByName(e.text); if (v) hTag(v.id, e.kind === "gave_up" ? "no reply" : "nudged", "wait"); });
    if (e.kind === "compared") q(async () => {
      hStage("compare");
      for (const u of (e.data?.usable ?? []) as { venue: string; perHeadAllIn: number }[]) { const v = venues.find((x) => x.name === u.venue); if (v) { const inj = hp(v.id)?.classList.contains("inj"); hTag(v.id, `$${Math.round(u.perHeadAllIn)}/head${inj ? " · ⚠ ignored" : ""}`, inj ? "offer inj" : "offer"); } }
      for (const r of (e.data?.rejected ?? []) as { venue: string; why: string }[]) { const v = venues.find((x) => x.name === r.venue); if (v && !hp(v.id)?.classList.contains("inj")) hTag(v.id, `✕ ${r.why.replace(/needs[ _]human/, "unclear reply").replace(/_/g, " ").split(/[,;(]/)[0].slice(0, 22)}`, "no"); }
      await sleep(700);
    });
    if (e.kind === "replan") q(async () => { toast("Widening the search", "First round came back empty", "warn"); $$<SVGGElement>(".hp.cand").forEach((g) => g.classList.add("spent")); await sleep(400); });
    if (e.kind === "booked") q(() => hStage("book"));
  };
  const approver: Approver = async (p, st) => {
    await chain;
    if (p.kind === "pay_deposit") { for (const r of p.requiredRoles) await st.decide(p.id, approverFor(r, priya).id, r, "approve"); return "approved"; }
    hStage("approve"); const v = venues.find((x) => x.id === p.venueId)!, room = v.rooms.find((r) => r.id === p.roomId)!;
    hp(v.id)?.classList.add("win"); $("#hMap").classList.add("done");
    const ph = $("#hPhone"); ph.insertAdjacentHTML("beforeend", `<div class="ph-card"><div class="ph-v">${esc(v.name)}</div><div class="ph-r">${esc(room.name)} · ${esc(v.neighborhood)}</div>
      <div class="ph-g"><div><b>${when(p.startsAt)}</b><span>${localDate(p.startsAt).slice(5)}</span></div><div><b>${p.partySize}</b><span>guests</span></div><div><b>${usd(p.amountCents)}</b><span>all-in</span></div><div><b>${usd(Math.round(p.amountCents / p.partySize))}</b><span>per head</span></div></div>${v.preferredRatePct ? `<div class="ph-save">−${v.preferredRatePct}% corporate rate applied</div>` : ""}</div><div id="hSl"></div>`);
    ph.scrollTop = ph.scrollHeight;
    for (const role of p.requiredRoles) {
      const ok = await slideIn($("#hSl"), role === "booker" ? "Slide to book" : `Slide as ${approverFor(role, priya).name.split(" ")[0]}`);
      await st.decide(p.id, approverFor(role, priya).id, role, ok ? "approve" : "reject"); if (!ok) return "rejected";
    }
    return "approved";
  };
  const res = await runConcierge({ text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, company, approver, onEvent, shortlistSize: 4 });
  await chain; record(res, world);
  const ph = $("#hPhone");
  if (res.outcome === "booked" && res.chosenVenueId) {
    const v = venues.find((x) => x.id === res.chosenVenueId)!, bk = (await store.getBooking(res.bookingId!))!, room = v.rooms.find((r) => r.id === bk.roomId)!;
    const [x, y] = xPos.get(v.id)!; const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", `M${HQ[0]} ${HQ[1]} L${x} ${y}`); p.setAttribute("class", "hwin"); $("#hLines").append(p);
    ph.insertAdjacentHTML("beforeend", `<div class="ph-ok"><div class="ph-check">✓</div><b>Booked</b><span>${esc(v.name)} · ${when(bk.startsAt)}</span><span>${res.paymentId ? "Deposit paid to venue on file" : "No deposit"}</span></div>`);
    confetti(); toast("Booked", `${v.name} · ${bk.partySize} guests`);
    setLastBooking({ venue: v, roomName: room.name, partySize: bk.partySize, date: localDate(bk.startsAt), dietary: res.request?.dietary ?? [], client: res.request?.clientName ?? "Guests", world, threadId: `thr_${res.runId}_${v.id}` });
    $("#hRes").innerHTML = `<button class="btn" id="hIcs" title="Add to calendar">📅</button><a class="btn" href="${mailtoFor(v, room.name, bk.startsAt, bk.partySize, res.proposals.find((x) => x.kind === "book")?.amountCents ?? 0)}" title="Email it">✉</a><button class="btn" id="hMails" title="Venue emails">Threads</button><button class="btn pri" onclick="go('seating')">Seat</button><button class="btn" onclick="go('bookings')">Receipt</button>`;
    $("#hIcs").onclick = () => downloadIcs(v, room.name, bk.startsAt, bk.partySize); $("#hMails").onclick = () => showThreads(world, `Emails for ${res.request?.clientName ?? "this"} dinner`);
    renderGrid();
  } else {
    const last = res.messagesToBooker.at(-1) ?? "";
    ph.insertAdjacentHTML("beforeend", `<div class="ph-bot">${esc(last.length > 220 ? last.slice(0, 218) + "…" : last)}</div>`);
    $("#hRes").innerHTML = `<button class="btn" onclick="go('chat')">Answer in chat</button>`;
  }
  ph.scrollTop = ph.scrollHeight; $("#hMap").classList.remove("live"); btn.disabled = false; hBusy = false;
}
function confetti() {
  const box = $("#hConf"); const cols = ["#7b1e3a", "#c98a12", "#3f7d5a", "#5b6b8c", "#e7c27d"];
  for (let i = 0; i < 70; i++) { const s = el("i"); s.style.cssText = `left:${50 + (Math.random() - .5) * 30}%;background:${cols[i % 5]};--dx:${(Math.random() - .5) * 520}px;--dy:${-160 - Math.random() * 260}px;--r:${Math.random() * 720}deg;animation-delay:${Math.random() * 120}ms`; box.append(s); setTimeout(() => s.remove(), 1700); }
}
const HPH = ["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex on Nov 19", "team dinner for 8 this Friday under $100 a head", "japanese dinner for 8 with Wayne Enterprises on Nov 24, private"];
{ let i = 0; setInterval(() => { const inp = $<HTMLInputElement>("#hIn"); if (document.activeElement !== inp && !inp.value) inp.placeholder = HPH[i++ % HPH.length]; }, 2600); }
$("#hChips").innerHTML = HPH.slice(0, 3).map((t) => `<button class="chip" data-t="${esc(t)}">${esc(t.length > 42 ? t.slice(0, 40) + "…" : t)}</button>`).join("");
$$<HTMLButtonElement>("#hChips .chip").forEach((b) => b.onclick = () => void hRun(b.dataset.t!));
$("#hMap").addEventListener("click", (e) => { const g = (e.target as Element).closest(".hp"); if (!g || !hWorld) return; const id = g.id.slice(3), v = venues.find((x) => x.id === id)!; if (hWorld.sent().some((m) => m.venueId === id)) showThreads(hWorld, v.name, id); });
$<HTMLFormElement>("#hForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $<HTMLInputElement>("#hIn").value || $<HTMLInputElement>("#hIn").placeholder; void hRun(v); });
hMap();

// ---------- start ----------
if (!new URLSearchParams(location.search).has("still")) void deskLoop();
{ const h = location.hash.slice(1), ask0 = new URLSearchParams(location.search).get("ask"); go(ask0 ? "home" : $(`#p-${h}`) ? h : "home"); if (ask0) setTimeout(() => void hRun(ask0.slice(0, 200)), 700); }
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if ($(`#p-${h}`) && !$(`#p-${h}.on`)) go(h); });
