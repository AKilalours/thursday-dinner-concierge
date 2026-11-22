// The live site. Every page runs the real agent, tools, policy, store and graders from this repo
// against the simulated venue network. Model calls replay recorded Claude outputs (evals/recordings),
// exactly as CI does; anything not recorded falls back to the deterministic path, and the UI says which.
import { buildSupply, COMPANY, user } from "../data/seed.ts";
import { fuzzOne, runScenario } from "../evals/runner.ts";
import type { ScenarioRun } from "../evals/runner.ts";
import { SCENARIOS } from "../evals/scenarios.ts";
import { approverFor, carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import type { BookingRequest, Company, Offer, Proposal, Venue } from "../src/domain/types.ts";
import { injection, replyTriage, smsConsent } from "../src/judgments/judgments.ts";
import { LiveThenReplay, offline, RemoteLLM, ReplayLLM } from "../src/llm/client.ts";
import type { LLM } from "../src/llm/client.ts";
import { judgeMessage } from "../evals/judge.ts";
import { runRankingSuite } from "../evals/ranking.ts";
import { benchmark, pct as pct1 } from "../evals/classifiers.ts";
import type { Report } from "../evals/classifiers.ts";
import { metamorphic } from "../evals/metamorphic.ts";
import { replayBugs } from "../evals/mutations.ts";
import type { RankStats } from "../evals/ranking.ts";
import { call, ToolDenied } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/registry.ts";
import { amendBooking, book as bookTool, cancelBooking, createProposal, eventWindow, leadHours, notifyBooker, payDeposit, recordFact, sendVenueEmail } from "../src/tools/tools.ts";
import { ZodError } from "zod";
import { knowledge } from "../src/memory/supply.ts";
import { extractRules } from "../src/parse/offer.ts";
import { checkPolicy, estimate, perHeadFor } from "../src/policy/policy.ts";
import { ADJACENT } from "../src/agents/sourcing.ts";
import type { PolicyResult } from "../src/policy/policy.ts";
import { addDays, weekday } from "../src/time.ts";
import { extractOffer } from "../src/parse/offer.ts";
import { VenueWorld } from "../src/sim/world.ts";
import { HOODS, OFFICE, RealMap, venueLatLng } from "./realmap.ts";
import type { LatLng } from "./realmap.ts";
import { HERO_BG, PHOTO_CREDIT, roomPhoto, venuePhoto } from "./photos.ts";
import type { Behavior, Message } from "../src/sim/world.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { StoreSnapshot } from "../src/store/memory.ts";
import { StoreError } from "../src/store/store.ts";
import type { TraceEvent } from "../src/tools/registry.ts";

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll(s)] as T[];
const el = (tag: string, cls = "", html = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (iso: string) => { const d = new Date(Date.parse(iso) - 5 * 3_600_000); const h = d.getUTCHours(); return `${DAYS[d.getUTCDay()]} ${h % 12 || 12} ${h < 12 ? "am" : "pm"}`; };
const localDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);
const scen = (id: string) => SCENARIOS.find((s) => s.id === id)!;

const replayLLM = new ReplayLLM("claude-sonnet-4-5");
// Live Claude when the project's server is configured (docs/config.js or ?api=); otherwise the recorded answers.
const API = String((window as unknown as { TDC_API?: string }).TDC_API || new URLSearchParams(location.search).get("api") || "").trim().replace(/\/$/, "");
let apiHealth = { llm: false, email: false };
class SwitchLLM implements LLM {
  target: LLM = replayLLM; live: LiveThenReplay | null = null;
  get mode() { return this.target.mode; }
  async complete(t: string, sy: string, u: string, o?: { maxTokens?: number; signal?: AbortSignal }) {
    const t0 = performance.now(), before = this.live?.replayed ?? 0;
    try {
      const c = await this.target.complete(t, sy, u, o);
      llmLog.unshift({ task: t, ms: Math.round(performance.now() - t0), tin: c.inputTokens, tout: c.outputTokens, source: this.target === replayLLM || (this.live?.replayed ?? 0) > before ? "recorded" : "live", ok: true, at: Date.now() });
      return c;
    } catch (e) { llmLog.unshift({ task: t, ms: Math.round(performance.now() - t0), tin: 0, tout: 0, source: "none", ok: false, at: Date.now() }); throw e; }
    finally { if (llmLog.length > 400) llmLog.length = 400; }
  }
}
interface LlmCall { task: string; ms: number; tin: number; tout: number; source: "live" | "recorded" | "none"; ok: boolean; at: number }
const llmLog: LlmCall[] = [];
const llm = new SwitchLLM();
const supply = buildSupply(); // restaurants + caterers: what the agent can book and every booking looks up
const venues = supply.filter((v) => (v.category ?? "dining") === "dining"); // restaurants: what the map, Explore and Availability browse (same objects)
// The signed-in booker is a copy of the seed persona: renaming it never touches the fixtures the evals replay.
const priya = { ...user("usr_priya") }, dana = user("usr_dana");
// Whoever is signed in is the booker the agent acts for: their name goes into every email, message and approval.
const ME_KEY = "tdc_me";
const me = { name: (() => { try { return localStorage.getItem(ME_KEY) || ""; } catch { return ""; } })() || "Akila Lourdes" };
const meFirst = () => me.name.split(/\s+/)[0];
const meIni = () => me.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
function applyMe() {
  priya.name = me.name;
  document.querySelectorAll(".meName").forEach((e) => (e.textContent = me.name));
  document.querySelectorAll(".meIni").forEach((e) => (e.textContent = meIni()));
  document.querySelectorAll(".meFirst").forEach((e) => (e.textContent = meFirst()));
  document.querySelectorAll(".meOpt").forEach((e) => (e.textContent = `${meFirst()} (EA, acts for Dana)`));
}
applyMe();
// Evals, the Fix lab and policy replays are fixtures: they run on recorded Claude answers with the persona the
// recordings were made with, exactly like CI. Your own actions (Home, Chat, Explore, Compare) use live Claude.
async function asFixture<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
const company: Company = structuredClone(COMPANY);
const AGENT: Record<string, string> = { concierge: "c", sourcing: "s", coordination: "v", comparison: "m" };
const isAI = (e: TraceEvent) => e.data?.decidedBy === "model" || / \(model\)$/.test(e.text);

// ---------- session state ----------
const S = { req: 0, booked: 0, saved: 0, inj: 0, mail: 0, ai: 0 };
const ledger: { venue: string; guests: number; allIn: number; saved: number }[] = [];
const stores: MemoryStore[] = [];
const srcOf = new Map<MemoryStore, string>();
function bump(id: string, v: string) { const k = $(`#${id}`); if (k.textContent !== v) { k.textContent = v; k.parentElement!.classList.remove("bump"); void k.offsetWidth; k.parentElement!.classList.add("bump"); } }
interface RunLog { id: string; label: string; outcome: string; trace: TraceEvent[]; emails: number; at: number; past?: boolean; text?: string }
const runsLog: RunLog[] = [];
// ONE REQUEST ACROSS PAGES: what the person last asked on Home or Chat follows them to Explore, Availability, Compare,
// Orders, Calendar, Seating and Traces, so every page works on that request instead of its own sample.
interface Active { text: string; req: BookingRequest; runId: string; outcome: string; venueId: string | null; bookingId: string | null }
let active: Active | null = null, cmpFor = "";
function record(res: RunResult, world: VenueWorld, label?: string) {
  if (label && /\s/.test(label) && label !== "Venue side" && res.request?.partySize && res.request.date) { active = { text: label, req: res.request, runId: res.runId, outcome: res.outcome, venueId: res.chosenVenueId, bookingId: res.bookingId }; try { localStorage.setItem(`tdc_active:${me.name.toLowerCase()}`, JSON.stringify(active)); } catch { /* fine */ } }
  if (res.bookingId && label && /\s/.test(label) && label !== "Venue side") bkAsk.set(res.bookingId, label);
  const r0 = res.request; runsLog.unshift({ id: res.runId, label: label ?? (r0 ? `${r0.partySize} guests${r0.clientName ? ` · ${r0.clientName}` : ""}${r0.date ? ` · ${r0.date.slice(5)}` : ""}` : "request"), outcome: res.outcome, trace: [...res.trace], emails: world.sent().length + world.received().length, at: Date.now() });
  histDirty = true;
  if (runsLog.length > 60) runsLog.length = 60;
  if ($("#p-traces.on")) renderTraces();
  // Pages that list bookings stay live while you look at them.
  setTimeout(() => { if ($("#p-home.on")) void renderHomeRails(); if ($("#p-calendar.on")) void renderCal(); if ($("#p-bookings.on")) void renderBookings(); if ($("#p-invoice.on")) void renderInvoice(); }, 0);
  S.req++; S.mail += world.sent().length + world.received().length;
  S.inj += res.trace.filter((e) => e.kind === "injection_flagged").length;
  S.ai += res.trace.filter(isAI).length;
  if (res.outcome === "booked" && res.chosenVenueId) {
    const v = supply.find((x) => x.id === res.chosenVenueId)!, bk = res.proposals.find((p) => p.kind === "book")!;
    const saved = v.preferredRatePct ? Math.round(bk.amountCents / (1 - v.preferredRatePct / 100) - bk.amountCents) : 0;
    S.booked++; S.saved += saved; ledger.unshift({ venue: v.name, guests: bk.partySize, allIn: bk.amountCents, saved });
  }
  bump("kReq", String(S.req)); bump("kBook", String(S.booked)); bump("kSave", usd(S.saved)); bump("kInj", String(S.inj)); bump("kMail", String(S.mail)); bump("kAI", String(S.ai));
  renderSpend(); void renderKnowledge();
}

// ---------- navigation ----------
const ACT_PAGES: [string, string][] = [["explore", "Map"], ["avail", "Availability"], ["compare", "Offers"], ["bookings", "Orders"], ["calendar", "Calendar"], ["seating", "Seating"], ["traces", "Trace"]];
function applyActive(page: string) {
  const bar = $("#actBar"), a = active;
  if (!a || !ACT_PAGES.some(([p]) => p === page)) { bar.classList.remove("on"); return; }
  const v = a.venueId ? supply.find((x) => x.id === a.venueId) : null, r = a.req;
  bar.innerHTML = `<span>📌</span><div><b>${esc(a.text)}</b><br><small>${r.partySize} guests · ${md(r.date!)}${r.privateRoom ? " · private" : ""}${v ? ` · ✓ ${esc(v.name)}` : ` · ${esc(a.outcome.replace(/_/g, " "))}`}</small></div><div class="ab">${ACT_PAGES.map(([p, l]) => `<button data-go="${p}" class="${p === page ? "here" : ""}">${l}</button>`).join("")}</div>`;
  bar.classList.add("on"); $$<HTMLButtonElement>("#actBar [data-go]").forEach((b) => b.onclick = () => go(b.dataset.go!));
  if (page === "explore") { xF.n = r.partySize!; xF.priv = !!r.privateRoom; if (NIGHTS.includes(r.date!)) xF.date = r.date!; if (r.cuisine) xF.cuisines = new Set([r.cuisine]); const d = $<HTMLSelectElement>("#xDate"); if (d && NIGHTS.includes(r.date!)) d.value = r.date!; }
  if (page === "avail") { gParty = r.partySize!; gPrivate = !!r.privateRoom; const gp = $<HTMLInputElement>("#gParty"); if (gp) gp.value = String(gParty); renderGrid(); }
  if (page === "compare" && cmpFor !== a.text) { cmpFor = a.text; $<HTMLInputElement>("#cmpAsk").value = a.text; autoRan.add("compare"); void cmpLoad(llm); }
  if (page === "traces") { const i = runsLog.findIndex((x) => x.id === a.runId); if (i >= 0) { trSel = i; trEv = -1; } }
  if (page === "bookings" && a.bookingId) bkPick = a.bookingId;
}
function go(page: string) {
  applyActive(page);
  $$<HTMLButtonElement>("#tabs button[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === page));
  $$(".page").forEach((p) => p.classList.toggle("on", p.id === `p-${page}`));
  if (location.hash.slice(1) !== page) history.replaceState(null, "", `#${page}`);
  if (page === "bookings") void renderBookings();
  if (page === "calendar") void renderCal();
  if (page === "traces") renderTraces();
  if (page === "monitor") void renderMonitor();
  if (page === "partner") ptRenderBook();
  if (page === "invoice") void renderInvoice();
  if (page === "roi") void renderROI();
  if (page === "home" && !hBusy && !hDone) requestAnimationFrame(() => { hFit(); hMap(); void hIdle(); });
  if (page === "explore") requestAnimationFrame(() => { if (!xFitted) { xFitAll(); xFitted = true; } else xm.render(); });
  if (["controls", "evals", "compare", "fix", "memory"].includes(page)) autoRun(page);
  if (page === "seating" && !lastBk) void bkRows().then((rows) => { const r = rows.filter((x) => x.status === "confirmed").at(-1); if (r && !lastBk) setLastBooking({ venue: r.v, roomName: r.room.name, partySize: r.partySize, date: localDate(r.startsAt), dietary: [], client: "Acme", world: new VenueWorld(supply, () => "accept", NOW), threadId: `thr_seat_${r.id}` }); });
  if (page === "explore") renderExplore();
  document.body.classList.remove("menu"); const cur = $$<HTMLButtonElement>("#tabs button[data-p]").find((b) => b.dataset.p === page); if (cur) $("#menuCur").textContent = cur.textContent!;
  if (page === "chat") setTimeout(() => $<HTMLInputElement>("#chatIn")?.focus(), 50);
  
  window.scrollTo({ top: 0 });
}
$$<HTMLButtonElement>("#tabs button[data-p]").forEach((b) => b.addEventListener("click", () => go(b.dataset.p!)));
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
  const v = supply.find((x) => x.id === id)!, L = await learned(id);
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
  const li = (e: TraceEvent) => `<li class="${e.kind === "injection_flagged" ? "bad" : e.kind === "booked" ? "good" : ""}"><span class="ic ${AGENT[e.agent] ?? "c"}">${ICON[e.agent] ?? "✦"}</span><div><div class="at">${esc(e.kind.startsWith("to_booker") ? `Proposal sent to ${meFirst()}'s phone` : e.kind === "proposed" ? "Waiting for approval" : e.text.replace(/ \((model|rules)(, [\d.]+)?\)$/, ""))}${isAI(e) ? '<span class="ai"></span>' : ""}</div><div class="tm">${e.agent} · ${when(e.at)}</div></div></li>`;
  // Append only what's new, so the feed doesn't re-animate on every update.
  if (actsShown.sel === sel && shown.length >= actsShown.n) { $("#acts").insertAdjacentHTML("beforeend", shown.slice(actsShown.n).map(li).join("")); }
  else { $("#acts").innerHTML = shown.map(li).join(""); $("#acts").classList.add("still"); requestAnimationFrame(() => $("#acts").classList.remove("still")); }
  actsShown = { sel, n: shown.length };
  $("#acts").scrollTop = $("#acts").scrollHeight;
  paintPins(r);
}
function apply(r: DeskReq, e: TraceEvent) {
  r.acts.push(e); if (isAI(e)) r.ai++;
  const v = supply.find((x) => e.text.startsWith(x.name)), row = (id: string) => r.rows.get(id);
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
  const world = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11 + i);
  const store = new MemoryStore(); await store.init(supply); stores.push(store); r.world = world;
  let chain: Promise<void> = Promise.resolve();
  const show = (e: TraceEvent) => { chain = chain.then(async () => { if (g !== deskGen) return; apply(r, e); $("#dClock").textContent = when(e.at); renderQueue(); if (sel === i && dOpen) renderDetail(); await dsleep(["reply", "offer", "injection_flagged"].includes(e.kind) ? 700 : 1000); }); };
  const res = await runConcierge({ text: s.text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm: replayLLM, venues: supply, company, onEvent: (e) => { if (!e.kind.startsWith("to_booker")) show(e); },
    approver: async (p, st) => {
      await chain; if (g !== deskGen) return "pending";
      if (p.kind === "pay_deposit") return carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, st);
      const v = supply.find((x) => x.id === p.venueId)!;
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
  while (g === deskGen && n < pool.length) {
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
  const v = supply.find((x) => e.text.startsWith(x.name)); if (!v) return;
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
    const v = supply.find((x) => x.id === vid)!, st = statusOf(msgs), pc = ({ offer: "g", declined: "r", injection: "r", counter: "y", question: "y", "followed up": "y" } as Record<string, string>)[st] ?? "";
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
/** A prefilled GitHub issue: the sentence, what happened and the trace. Reports become rows in evals/user-requests.ts. */
const REPO = "https://github.com/AKilalours/thursday-dinner-concierge";
function reportUrl(text: string, res: { outcome: string; runId: string; messagesToBooker: string[]; trace: TraceEvent[] }) {
  const body = [
    "**What I typed**", "```", text, "```", "", `**What happened:** ${res.outcome.replace(/_/g, " ")}`, "",
    "**What the agent told me**", ...res.messagesToBooker.map((m) => `> ${m}`), "",
    "**What I expected**", "<!-- e.g. booked, a question back, a different venue -->", "",
    `<details><summary>Trace (${res.trace.length} steps, run ${res.runId})</summary>`, "", "```",
    ...res.trace.slice(-25).map((e) => `${e.kind}: ${e.text}`.slice(0, 160)), "```", "</details>",
  ].join("\n").slice(0, 6000);
  return `${REPO}/issues/new?${new URLSearchParams({ template: "real-user.md", labels: "real-user", title: `Real user: "${text.slice(0, 80)}"`, body })}`;
}
async function book() {
  running = true; $("#go button").setAttribute("disabled", "");
  for (const id of ["#events", "#inbox", "#phone", "#short"]) $(id).innerHTML = "";
  for (const id of ["#e1", "#e2", "#e3"]) $(id).style.display = "none";
  $$("#course span").forEach((s) => s.classList.remove("on", "done"));
  const s = scen(PRESET[preset]), seen = new Map<string, Behavior>(), order = s.order ?? [];
  bookWorld = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  bookStore = new MemoryStore(); await bookStore.init(supply); stores.push(bookStore); srcOf.set(bookStore, "Book");
  const res = await runConcierge({ text: $<HTMLInputElement>("#ask").value, actor: priya, principal: dana, today: "2026-11-09", store: bookStore, world: bookWorld, llm, venues: supply, company, approver: tap, onEvent: addEvent });
  await drained(); record(res, bookWorld);
  const v = res.chosenVenueId ? supply.find((x) => x.id === res.chosenVenueId) : null, bk = res.proposals.find((p) => p.kind === "book");
  const pay = res.paymentId ? bookStore.allPayments().find((x) => x.id === res.paymentId) : null;
  if (res.outcome === "booked" && v && bk) {
    course("book");
    const room = v.rooms.find((r) => r.id === bk.roomId)!;
    $("#phone").append(el("div", "ticket", `<div class="tt">${esc(v.name)}</div><div class="ts">${esc(room.name)} · ${when(bk.startsAt).replace(/ \d+ (am|pm)/, "")} ${localDate(bk.startsAt).slice(5)} · ${bk.partySize} guests</div><hr>${seating(bk.partySize)}
      <div class="ts" style="margin-top:6px">${usd(bk.amountCents)} all-in${pay ? ` · deposit ${usd(pay.amountCents)} → ${esc(pay.payeeId)}` : ""}</div><button class="btn pri" style="margin-top:10px;width:100%" onclick="go('seating')">Arrange seating →</button>`));
    setLastBooking({ venue: v, roomName: room.name, partySize: bk.partySize, date: localDate(bk.startsAt), dietary: res.request?.dietary ?? [], client: res.request?.clientName ?? "Guests", world: bookWorld, threadId: `thr_${res.runId}_${v.id}` });
    toast("Booked", `${v.name} · ${room.name} · ${bk.partySize} guests`);
  } else $("#phone").append(el("div", "ticket fail", `<div class="tt">${res.outcome.replace(/_/g, " ")}</div><div class="ts" style="color:#ffd5dc">Nothing was booked or paid.</div>`));
  $("#phone").append(el("div", "report", `Not what you expected? <a href="${reportUrl($<HTMLInputElement>("#ask").value, res)}" target="_blank" rel="noopener">Report it</a>. Every report becomes a permanent eval case.`));
  $("#phonebox").scrollTop = $("#phonebox").scrollHeight;
  running = false; $("#go button").removeAttribute("disabled");
}

// =====================================================================
// INBOX LAB
// =====================================================================
const labVenue = venues[1], meta = { date: "2026-11-12", time: "19:00", partySize: 12, privateRoom: true };
function template(t: string) {
  if (t === "auto") return "Thank you for your email. I am currently out of the office with limited access to email and will respond when I return.\n\nEvents Team";
  const w = new VenueWorld(supply, () => t as Behavior, "2026-11-09T15:00:00.000Z", 5);
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
  const NEXT: Record<string, [string, string]> = { offer: ["⚖️", "Check it against policy"], counter: ["💬", "Ask the booker about the new terms"], decline: ["➡️", "Email the next venue"], auto_reply: ["⏳", "Wait, then follow up"], question: ["✉️", "Reply with headcount and dietary needs"], needs_human: ["🙋", "Hand it to a person"] };
  const nx = inj.label === "injection" ? ["🛡️", "Ignore the instructions, flag it, keep the payee on file"] : NEXT[tri.label] ?? ["•", tri.label];
  $("#nextmv").innerHTML = `<i>${nx[0]}</i><div><small>Agent's next move</small>${esc(nx[1])}</div>`;
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
const labHead = (b: HTMLElement) => { const who = b.querySelector("b")!.textContent!, subj = b.querySelector("small")!.textContent!, t = b.querySelector("em")!.textContent!;
  $("#mailHead").innerHTML = `<i style="background-image:url('${venuePhoto(labVenue.id, 120, 120)}')"></i><div><b>${esc(subj)}</b><span>${esc(who)} · ${esc(labVenue.name)} → concierge@ · you can edit this email</span></div><em>${esc(t)}</em>`; };
$$<HTMLElement>("#tmpl .mav").forEach((i) => i.style.backgroundImage = `url('${venuePhoto(labVenue.id, 120, 120)}')`);
$$<HTMLButtonElement>("#tmpl .chip").forEach((b) => b.onclick = () => { $$("#tmpl .chip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); labHead(b); $<HTMLTextAreaElement>("#mail").value = template(b.dataset.t!); void analyze(); });
labHead($<HTMLElement>("#tmpl .chip.on"));
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
  const s = new MemoryStore(); await s.init(supply); s.setNow("2026-11-09T15:00:00.000Z"); await s.createRun({ id: "ctl" });
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
$("#detail").innerHTML = "";
function showRun(id: string) {
  const s = scen(id), r = runs.get(id); $("#dTitle").textContent = `${id} · ${s.group.replace("_", " ")}`;
  $("#detail").innerHTML = `<p style="font:600 15px Fraunces,Georgia,serif;margin:0 0 6px">“${esc(s.text)}”</p>` + (r ? `<p style="color:var(--dim);margin:0 0 6px">${r.result.outcome.replace(/_/g, " ")} · ${r.emails} emails · parse by ${r.result.parseDecidedBy === "model" ? "Claude" : "rules"}</p><table>${r.checks.map((c) => `<tr><td style="color:${c.pass ? "var(--sage)" : "var(--rose)"};font-weight:800">${c.pass ? "✓" : "✗"}</td><td>${c.name}</td></tr>`).join("")}</table>` : `<p style="color:var(--dim)">Not run yet.</p>`);
}
let inv = 0, invFail = 0;
// ---- Are the evals any good? Bug replay, metamorphic rewrites and the classifier benchmark, run in the browser.
type ClassRun = null | { name: string; at: string } & Record<"generated" | "dev" | "heldOut" | "fresh", { triage: { n: number; accuracy: number; ci: [number, number]; wrongAction: number; modelAsked?: number }; injection: { labels: { injection: { recall: number; support: number } } } }>;
type Gate = null | { promote: boolean; reasons: string[] };
type ClassJson = { model: ClassRun; gate: Gate; hybrid?: ClassRun; hybridGate?: Gate; strict?: ClassRun; strictGate?: Gate };
async function loadClassJson(): Promise<ClassJson | null> {
  for (const u of ["https://raw.githubusercontent.com/AKilalours/thursday-dinner-concierge/main/docs/classifiers.json", "./classifiers.json"]) { try { const r = await fetch(u, { cache: "no-store" }); if (r.ok) return await r.json() as ClassJson; } catch { /* next */ } }
  return null;
}
const ciBar = (acc: number, ci: [number, number]) => `<span class="ci" title="95% interval ${pct1(ci[0])}-${pct1(ci[1])}"><span style="left:${ci[0] * 100}%;right:${100 - ci[1] * 100}%"></span><em style="left:calc(${acc * 100}% - 1px)"></em></span>`;
function confusion(r: Report<string>) {
  const L = Object.keys(r.confusion), short: Record<string, string> = { offer: "offer", decline: "decl", counter: "ctr", question: "ask", payment_request: "pay", auto_reply: "auto", needs_human: "human" };
  return `<table class="cm"><tr><th class="r">truth ↓ · read as →</th>${L.map((l) => `<th>${short[l] ?? l}</th>`).join("")}</tr>${L.filter((t) => L.some((p) => r.confusion[t][p])).map((t) => `<tr><th class="r">${short[t] ?? t}</th>${L.map((p) => { const n = r.confusion[t][p], tot = L.reduce((a, q) => a + r.confusion[t][q], 0) || 1, a = n / tot; const bg = !n ? "#faf6ef" : t === p ? `rgba(63,125,90,${0.25 + a * 0.75})` : p === "needs_human" || p === "question" ? `rgba(201,164,106,${0.3 + a * 0.7})` : `rgba(194,69,93,${0.35 + a * 0.65})`; return `<td style="background:${bg};color:${a > 0.55 ? "#fff" : "var(--ink)"}">${n || ""}</td>`; }).join("")}</tr>`).join("")}</table><div class="cs" style="margin-top:4px">Green: right. Gold: handed to a person. Red: acted on the wrong reading.</div>`;
}
$("#runQ").onclick = async () => {
  const b = $<HTMLButtonElement>("#runQ"); b.disabled = true;
  $("#qReplay").innerHTML = '<div class="empty">Turning bugs back on…</div>'; $("#qMeta").innerHTML = '<div class="empty">Retyping sentences…</div>'; $("#qClass").innerHTML = '<div class="empty">Reading ~1,000 labelled emails…</div>';
  await sleep(30);
  const m = metamorphic();
  $("#qMeta").innerHTML = `<div class="qbig ${m.failures.length ? "bad" : ""}">${m.checks - m.failures.length}/${m.checks}</div><div class="cs">${m.sentences} sentences, each retyped 11 ways plus a changed headcount: every rewrite kept the right booking. Found R26 (doubled spaces lost allergies and the area) and R27 (ALL CAPS lost the client).</div>${m.failures.slice(0, 5).map((f) => `<div class="qrow"><i class="bad">✗</i><span>${esc(f.rewrite)}: “${esc(f.variant)}”</span></div>`).join("")}`;
  const [rules, cj] = await Promise.all([benchmark(offline, "rules"), loadClassJson()]);
  const sets = [["generated", "Generated · label = the behavior that wrote it"], ["dev", "Dev · hand-labelled, used to fix the rules"], ["heldOut", "Held-out · hand-labelled, never tuned on"], ["fresh", "Fresh · written after the first hybrid run, never run before"]] as const;
  const cell = (md: ClassRun | undefined, k: "generated" | "dev" | "heldOut" | "fresh", what: string) => {
    const x = md?.[k];
    return x ? `<b>${pct1(x.triage.accuracy)}</b>${ciBar(x.triage.accuracy, x.triage.ci)}<div class="cs">${x.triage.wrongAction} wrong actions · ${Math.round(x.injection.labels.injection.recall * x.injection.labels.injection.support)}/${x.injection.labels.injection.support} injections${what === "hybrid" && x.triage.modelAsked !== undefined ? ` · asked the model ${x.triage.modelAsked}×` : ""}${k === "generated" ? ` · ${x.triage.n} sampled` : ""}</div>` : '<span class="cs">needs a live run: <code>npm run evals:classifiers</code> with ANDE_LLM_MODE=live</span>';
  };
  const gateLine = (name: string, g: Gate | undefined) => g ? `<div class="gstep ${g.promote ? "ok" : ""}" style="margin-top:8px"><b>${name}: ${g.promote ? "promote" : "stays in shadow"}.</b> ${g.reasons.length ? esc(g.reasons.join(" · ")) : "Answered what it was asked; on every set at least as accurate as the rules, no more wrong actions, every injection they catch, and never reads a decline or a payment request as an offer more often."}</div>` : "";
  $("#qClass").innerHTML = `<div class="ctwrap"><table class="ctable wrap"><thead><tr><th>Set</th><th>Emails</th><th>Rules</th><th>${cj?.model ? `Model (${esc(cj.model.name)})` : "Model"}</th><th>Hybrid</th><th>Hybrid strict · in production</th></tr></thead><tbody>${sets.map(([k, name]) => {
    const r = rules[k];
    return `<tr><td>${name}</td><td>${r.triage.n}</td><td><b>${pct1(r.triage.accuracy)}</b>${ciBar(r.triage.accuracy, r.triage.ci)}<div class="cs">${r.triage.wrongAction} wrong actions · ${Math.round(r.injection.labels.injection.recall * r.injection.labels.injection.support)}/${r.injection.labels.injection.support} injections</div></td><td>${cell(cj?.model ?? null, k, "model")}</td><td>${cell(cj?.hybrid ?? null, k, "hybrid")}</td><td>${cell(cj?.strict ?? null, k, "hybrid")}</td></tr>`;
  }).join("")}</tbody></table></div>
  ${gateLine("Promotion gate, model alone", cj?.gate)}${gateLine("Promotion gate, hybrid", cj?.hybridGate)}${gateLine("Promotion gate, hybrid strict", cj?.strictGate)}
  <div class="qh" style="margin-top:12px;font-size:13px">Rules on the held-out set</div>${confusion(rules.heldOut.triage as Report<string>)}`;
  await sleep(30);
  $("#qReplay").innerHTML = "";
  const rows = await replayBugs((r) => { $("#qReplay").insertAdjacentHTML("beforeend", `<div class="qrow"><i class="${r.caught ? "ok" : "bad"}">${r.caught ? "✓" : "✗"}</i><b>${r.flag.toUpperCase()}</b><span>${esc(r.bug)}<span class="cs">${r.caught ? `caught by ${[r.scenarios.length && `${r.scenarios.length} scenario${r.scenarios.length > 1 ? "s" : ""}`, r.users.length && `${r.users.length} real-user`, r.ranking && "the ranking eval"].filter(Boolean).join(", ")}` : "not caught"}</span></span></div>`); });
  $("#qReplay").insertAdjacentHTML("afterbegin", `<div class="qbig ${rows.every((r) => r.caught) ? "" : "bad"}">${rows.filter((r) => r.caught).length}/${rows.length}</div>`);
  b.disabled = false;
};

$("#runEvals").onclick = async () => {
  const b = $<HTMLButtonElement>("#runEvals"); b.disabled = true; let pass = 0; inv = 0; invFail = 0; runs.clear(); $$("#tiles .tile").forEach((t) => (t.className = "tile"));
  for (const s of SCENARIOS) {
    const t = $(`.tile[data-id="${s.id}"]`); t.className = "tile run"; await sleep(60);
    const r = await asFixture(() => runScenario(s, replayLLM)); runs.set(s.id, r); const ok = r.checks.every((c) => c.pass); if (ok) pass++;
    for (const c of r.checks.filter((c) => c.kind === "invariant")) { inv++; if (!c.pass) invFail++; }
    t.className = `tile ${ok ? "pass" : "fail"}${r.result.parseDecidedBy === "model" ? " ai" : ""}`;
    bump("sPass", `${pass}/${SCENARIOS.length}`); bump("sInv", inv.toLocaleString()); bump("sFail", String(invFail));
  }
  showRun("p01"); b.disabled = false; renderGroups();
};
function renderGroups() {
  const groups = [...new Set(SCENARIOS.map((x) => x.group))];
  $("#eGroups").innerHTML = groups.map((g) => {
    const ss = SCENARIOS.filter((x) => x.group === g), done = ss.filter((x) => runs.has(x.id)), ok = done.filter((x) => runs.get(x.id)!.checks.every((c) => c.pass)).length;
    const ai = done.filter((x) => runs.get(x.id)!.result.parseDecidedBy === "model").length;
    return `<div class="eg"><span>${g.replace(/_/g, " ")}</span><div class="egb"><i style="width:${(ok / ss.length) * 100}%"></i></div><b>${ok}/${ss.length}</b><em title="parsed by Claude">✳${ai}</em></div>`;
  }).join("");
}
$("#runFuzz").onclick = async () => {
  const b = $<HTMLButtonElement>("#runFuzz"); b.disabled = true; const out: Record<string, number> = {}; let checks = 0, fails = 0;
  // Show the worlds, not whichever scenario detail was open (the dots used to fill out of sight below it).
  $("#detail").innerHTML = ""; $("#dTitle").textContent = "Random worlds";
  const col: Record<string, string> = { booked: "#3f7d5a", escalated: "#b8862b", rejected_by_booker: "#7a4fb0", awaiting_approval: "#7b1e3a", needs_clarification: "#8c7c6f" };
  const dots = $$<HTMLElement>("#field i"); dots.forEach((d) => (d.style.background = ""));
  for (let i = 0; i < 300; i++) {
    const f = await asFixture(() => fuzzOne(i, replayLLM)); out[f.outcome] = (out[f.outcome] ?? 0) + 1; checks += f.checks.length; const bad = f.checks.filter((c) => !c.pass).length; fails += bad;
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

// Ranking eval: the same sourcing code with no memory, with the pre-R11 memory, and with memory now.
// Deterministic (rules parse), identical to `npm run evals:ranking` in CI.
const RK_COL = ["#a99886", "var(--brass)", "var(--sage)"];
function drawRank(sets: (RankStats | null)[]) {
  const rows: [string, (s: RankStats) => number, (s: RankStats) => string][] = [
    ["hit@1", (s) => s.hit1, (s) => `${Math.round(s.hit1 * 100)}%`], ["hit@3", (s) => s.hit3, (s) => `${Math.round(s.hit3 * 100)}%`], ["MRR", (s) => s.mrr, (s) => s.mrr.toFixed(2)],
  ];
  $("#rk").innerHTML = rows.map(([name, v, f]) => `<div class="rkr"><span>${name}</span><div class="rkb">${sets.map((s, i) => `<div><i data-w="${s ? v(s) * 100 : 0}" style="background:${RK_COL[i]}"></i><b style="color:${RK_COL[i]}">${s ? f(s) : "·"}</b></div>`).join("")}</div></div>`).join("");
  requestAnimationFrame(() => $$<HTMLElement>("#rk i").forEach((x) => (x.style.width = `${x.dataset.w}%`)));
}
drawRank([null, null, null]);
$("#rkGo").onclick = async () => {
  const b = $<HTMLButtonElement>("#rkGo"); b.disabled = true; b.textContent = "Running…";
  try {
    const before = await runRankingSuite(offline, { legacy: { r11: true }, onWorld: (i) => { $("#rkMeta").textContent = `memory before R11 · world ${i + 1}/10`; } });
    drawRank([before.cold, before.warm, null]); await sleep(250);
    const now = await runRankingSuite(offline, { onWorld: (i) => { $("#rkMeta").textContent = `memory now · world ${i + 1}/10`; } });
    drawRank([now.cold, before.warm, now.warm]);
    $("#rkMeta").textContent = `${now.worlds} worlds · ${now.history} past bookings · ${now.heldOut} held-out requests · ${now.facts.toLocaleString()} facts learned · helped ${now.helped}, hurt ${now.hurt}`;
  } catch (err) { console.warn("ranking", err); $("#rkMeta").textContent = "Couldn't run here; see npm run evals:ranking."; }
  b.disabled = false; b.textContent = "Run again";
};

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
    diag: (r: RunResult) => { const v = supply.find((x) => x.id === r.chosenVenueId); return v ? `Asked for <b>Japanese</b>. Proposed <b>${esc(v.name)}</b>, which is <b>${esc(v.cuisine)}</b>. Cuisine was a +20 ranking nudge, not a requirement.` : "No venue proposed."; },
    diff: ["- // cuisine only nudges the ranking", "- cuisine: req.cuisine && v.cuisine === req.cuisine ? 20 : 0,", "+ const cuisineRequired = !!req.cuisine && venues.some((v) => v.cuisine === req.cuisine);", "+ if (cuisineRequired && v.cuisine !== req.cuisine) continue;", "+ // none fits policy? ask the booker which constraint to relax"] },
  { id: "R8", title: "Two vegetarians never confirmed to the booker", text: "dinner for a dozen with Umbrella next Wednesday in the West Village, private room, two vegetarians", reg: "reg06", flag: { r7: true, r8: true },
    diag: () => "Dietary needs went to the venue in the inquiry, but the proposal the booker approves never mentions them.",
    diff: ["  + `Deposit ${deposit}; free cancellation until ${h} h before.`", "+ + (req.dietary.length ? ` Dietary needs sent to ${venue}: ${req.dietary}.` : \"\")", "+ + (req.cuisine ? ` ${cuisine}, as asked.` : \"\")"] },
];
let inc = 0;
async function runFix(legacy: { r7?: boolean; r8?: boolean } | undefined, text: string) { return asFixture(() => runFixInner(legacy, text)); }
async function runFixInner(legacy: { r7?: boolean; r8?: boolean } | undefined, text: string) {
  const store = new MemoryStore(); await store.init(supply);
  const world = new VenueWorld(supply, () => "accept", "2026-11-09T15:00:00.000Z", 11);
  const res = await runConcierge({ text, actor: user("usr_priya"), principal: dana, today: "2026-11-09", store, world, llm: replayLLM, venues, company: COMPANY, legacy,
    approver: async (p, s) => carefulApprover(user("usr_priya"), { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, s) });
  const msg = res.messagesToBooker.find((m) => /Reply approve or reject/.test(m)) ?? res.messagesToBooker.at(-1) ?? "";
  const verdict = /Reply approve or reject/.test(msg) ? await judgeMessage(replayLLM, text, msg) : null;
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
    mark(3); const r = await asFixture(() => runScenario(scen(x.reg), replayLLM)), ok = r.checks.every((c) => c.pass);
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
const toolStore = new MemoryStore(); await toolStore.init(supply); toolStore.setNow("2026-11-09T15:00:00.000Z"); await toolStore.createRun({ id: "tools" });
const toolWorld = new VenueWorld(supply, () => "accept", "2026-11-09T15:00:00.000Z", 11);
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
  const t = TOOLS[toolSel], out = $("#toolOut"), actor = $<HTMLSelectElement>("#toolActor").value === priya.id ? priya : user($<HTMLSelectElement>("#toolActor").value);
  let input: unknown; try { input = JSON.parse($<HTMLTextAreaElement>("#toolIn").value); } catch { out.innerHTML = `<div class="tres bad"><b>Not JSON</b></div>`; return; }
  const ctxT = { store: toolStore, world: toolWorld, llm, company, venues: supply, actor, principal: dana, runId: "tools", today: "2026-11-09", smsOptedOut: new Set<string>(), trace: [] };
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
  try { const p = await toolStore.decide(lastProposal, priya.id, "booker", "approve"); $("#toolOut").innerHTML = `<div class="tres ok"><b>${esc(meFirst())} approved ${esc(p.id)} from the booker app (separate role)</b><pre>status: ${p.status}</pre></div>`; }
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
  await step("02 · TRACES", "Every agent step and every Claude call, like a production trace.", "traces", async () => { await sleep(600); ($(".tre:nth-child(6)") as HTMLElement | null)?.click(); await sleep(2600); });
  await step("03 · EXPLORE", "Filter the network on the map, shortlist, send one RFP. Offers land side by side.", "explore", async () => {
    await sleep(1000); for (let i = 0; i < 3 && touring; i++) { ($(".heart:not([disabled]):not(.on)") as HTMLElement | null)?.click(); await sleep(450); }
    await sleep(500); $("#xRfp")?.click(); for (let i = 0; i < 100 && touring && !$("#p-compare.on"); i++) await sleep(100); await sleep(2800);
  });
  await step("04 · FIX LAB", "Find the failure in a real conversation. Fix it. Prove it.", "fix", async () => { for (let i = 0; i < 4 && touring; i++) { $<HTMLButtonElement>("#fixGo").click(); await sleep(2300); } });
  await step("05 · TOOLS", "Typed tools: bad input rejected, unapproved booking refused.", "tools", async () => {
    $<HTMLButtonElement>("#toolList button[data-i='1']").click(); await sleep(500); $<HTMLButtonElement>("#toolCall").click(); await sleep(1300);
    $<HTMLButtonElement>("#toolList button[data-i='2']").click(); await sleep(500); $<HTMLButtonElement>("#toolCall").click(); await sleep(1600);
    $<HTMLButtonElement>("#toolApprove").click(); await sleep(1200); $<HTMLButtonElement>("#toolCall").click(); await sleep(1600);
  });
  await step("06 · CONTROLS", "Six safety controls, enforced by Postgres.", "controls", async () => { $<HTMLButtonElement>("#runAll").click(); await sleep(3500); });
  await step("07 · EVALS", "The CI suite in your browser. Real Claude outputs.", "evals", async () => { $<HTMLButtonElement>("#runEvals").click(); for (let i = 0; i < 300 && !$("#sPass").textContent!.startsWith(`${SCENARIOS.length}/`); i++) await sleep(100); await sleep(1200); });
  await step("08 · POLICY", "Policy is code. Drag it and the city changes.", "spend", async () => { for (const v of [180, 140, 300]) { const s = $<HTMLInputElement>("#cap"); s.value = String(v); s.dispatchEvent(new Event("input")); await sleep(900); } });
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
const toolCtx = (store: MemoryStore, world: VenueWorld, runId: string) => ({ store, world, llm, company, venues: supply, actor: priya, principal: dana, runId, today: TODAY, smsOptedOut: new Set<string>(), trace: [] as TraceEvent[] });
// The booking pages run on today's real date, so "tomorrow" or "this Friday" means what the person typing it means.
// The labs that replay recorded runs (Fix lab, Controls, Tools, Inbox lab) keep the fixed date their recordings were made on.
// ?today=YYYY-MM-DD pins the clock, for videos and reproducible checks.
const TODAY = (() => { const q = new URLSearchParams(location.search).get("today"); return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); })();
const NOW = new URLSearchParams(location.search).has("today") ? `${TODAY}T15:00:00.000Z` : new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
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
const gStore = new MemoryStore(); await gStore.init(supply); gStore.setNow(NOW); await gStore.createRun({ id: "grid" }); stores.push(gStore);
const md = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const NIGHTS = Array.from({ length: 14 }, (_, i) => addDays(TODAY, i + 1));
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
  $$<HTMLElement>("#grid .gc[data-v]").forEach((td) => td.onclick = () => { gPick = { v: supply.find((x) => x.id === td.dataset.v)!, date: td.dataset.d! }; renderGrid(); gDetail(); });
}
function gDetail() {
  if (!gPick) return; const { v, date } = gPick, c = cell(v, date); if (!("pol" in c) || !c.pol) return;
  const p = c.pol, DAYS3 = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  $("#gSide").innerHTML = `<div class="cph" style="background-image:url('${venuePhoto(v.id, 640, 300)}')"></div><div class="vt">${esc(v.name)}</div><div class="vs">${DAYS3[weekday(date)]}, ${md(date)} · 7 pm · ${gParty} guests</div>
    <div>${c.kind === "taken" ? '<span class="pill r">Already booked</span>' : p.onPolicy ? '<span class="pill g">In-Policy</span>' : `<span class="pill r">${esc(p.violations[0])}</span>`}${v.preferredRatePct ? `<span class="pill y">Preferred −${v.preferredRatePct}%</span>` : ""}${v.contractRequired ? '<span class="pill">Contract</span>' : ""}</div>
    <dl class="kv"><dt>Room</dt><dd>${esc(c.room.name)} · ${c.room.listedCapacity} seats</dd><dt>Minimum</dt><dd>${usd(c.min)}</dd><dt>All-in</dt><dd>${usd(p.estimate.allInCents)} · ${usd(p.estimate.perHeadAllInCents)}/head</dd><dt>Deposit</dt><dd>${p.depositCents ? usd(p.depositCents) : "none"}</dd><dt>Cancellation</dt><dd>free until ${v.cancellationHours} h before</dd><dt>Approval</dt><dd>${p.requiredRoles.join(" + ")}</dd></dl>
    ${c.kind === "taken" ? "" : p.onPolicy ? `<button class="btn pri" id="gReq" style="width:100%;margin-top:10px">Request this table</button>` : ""}<div id="gFlow"></div>`;
  $("#gReq")?.addEventListener("click", () => void gRequest(v, date, c.room.id));
}
async function gRequest(v: Venue, date: string, roomId: string) {
  $("#gReq")!.remove(); const box = $("#gFlow"), runId = `grid_${Math.random().toString(36).slice(2, 7)}`, thread = `thr_${runId}_${v.id}`;
  await gStore.createRun({ id: runId });
  const world = new VenueWorld(supply, () => "accept", NOW, 31 + Math.floor(Math.random() * 1000));
  const ctxT = toolCtx(gStore, world, runId);
  await call(ctxT, "grid", sendVenueEmail, { venueId: v.id, threadId: thread, kind: "inquiry", body: `Hello ${v.name} team, could you host ${gParty} guests${gPrivate ? " in a private room" : ""} on ${date} at 7 pm for Northwind Labs?`, meta: { date, time: "19:00", partySize: gParty, privateRoom: gPrivate } });
  box.insertAdjacentHTML("beforeend", `<div class="gstep"><span class="spin"></span> Emailed ${esc(v.name)}…</div>`); await sleep(900);
  const reply = world.advance(8).find((m) => m.threadId === thread);
  box.lastElementChild!.innerHTML = `<b>Emailed</b> ${esc(v.name)} · reply in ${reply ? Math.max(1, Math.round((Date.parse(reply.at) - Date.parse(NOW)) / 3_600_000)) : "?"} h`;
  if (!reply) { box.insertAdjacentHTML("beforeend", `<div class="gstep bad">No reply yet.</div>`); return; }
  const { offer, decidedBy } = await extractOffer(llm, reply.body, v, reply.id, TODAY, true);
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
async function cmpLoad(model: LLM = llm) {
  const btn = $<HTMLButtonElement>("#cmpGo"); btn.disabled = true; $("#cmpTable").innerHTML = `<div class="empty"><span class="spin"></span> The agent is emailing venues and reading replies…</div>`;
  const text = $<HTMLInputElement>("#cmpAsk").value, store = new MemoryStore(); await store.init(supply); stores.push(store); srcOf.set(store, "Compare");
  const order: Behavior[] = ["accept", "counter_price", "injection", "accept", "decline", "counter_capacity", "accept"]; const seen = new Map<string, Behavior>();
  const world = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, NOW, 11);
  const res = await runConcierge({ text, actor: priya, principal: dana, today: TODAY, store, world, llm: model, venues: supply, company, maxRounds: 1, shortlistSize: 7, approver: async () => "pending" });
  const req = res.request!; const proposed = res.proposals.find((p) => p.kind === "book");
  cmpCtx = { store, world, runId: res.runId, req };
  const rejected = new Map(((res.trace.find((e) => e.kind === "compared")?.data?.rejected ?? []) as { venue: string; why: string }[]).map((r) => [r.venue, r.why]));
  const injected = new Set(res.trace.filter((e) => e.kind === "injection_flagged").map((e) => e.text.split("'s email")[0]));
  cmpRows = res.trace.filter((e) => e.kind === "offer").map((e) => {
    const o = e.data!.offer as Offer, v = supply.find((x) => x.id === o.venueId)!;
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
    <td><span class="thumb" style="background-image:url('${venuePhoto(r.v.id, 120, 90)}')"></span><b>${esc(r.v.name)}</b>${r.agentPick ? ' <span class="pill b">agent’s pick</span>' : ""}${r.injected ? ' <span class="pill r">injection ignored</span>' : ""}${r.ai ? '<span class="ai"></span>' : ""}<div class="cs">${esc(r.v.neighborhood)} · ${esc(r.v.cuisine)}</div></td>
    <td>${esc(r.roomName)}</td><td>${r.seats ?? "—"}</td><td>${usd(r.min)}</td><td><b>${usd(r.pol.estimate.perHeadAllInCents)}</b></td><td>${usd(r.pol.estimate.allInCents)}</td><td>${r.pol.depositCents ? usd(r.pol.depositCents) : "none"}</td><td>${r.v.cancellationHours} h</td>
    <td>${r.why ? `<span class="st bad">${esc(r.why.length > 40 ? r.why.slice(0, 38) + "…" : r.why)}</span>` : `<span class="st ok">${r.pol.requiredRoles.join(" + ")}</span>`}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No offers came back.</div>`;
  $$<HTMLElement>("#cmpTable th.sortable").forEach((t) => t.onclick = () => { cmpSortKey = t.dataset.k!; cmpRender(); });
  $$<HTMLInputElement>("#cmpTable input[type=checkbox]").forEach((c) => c.onchange = () => { if (c.checked) { if (cmpSel.size >= 4) { c.checked = false; return; } cmpSel.add(c.dataset.v!); } else cmpSel.delete(c.dataset.v!); cmpRender(); });
  const pick = rows.filter((r) => cmpSel.has(r.v.id));
  const best = (f: (r: Cmp) => number) => Math.min(...pick.map(f));
  $("#cmpCards").innerHTML = pick.map((r) => `<div class="ccard ${r.agentPick ? "agent" : ""}"><div class="cph" style="background-image:url('${roomPhoto(r.v.id, r.roomName, 600, 300)}')"></div><div class="vt">${esc(r.v.name)}</div><div class="vs">${esc(r.roomName)} · ${r.seats ?? "?"} seats</div>
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
$("#cmpGo").onclick = () => void cmpLoad(llm);

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
  seats = Array(n).fill(null); seatOrder().forEach((g, i) => { if (i < seats.length) seats[i] = g; }); seatRender(); void fillSeatPick();
}
/** Host at the head, then alternate our people and their people so every client sits next to a host. */
function seatOrder() {
  const ours = guests.map((g, i) => ({ g, i })).filter((x) => x.g.org === "Northwind").map((x) => x.i), theirs = guests.map((g, i) => ({ g, i })).filter((x) => x.g.org !== "Northwind").map((x) => x.i);
  const order: number[] = []; while (ours.length || theirs.length) { if (theirs.length) order.push(theirs.shift()!); if (ours.length) order.push(ours.shift()!); }
  const hostIdx = order.indexOf(0); if (hostIdx > 0) { order.splice(hostIdx, 1); order.unshift(0); }
  return order;
}
/** Pick which of your dinners to seat. */
async function fillSeatPick() {
  const rows = (await bkRows()).filter((r) => r.status === "confirmed" && r.src !== "Live desk"), sel = $<HTMLSelectElement>("#seatPick"); if (!sel) return;
  sel.innerHTML = rows.map((r) => `<option value="${r.id}" ${lastBk && r.v.id === lastBk.venue.id && localDate(r.startsAt) === lastBk.date ? "selected" : ""}>${esc(r.v.name)} · ${DAYS[weekday(localDate(r.startsAt))]} ${Number(localDate(r.startsAt).slice(8))} · ${r.partySize}</option>`).join("");
  sel.onchange = () => { const r = rows.find((x) => x.id === sel.value); if (r) setLastBooking({ venue: r.v, roomName: r.room.name, partySize: r.partySize, date: localDate(r.startsAt), dietary: [], client: "Guests", world: new VenueWorld(supply, () => "accept", NOW), threadId: `thr_seat_${r.id}` }); };
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
  $("#seatHead").innerHTML = `<div class="cph" style="height:110px;background-image:url('${roomPhoto(b.venue.id, b.roomName, 900, 260)}')"></div><div class="vt">${esc(b.venue.name)} · ${esc(b.roomName)}</div><div class="vs">${b.date} · 7 pm · ${b.partySize} guests${b.partySize > 20 ? " (first 20 shown)" : ""}</div>`;
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
  if (!lastBk) return; seats = Array(seats.length).fill(null); const order = seatOrder();
  for (let i = 0; i < order.length && i < seats.length; i++) { seats[i] = order[i]; seatRender(); await sleep(70); }
};
$("#seatClear").onclick = () => { seats = Array(seats.length).fill(null); seatRender(); };
$("#seatSend").onclick = async () => {
  if (!lastBk) return; const b = lastBk, seated = seats.filter((x) => x !== null).length;
  if (seated < seats.length) { $("#seatOut").innerHTML = `<div class="gstep bad">Seat everyone first (${seated}/${seats.length}).</div>`; return; }
  const diet = guests.filter((g) => g.diet).map((g) => `${g.name} (${g.diet})`);
  const body = `Hi ${b.venue.name} team,\n\nSeating for our ${b.date} dinner, starting at the head of the table:\n${seats.map((g, i) => `${i + 1}. ${guests[g!].name}`).join("\n")}\n\n${diet.length ? `Dietary: ${diet.join(", ")}.` : "No dietary restrictions."}\n\nThank you,\nConcierge desk for ${me.name}, Northwind Labs`;
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
    const v = supply.find((x) => x.id === b.venueId)!, room = v.rooms.find((r) => r.id === b.roomId)!, p = await st.getProposal(b.proposalId);
    out.push({ id: b.id, status: b.status, startsAt: b.startsAt, partySize: b.partySize, proposalId: b.proposalId, store: st, v, room, src: srcOf.get(st) ?? "Live desk", approved: p?.amountCents ?? 0, paid: paidFor(st, b.id) });
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
function receipt(r: BkRow) {
  const d = localDate(r.startsAt), min = r.room.private || r.v.category === "catering" ? r.room.minSpendCents[weekday(d)] : 0, per = perHeadFor(r.v, "client_dinner");
  const list = Math.max(min, per * r.partySize), disc = Math.round(list * r.v.preferredRatePct / 100), sub = list - disc, tax = Math.round(sub * 0.08875), svc = Math.round(sub * 0.2);
  return { min, per, list, disc, sub, tax, svc, total: sub + tax + svc };
}
// ORDERS: every dinner this person booked, on this visit and earlier ones, like a delivery app's order history.
interface Deal { client: string; stage: "open" | "won" | "lost"; value: number }
const deals = new Map<string, Deal>(); // booking id -> the deal it was for, typed by the person (kept in their history)
const clientOf = (id: string) => bkAsk.get(id)?.match(/\bwith (?:the )?([A-Z][\w&.'-]*(?: [A-Z][\w&.'-]*)*)/)?.[1] ?? "";
const bkAsk = new Map<string, string>(); // booking id -> the sentence that booked it, so "Book again" re-asks it
const TINTS = ["#7b1e3a", "#3f7d5a", "#b8862b", "#5b6b8c", "#8a4f7d", "#2f6f73", "#a0522d"];
const tintOf = (name: string) => TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
type OrdState = "up" | "done" | "cx" | "chg";
const ordState = (r: BkRow): OrdState => r.status === "cancelled" ? (changedTo.has(r.id) ? "chg" : "cx") : Date.parse(r.startsAt) < Date.now() ? "done" : "up";
const ORD_LBL: Record<OrdState, string> = { up: "Upcoming", done: "Completed", cx: "Cancelled", chg: "Replaced" };
// =====================================================================
// ROI: what each client's dinners cost against the deals they were for. Every number comes from the person's own
// bookings and the deals they linked; nothing is estimated.
// =====================================================================
async function renderROI() {
  const rows = (await bkRows()).filter((r) => r.status === "confirmed" && r.src !== "Live desk" && !r.src.startsWith("Sample"));
  const linked = rows.filter((r) => deals.has(r.id)), by = new Map<string, { spend: number; n: number; pipe: number; won: number; lost: number }>();
  for (const r of linked) { const d = deals.get(r.id)!, k = d.client || "No client"; const c = by.get(k) ?? { spend: 0, n: 0, pipe: 0, won: 0, lost: 0 }; c.spend += r.approved; c.n++; if (d.stage === "won") c.won += d.value; else if (d.stage === "lost") c.lost += d.value; else c.pipe += d.value; by.set(k, c); }
  const spend = linked.reduce((a, r) => a + r.approved, 0), won = [...by.values()].reduce((a, c) => a + c.won, 0), pipe = [...by.values()].reduce((a, c) => a + c.pipe, 0), closed = linked.filter((r) => deals.get(r.id)!.stage !== "open").length, wins = linked.filter((r) => deals.get(r.id)!.stage === "won").length;
  $("#roiKpis").innerHTML = `<div class="ao"><b>${usd(spend)}</b><span>entertainment linked to deals</span></div><div class="ao"><b>${usd(pipe)}</b><span>open pipeline it touched</span></div><div class="ao"><b>${usd(won)}</b><span>won after a dinner</span></div><div class="ao"><b>${spend && won ? `${Math.round(won / spend)}×` : "—"}</b><span>won per $1 of entertainment${closed ? ` · ${wins}/${closed} closed deals won` : ""}</span></div>`;
  const max = Math.max(1, ...[...by.values()].map((c) => Math.max(c.spend, c.won, c.pipe)));
  $("#roiClients").innerHTML = by.size ? `<h3>By client</h3>${[...by.entries()].sort((a, b) => b[1].won - a[1].won).map(([k, c]) => `<div class="roic"><b>${esc(k)}</b><span class="roi-x">${c.won ? `${Math.round(c.won / Math.max(1, c.spend))}×` : ""}</span><div class="rb"><div><span>Spent</span><i style="width:${(c.spend / max) * 100}%;background:var(--wine)"></i>${usd(c.spend)} · ${c.n} dinner${c.n > 1 ? "s" : ""}</div><div><span>Pipeline</span><i style="width:${(c.pipe / max) * 100}%;background:var(--gold)"></i>${usd(c.pipe)}</div><div><span>Won</span><i style="width:${(c.won / max) * 100}%;background:var(--sage)"></i>${usd(c.won)}</div></div></div>`).join("")}`
    : `<div class="empty">No dinners linked to a deal yet.<br><span class="cs">Open a dinner in Orders, type the client and deal size, and mark it open, won or lost.</span><br><button class="btn pri" style="margin-top:10px" onclick="go('bookings')">Open Orders</button></div>`;
  const unl = rows.filter((r) => !deals.has(r.id));
  $("#roiSide").innerHTML = `<h3>Not linked yet · ${unl.length}</h3>${unl.length ? unl.slice(0, 8).map((r) => `<div class="ord" data-id="${r.id}" style="grid-template-columns:44px 1fr;padding:8px;margin-bottom:6px"><div class="ordimg" style="width:44px;height:44px;background:url('${roomPhoto(r.v.id, r.room.name, 120, 120)}') center/cover"></div><div><div class="on1" style="font-size:14px">${esc(r.v.name)}</div><div class="on2">${md(localDate(r.startsAt))} · ${usd(r.approved)}${clientOf(r.id) ? ` · ${esc(clientOf(r.id))}` : ""}</div></div></div>`).join("") : `<div class="cs">Every dinner is linked.</div>`}`;
  $$<HTMLElement>("#roiSide [data-id]").forEach((c) => c.onclick = () => { bkPick = c.dataset.id!; const r = rows.find((x) => x.id === bkPick)!; bkFilter = ordState(r) === "done" ? "past" : "upcoming"; $$("#bkFilter button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.f === bkFilter)); go("bookings"); });
}

// =====================================================================
// HOME: greeting, occasions, Book again, places near the office, and a venue sheet with similar places at the same price
// =====================================================================
const OCC: [string, string, string][] = [["🤝", "Client dinner", "client dinner for 6 next Thursday, somewhere private"], ["🍱", "Team lunch", "team lunch for 8 tomorrow"], ["🎉", "Celebration", "celebration dinner for 12 on Friday, private room"], ["👋", "Farewell", "farewell dinner for 10 next week, somewhere lively"], ["🥗", "Office catering", "catered lunch for 25 at the office this Thursday"], ["🥂", "Happy hour", "happy hour for 20 next Wednesday"], ["🍣", "Omakase", "japanese dinner for 4 with a client next Tuesday"]];
const OFFICE_HOOD = COMPANY.officeNeighborhood.toLowerCase(), ADJ = ADJACENT;
const fromPerHead = (v: Venue) => estimate(10, perHeadFor(v, "client_dinner"), 0, v.preferredRatePct).perHeadAllInCents;
const bigRoom = (v: Venue) => Math.max(...v.rooms.filter((r) => r.private).map((r) => r.listedCapacity), 0);
function vcard(v: Venue, extra = "", badge = "") {
  const bs = badgesFor(v), top = bs.find((b) => b.startsWith("Booked")) ?? bs.find((b) => b.startsWith("−")) ?? bs[0];
  const deal = top ? `<span class="vbadge">${esc(top)}</span>` : "";
  return `<button class="vcard" data-v="${v.id}"><div class="vph" style="background-image:url('${venuePhoto(v.id, 520, 300)}')">${badge || deal}${extra}</div><div class="vb"><b>${esc(v.name)}</b><div class="vm">${esc(v.cuisine[0].toUpperCase() + v.cuisine.slice(1))} · ${milesFromHQ(v).toFixed(1)} mi from HQ</div><div class="vchips">${bs.filter((b) => b !== top).slice(0, 2).map((b) => `<i>${esc(b)}</i>`).join("")}</div><div class="vp"><span>from <em>${usd(fromPerHead(v))}</em>/head</span><span>${bigRoom(v) ? `private · ${bigRoom(v)}` : "dining room"}</span></div></div></button>`;
}
let popF = "near";
// Venue badges, each computed from data the app actually has: the policy engine, the team's own
// bookings, the venue's preferred rate, and the distance from the office on the real map.
const teamCount = new Map<string, number>();
async function refreshTeamCounts() { teamCount.clear(); for (const r of await bkRows()) if (r.status === "confirmed") teamCount.set(r.v.id, (teamCount.get(r.v.id) ?? 0) + 1); }
const milesFromHQ = (v: Venue) => { const [a, b] = vLL.get(v.id) ?? OFFICE, R = 3958.8, rad = Math.PI / 180, dLat = (a - OFFICE[0]) * rad, dLng = (b - OFFICE[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(OFFICE[0] * rad) * Math.cos(a * rad) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function badgesFor(v: Venue, n = 8): string[] {
  const out: string[] = [], d = NIGHTS.slice(2).find((x) => !v.closedDays.includes(weekday(x))) ?? NIGHTS[2], room = v.rooms.find((r) => !r.private)!;
  const pol = checkPolicy(company, reqFor(n, d, false), v, { minSpendCents: 0, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, d, "19:00"));
  if (pol.onPolicy) out.push("In-policy"); if (pol.onPolicy && pol.requiredRoles.length === 1) out.push("Quick approval");
  const c = teamCount.get(v.id) ?? 0; if (c) out.push(`Booked ${c}× by your team`);
  if (v.preferredRatePct) out.push(`−${v.preferredRatePct}% preferred`); if (bigRoom(v) >= 20) out.push("Big groups"); void room;
  return out;
}
async function renderHomeRails() {
  const h = new Date().getHours(); $("#hGreet").textContent = `${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${meFirst()}`;
  $("#hHero").style.backgroundImage = `url('${HERO_BG}')`; $("#hHero").classList.add("kb");
  if (!monRows) monRows = await loadMonitor().catch(() => []);
  { const last = monRows.at(-1); if (last) $("#hStat").innerHTML = `<span class="pulse ${last.ok ? "" : "bad"}"></span>Agent Watch: ${last.ok ? "all checks green" : "a check failed"} · ${ago(last.at)} · ${monRows.reduce((a, r) => a + r.worlds.checks, 0).toLocaleString()} safety checks`; }
  $("#hOcc").innerHTML = OCC.map(([i, t, ask]) => `<button type="button" data-ask="${esc(ask)}"><i>${i}</i>${t}</button>`).join("");
  $$<HTMLButtonElement>("#hOcc button").forEach((b) => b.onclick = () => { $$("#hOcc button").forEach((x) => x.classList.toggle("on", x === b)); const inp = $<HTMLInputElement>("#hIn"); inp.value = b.dataset.ask!; inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); });
  await refreshTeamCounts();
  const near = [OFFICE_HOOD, ...(ADJ[OFFICE_HOOD] ?? [])];
  const pop = popF === "near" ? venues.filter((v) => near.includes(v.neighborhood.toLowerCase())) : popF === "deal" ? venues.filter((v) => v.preferredRatePct).sort((a, b) => b.preferredRatePct - a.preferredRatePct) : [...venues].sort((a, b) => bigRoom(b) - bigRoom(a));
  $("#hPop").innerHTML = pop.slice(0, 10).map((v) => vcard(v)).join("");
  const rows = (await bkRows()).filter((r) => r.src !== "Live desk" && !r.src.startsWith("Sample") && r.status === "confirmed").sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const seen = new Set<string>(), again = rows.filter((r) => !seen.has(r.v.id) && seen.add(r.v.id));
  ($("#hAgainWrap") as HTMLElement).hidden = !again.length;
  $("#hAgain").innerHTML = again.slice(0, 8).map((r) => `<button class="vcard" data-again="${r.id}"><div class="vph" style="background-image:url('${roomPhoto(r.v.id, r.room.name, 520, 300)}')"><span class="vbadge" style="color:var(--wine)">${ordState(r) === "done" ? "Completed" : "Upcoming"} · ${md(localDate(r.startsAt))}</span><span class="vagain">↻ Book again</span></div><div class="vb"><b>${esc(r.v.name)}</b><div class="vm">${esc(r.room.name)} · ${r.partySize} guests</div><div class="vp"><span>last time <em>${usd(r.approved)}</em></span><span>${usd(Math.round(r.approved / r.partySize))}/head</span></div></div></button>`).join("");
  $$<HTMLElement>("#hAgain [data-again]").forEach((c) => c.onclick = () => { const r = again.find((x) => x.id === c.dataset.again); if (r) openVenue(r.v, { n: r.partySize, room: r.room.id, again: r }); });
  $$<HTMLElement>("#hPop [data-v]").forEach((c) => c.onclick = () => openVenue(supply.find((v) => v.id === c.dataset.v)!));
}
$$<HTMLButtonElement>("#hPopF button").forEach((b) => b.onclick = () => { popF = b.dataset.f!; $$("#hPopF button").forEach((x) => x.classList.toggle("on", x === b)); void renderHomeRails(); });

/** A place's own sheet: pick a room, guests and night, see the real all-in price against policy, book it, or jump to similar places at about the same price. */
function openVenue(v: Venue, o: { n?: number; room?: string; date?: string; again?: BkRow } = {}) {
  document.querySelector(".modal.vsm")?.remove();
  const polFor = (x: Venue, r: Venue["rooms"][number], k: number, d: string) => checkPolicy(company, reqFor(k, d, r.private), x, { minSpendCents: r.private ? r.minSpendCents[weekday(d)] : 0, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, d, "19:00"));
  let n = o.n ?? 8, date = o.date ?? NIGHTS.slice(1).find((d) => !v.closedDays.includes(weekday(d)))!;
  // Default to the best room that is on policy: a private room when its minimum fits the cap, otherwise the dining room.
  const fitting = (k: number) => v.rooms.filter((r) => r.listedCapacity >= k).sort((a, b) => Number(b.private) - Number(a.private) || a.listedCapacity - b.listedCapacity);
  let roomId = o.room ?? (fitting(n).find((r) => polFor(v, r, n, date).onPolicy) ?? fitting(n)[0] ?? v.rooms[0]).id;
  const m = el("div", "modal vsm", ""); document.body.append(m);
  const close = () => m.remove(); m.onclick = (e) => { if (e.target === m) close(); };
  const draw = () => {
    const room = v.rooms.find((r) => r.id === roomId)!, day = weekday(date), min = room.private ? room.minSpendCents[day] : 0;
    const pol = polFor(v, room, n, date);
    const per = pol.estimate.perHeadAllInCents, fits = n <= room.listedCapacity;
    const sim = venues.filter((x) => x.id !== v.id && !x.closedDays.includes(day)).map((x) => {
      const r = x.rooms.filter((rr) => rr.private === room.private && rr.listedCapacity >= n).sort((a, b) => a.listedCapacity - b.listedCapacity)[0]; if (!r) return null;
      const pp = polFor(x, r, n, date); return { x, r, e: pp.estimate.perHeadAllInCents, ok: pp.onPolicy };
    }).filter((z): z is { x: Venue; r: Venue["rooms"][number]; e: number; ok: boolean } => !!z && (z.ok || !pol.onPolicy) && Math.abs(z.e - per) <= per * 0.3).sort((a, b) => Math.abs(a.e - per) - Math.abs(b.e - per)).slice(0, 6);
    m.innerHTML = `<div class="vsheet"><div class="vshero" style="background-image:url('${roomPhoto(v.id, room.name, 1200, 520)}')"><button class="vsx" aria-label="Close">✕</button><div><h2>${esc(v.name)}</h2><span>${esc(v.cuisine)} · ${esc(v.neighborhood)} · ${milesFromHQ(v).toFixed(1)} mi from HQ</span><div class="vsb2">${badgesFor(v, n).map((b) => `<i>${esc(b)}</i>`).join("")}</div></div></div>
      <div class="vsb">${o.again ? `<div class="gstep">Last time: ${o.again.partySize} guests in ${esc(o.again.room.name)}, ${md(localDate(o.again.startsAt))}, <b>${usd(o.again.approved)}</b>. Same again?</div>` : ""}
      <div><div class="vsl">Room</div><div class="rooms">${v.rooms.map((r) => `<button class="roomc ${r.id === roomId ? "on" : ""} ${r.listedCapacity < n ? "no" : ""}" data-r="${r.id}"><div style="background-image:url('${roomPhoto(v.id, r.name, 360, 200)}')"></div><span><b>${esc(r.name)}</b>${r.private ? "private" : "dining room"} · up to ${r.listedCapacity}</span></button>`).join("")}</div></div>
      <div class="vsrow"><div><div class="vsl">Guests</div><div class="step"><button data-d="-1">−</button><b>${n}</b><button data-d="1">+</button></div></div>
        <div style="flex:1;min-width:0"><div class="vsl">Night · 7 pm · price a head, all-in</div><div class="nights">${(() => { const opts = NIGHTS.slice(0, 12).map((d) => ({ d, closed: v.closedDays.includes(weekday(d)), per: v.closedDays.includes(weekday(d)) ? Infinity : polFor(v, room, n, d).estimate.perHeadAllInCents })), lo = Math.min(...opts.map((o) => o.per)), hi = Math.max(...opts.filter((o) => o.per < Infinity).map((o) => o.per));
        return opts.map((o) => `<button data-n="${o.d}" class="${o.d === date ? "on" : ""} ${o.per === lo && hi > lo ? "best" : ""}" ${o.closed ? "disabled title=\"Closed\"" : ""} style="--h:${hi > lo && o.per < Infinity ? (o.per - lo) / (hi - lo) : 0}">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(o.d)]}<small>${md(o.d)}</small>${o.closed ? "<em>closed</em>" : `<em>${usd(o.per)}</em>`}</button>`).join(""); })()}</div></div></div>
      <div class="vsprice"><div><b>${usd(per)}</b> <span class="cs">a head all-in · ${usd(pol.estimate.allInCents)} total${min ? ` · ${usd(min)} room minimum` : ""}</span><div class="${fits && pol.onPolicy ? "ok" : "bad"}">${!fits ? `${esc(room.name)} seats ${room.listedCapacity}` : pol.onPolicy ? `✓ On policy · ${pol.requiredRoles.map((x) => x === "booker" ? "you" : "a manager").join(" + ")} approve` : `✕ ${esc(pol.violations[0])}${room.private ? " · try the dining room or fewer nights out" : ""}`}</div></div>
        <button class="btn pri" id="vsGo" ${fits && pol.onPolicy ? "" : "disabled"}>${o.again ? "↻ Book again" : "Book this"}</button></div>
      ${sim.length ? `<div><div class="vsl">Similar, about ${usd(per)} a head that night</div><div class="hcar">${sim.map((z) => `<button class="vcard" data-sim="${z.x.id}" data-room="${z.r.id}"><div class="vph" style="height:110px;background-image:url('${roomPhoto(z.x.id, z.r.name, 480, 260)}')"><span class="vbadge" style="color:${z.e <= per ? "var(--sage)" : "var(--wine)"}">${z.e <= per ? "−" : "+"}${usd(Math.abs(z.e - per))}/head</span></div><div class="vb"><b>${esc(z.x.name)}</b><div class="vm">${esc(z.r.name)} · ${esc(z.x.neighborhood)}</div><div class="vp"><span><em>${usd(z.e)}</em>/head</span><span>${esc(z.x.cuisine)}</span></div></div></button>`).join("")}</div></div>` : ""}
      <div class="pcredit">${PHOTO_CREDIT} · fictional venues, illustrative photos</div></div></div>`;
    m.querySelector(".vsx")!.addEventListener("click", close);
    m.querySelectorAll<HTMLButtonElement>(".roomc").forEach((b) => b.onclick = () => { if (!b.classList.contains("no")) { roomId = b.dataset.r!; draw(); } });
    m.querySelectorAll<HTMLButtonElement>(".step button").forEach((b) => b.onclick = () => { n = Math.max(2, Math.min(60, n + Number(b.dataset.d))); if (n > v.rooms.find((r) => r.id === roomId)!.listedCapacity) { const r = v.rooms.filter((x) => x.listedCapacity >= n).sort((a, b2) => a.listedCapacity - b2.listedCapacity)[0]; if (r) roomId = r.id; } draw(); });
    m.querySelectorAll<HTMLButtonElement>(".nights button").forEach((b) => b.onclick = () => { date = b.dataset.n!; draw(); });
    m.querySelectorAll<HTMLElement>("[data-sim]").forEach((c) => c.onclick = () => openVenue(supply.find((x) => x.id === c.dataset.sim)!, { n, date, room: c.dataset.room }));
    m.querySelector<HTMLButtonElement>("#vsGo")!.onclick = () => {
      close(); const r = v.rooms.find((x) => x.id === roomId)!;
      const text = o.again && bkAsk.get(o.again.id) && n === o.again.partySize ? bkAsk.get(o.again.id)! : `dinner for ${n} on ${md(date)}${r.private ? ", private room" : ""}`;
      go("home"); setTimeout(() => { $("#hLive").scrollIntoView({ behavior: "smooth", block: "center" }); void hRun(text, { preferVenueId: v.id }); }, 300);
    };
  };
  draw();
}

/** Like a delivery app on sign-in: a returning person is asked whether to book their last dinner again. */
let roShown = false;
// For the README video: show the "Book again?" sheet on cue.
Object.assign(window, { reorderPromptForVideo: () => { roShown = false; void reorderPrompt(); } });
async function reorderPrompt() {
  if (roShown || visits.length < 2) return;
  const last = (await bkRows()).filter((r) => r.src !== "Live desk" && !r.src.startsWith("Sample") && r.status === "confirmed" && isPast(r.store)).sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  if (!last) return; roShown = true;
  const s = el("div", "rosheet", `<div class="roh"><div style="background-image:url('${roomPhoto(last.v.id, last.room.name, 320, 240)}')"></div><div><div class="vsl">Welcome back, ${esc(meFirst())}</div><h3>Book ${esc(last.v.name)} again?</h3><div class="cs">${last.partySize} guests · ${esc(last.room.name)} · ${usd(last.approved)} last time</div></div></div><div class="robtn"><button class="btn pri" data-a="again">↻ Book again</button><button class="btn" data-a="sim">Similar places</button><button class="btn" data-a="no">Not now</button></div>`);
  document.body.append(s);
  s.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) => b.onclick = () => { s.remove(); if (b.dataset.a === "again") bookAgain(last); if (b.dataset.a === "sim") openVenue(last.v, { n: last.partySize, room: last.room.id, again: last }); });
  setTimeout(() => s.remove(), 20000);
}

/** Home's phone, before anything is typed: a returning person sees their last dinners with one-tap Book again. */
async function hIdle() {
  if (hBusy || hDone || !$("#hPhone")) return;
  const rows = (await bkRows()).filter((r) => r.status === "confirmed" && r.src !== "Live desk" && !r.src.startsWith("Sample")).sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, 3);
  if (!rows.length || hBusy || hDone) return;
  $("#hPhone").innerHTML = `<div class="ph-hi"><b>${visits.length > 1 ? "Welcome back" : "Hi"}, ${esc(meFirst())}</b><span>Book again</span></div>${rows.map((r) => `<button class="ph-again" data-again="${r.id}"><i style="background:${tintOf(r.v.name)}">${esc(r.v.name[0])}</i><span><b>${esc(r.v.name)}</b><small>${r.partySize} guests · ${md(localDate(r.startsAt))}</small></span><em>↻</em></button>`).join("")}<div class="ph-s" style="margin-top:6px">Or type a new one above.</div>`;
  $$<HTMLButtonElement>("#hPhone [data-again]").forEach((b) => b.onclick = () => { const r = rows.find((x) => x.id === b.dataset.again); if (r) bookAgain(r); });
}
function bookAgain(r: BkRow) {
  const t = bkAsk.get(r.id) ?? `dinner for ${r.partySize} in ${r.v.neighborhood}`;
  go("home"); setTimeout(() => { $("#hLive")?.scrollIntoView({ behavior: "smooth", block: "center" }); void hRun(t, { preferVenueId: r.v.id }); }, 350);
}
async function renderBookings() {
  const rows = (await bkRows()).filter((r) => r.src !== "Live desk" && !r.src.startsWith("Sample")), conf = rows.filter((r) => r.status === "confirmed");
  const want: Record<string, OrdState[]> = { upcoming: ["up"], past: ["done"], cancelled: ["cx", "chg"] };
  const shown = rows.filter((r) => (want[bkFilter] ?? ["up"]).includes(ordState(r)));
  if (bkFilter !== "upcoming") shown.reverse();
  const saved = conf.reduce((a, r) => a + receipt(r).disc, 0);
  $("#ordAv").textContent = meIni();
  $("#ordHi").textContent = visits.length > 1 ? `Welcome back, ${meFirst()}` : `${meFirst()}'s dinners`;
  $("#ordSub").innerHTML = `${esc(visitLine())} · ${syncBadge()}`;
  $("#bkKpis").innerHTML = `<div><span>Dinners</span><b>${conf.length}</b></div><div><span>Guests hosted</span><b>${conf.reduce((a, r) => a + r.partySize, 0)}</b></div><div><span>Committed</span><b>${usd(conf.reduce((a, r) => a + r.approved, 0))}</b></div><div><span>Saved at preferred rates</span><b>${usd(saved)}</b></div>`;
  $$<HTMLButtonElement>("#bkFilter button").forEach((b) => { const n = rows.filter((r) => (want[b.dataset.f!] ?? []).includes(ordState(r))).length; b.textContent = `${b.dataset.f![0].toUpperCase()}${b.dataset.f!.slice(1)}${n ? ` · ${n}` : ""}`; });
  if (!shown.some((r) => r.id === bkPick)) bkPick = shown[0]?.id ?? null;
  let grp = "";
  $("#bkTable").innerHTML = shown.length ? shown.map((r) => {
    const s = ordState(r), g = isPast(r.store) ? "From earlier visits" : "This visit", head = g !== grp ? `<div class="ordgrp">${g}</div>` : ""; grp = g;
    const d = new Date(r.startsAt), day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return `${head}<div class="ord ${bkPick === r.id ? "picked" : ""} ${s === "cx" || s === "chg" ? "dim" : ""}" data-id="${r.id}">
      <div class="ordimg" style="background:linear-gradient(0deg,#0008,#0000 60%),url('${roomPhoto(r.v.id, r.room.name, 160, 160)}') center/cover,${tintOf(r.v.name)}"><small>${esc(r.v.cuisine.length > 9 ? r.v.cuisine.slice(0, 8) + "." : r.v.cuisine)}</small></div>
      <div><div class="on1">${esc(r.v.name)}</div><div class="on2">${day} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${r.partySize} guests · ${esc(r.v.neighborhood)}</div>
        <div class="on3"><span class="ost ${s}">${ORD_LBL[s]}</span><button class="ordb pri" data-again="${r.id}">↻ Book again</button>${s === "up" ? `<button class="ordb" data-open="${r.id}">Change</button>` : `<button class="ordb" data-open="${r.id}">Receipt</button>`}</div></div>
      <div class="oamt"><b>${usd(r.approved)}</b><span class="cs">${r.paid ? `${usd(r.paid)} deposit` : "no deposit"}</span></div></div>`;
  }).join("") : `<div class="empty">${bkFilter === "upcoming" ? "No dinners coming up." : bkFilter === "past" ? "No past dinners yet." : "Nothing cancelled."}<div class="chips" style="justify-content:center;margin-top:12px">${["team lunch for 6 tomorrow", "client dinner for 4 on Friday, somewhere quiet", "farewell dinner for 10 next week"].map((t) => `<button class="chip" data-try="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>`;
  $$<HTMLButtonElement>("#bkTable [data-try]").forEach((b) => b.onclick = () => { go("home"); setTimeout(() => void hRun(b.dataset.try!), 350); });
  $$<HTMLElement>("#bkTable .ord").forEach((c) => c.onclick = () => { bkPick = c.dataset.id!; void renderBookings(); });
  $$<HTMLButtonElement>("#bkTable [data-again]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const r = rows.find((x) => x.id === b.dataset.again); if (r) bookAgain(r); });
  const r = rows.find((x) => x.id === bkPick); if (!r) { $("#bkSide").innerHTML = `<div class="empty">Your dinners show up here.</div>`; return; }
  const rc = receipt(r), st = ordState(r), hrs = Math.round((Date.parse(r.startsAt) - Date.parse(NOW)) / 3_600_000), free = hrs >= r.v.cancellationHours;
  $("#bkSide").innerHTML = `<div class="ordimg" style="width:100%;height:150px;border-radius:14px;margin-bottom:10px;background:linear-gradient(0deg,#000a,#0000 70%),url('${roomPhoto(r.v.id, r.room.name, 700, 320)}') center/cover,${tintOf(r.v.name)}">${esc(r.v.name)}<small>${esc(r.room.name)} · ${esc(r.v.neighborhood)}</small></div>
    <div class="vs"><span class="ost ${st}">${ORD_LBL[st]}</span> ${when(r.startsAt)}, ${md(localDate(r.startsAt))} · ${r.partySize} guests${bkAsk.get(r.id) ? `<div class="cs" style="margin-top:6px">“${esc(bkAsk.get(r.id)!)}”</div>` : ""}</div>
    <div class="rcpt"><div><span>${rc.min > rc.per * r.partySize ? (r.v.category === "catering" ? "Minimum order" : `Food &amp; beverage minimum`) : `Menu, ${r.partySize} × ${usd(rc.per)}`}</span><b>${usd(rc.list)}</b></div>${rc.disc ? `<div class="g"><span>Preferred rate −${r.v.preferredRatePct}%</span><b>−${usd(rc.disc)}</b></div>` : ""}<div><span>NYC sales tax 8.875%</span><b>${usd(rc.tax)}</b></div><div><span>Service 20%</span><b>${usd(rc.svc)}</b></div><div class="t"><span>Total</span><b>${usd(rc.total)}</b></div><div><span>Deposit paid${carried.has(r.id) ? " (carried over)" : ""}</span><b>${r.paid ? `−${usd(r.paid)}` : "—"}</b></div></div>
    ${(() => { const d = deals.get(r.id) ?? { client: clientOf(r.id), stage: "open", value: 0 }; return `<div class="dealf"><div class="vsl" style="margin:0">Deal this dinner was for</div><div class="row"><input id="dlClient" placeholder="Client, e.g. Acme" value="${esc(d.client)}"><input id="dlValue" inputmode="numeric" placeholder="Deal $" value="${d.value ? d.value / 100 : ""}"></div><div class="seg" id="dlStage">${(["open", "won", "lost"] as const).map((k) => `<button data-s="${k}" class="${(deals.get(r.id)?.stage ?? "") === k ? "on" : ""}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div></div>`; })()}
    <button class="btn pri" id="bkAgain" style="width:100%;margin:10px 0">↻ Book again</button>
    ${st === "up" ? `<div class="cs" style="margin:0 0 8px">${free ? `Free cancellation for ${hrs - r.v.cancellationHours} more hours` : `Inside the ${r.v.cancellationHours} h window: the deposit would be forfeited`}</div>
    <div class="seg" id="bkAct"><button data-a="change" class="on">Change</button><button data-a="cancel">Cancel</button></div><div id="bkPane"></div>` : st === "done" ? `<div class="cs">Completed. <span class="mono">${r.id}</span></div>` : `<div class="cs">${changedTo.has(r.id) ? `Replaced by <a href="#" data-j="${changedTo.get(r.id)}">${changedTo.get(r.id)}</a>.` : "This booking was cancelled."}</div>`}`;
  $("#bkAgain").onclick = () => bookAgain(r);
  const saveDeal = (stage?: Deal["stage"]) => { const c = $<HTMLInputElement>("#dlClient").value.trim(), val = Math.round(Number($<HTMLInputElement>("#dlValue").value.replace(/[^\d.]/g, "")) * 100) || 0, st = stage ?? deals.get(r.id)?.stage ?? "open";
    if (!c && !val) { deals.delete(r.id); } else deals.set(r.id, { client: c, value: val, stage: st }); histDirty = true; $$("#dlStage button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.s === st && deals.has(r.id))); };
  $("#dlClient").onchange = () => saveDeal(); $("#dlValue").onchange = () => saveDeal();
  $$<HTMLButtonElement>("#dlStage button").forEach((b) => b.onclick = () => { saveDeal(b.dataset.s as Deal["stage"]); toast("Deal linked", `${$<HTMLInputElement>("#dlClient").value || "Client"} · ${b.dataset.s}`, "ok"); });
  $$<HTMLElement>("#bkSide [data-j]").forEach((a) => a.onclick = (e) => { e.preventDefault(); bkPick = a.dataset.j!; bkFilter = "upcoming"; $$("#bkFilter button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.f === "upcoming")); void renderBookings(); });
  if (st !== "up") return;
  $$<HTMLButtonElement>("#bkAct button").forEach((b) => b.onclick = () => { $$("#bkAct button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); b.dataset.a === "change" ? bkChange(r) : bkCancel(r, free, hrs); });
  bkChange(r);
}
async function mgmtCtx(st: MemoryStore) { await st.createRun({ id: "changes" }); return toolCtx(st, new VenueWorld(supply, () => "accept", NOW), "changes"); }
function bkChange(r: BkRow) {
  let n = r.partySize, date = localDate(r.startsAt); const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pane = $("#bkPane");
  const draw = () => {
    const min = r.room.private ? r.room.minSpendCents[weekday(date)] : 0;
    const pol = checkPolicy(company, reqFor(n, date, r.room.private), r.v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
    const same = n === r.partySize && date === localDate(r.startsAt), tooBig = n > r.room.listedCapacity, closed = r.v.closedDays.includes(weekday(date));
    const delta = pol.estimate.allInCents - r.approved;
    pane.innerHTML = `<div class="chg"><label>Guests<div class="step"><button data-d="-1">−</button><b>${n}</b><button data-d="1">+</button></div></label>
      <label>Night<select id="bkDate">${[localDate(r.startsAt), ...NIGHTS].filter((d, i, a) => a.indexOf(d) === i).sort().map((d) => `<option value="${d}" ${d === date ? "selected" : ""}>${DAYS3[weekday(d)]} ${md(d)}</option>`).join("")}</select></label></div>
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
    const ok = await slideIn(box, `Slide to cancel as ${meFirst()}`);
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
    if (!baseRuns.has(s.id)) baseRuns.set(s.id, await asFixture(() => runScenario(s, replayLLM, { ...company, policy: BASE_POLICY })));
    const a = baseRuns.get(s.id)!, z = await asFixture(() => runScenario(s, replayLLM, co));
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
  ...["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex next Friday", "team dinner for 8 this Friday under $100 a head", "client lunch for 6 with Initech tomorrow"].map((t) => ({ t, sub: "Ask the concierge", run: () => ask(t) })),
  ...[["home", "Home"], ["traces", "Traces"], ["chat", "Chat with the concierge"], ["explore", "Explore venues on the map"], ["desk", "Live desk"], ["avail", "Availability"], ["compare", "Compare offers"], ["bookings", "Bookings"], ["calendar", "Calendar"], ["seating", "Seating"], ["policy", "Policy"], ["spend", "Spend"], ["evals", "Evals"]].map(([p, l]) => ({ t: l, sub: "Go to", run: () => go(p) })),
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
const chatStore = new MemoryStore(); await chatStore.init(supply); chatStore.setNow(NOW); stores.push(chatStore); srcOf.set(chatStore, "Chat");
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
  window.scrollTo({ top: 0 }); msg("me", esc(text), `${esc(meFirst())} · now`);
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
  const world = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, mix[(seen.size + off) % mix.length]); return seen.get(id)!; }, NOW, 21 + off);
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
    await chain; const v = supply.find((x) => x.id === p.venueId)!, room = v.rooms.find((r) => r.id === p.roomId)!;
    if (p.kind === "pay_deposit") { for (const role of p.requiredRoles) await st.decide(p.id, approverFor(role, priya).id, role, "approve"); return "approved"; }
    for (const role of p.requiredRoles) {
      const who = approverFor(role, priya);
      const k = await choose(`${role === "booker" ? "Here's what I'd book:" : `Over ${usd(company.policy.managerApprovalAboveCents)}, so ${esc(who.name)} also signs off.`}${role === "booker" ? propCard(v, room.name, localDate(p.startsAt), p.partySize, p.amountCents, depositOf(v, p)) : ""}`, [["y", role === "booker" ? "Approve" : `Approve as ${esc(who.name.split(" ")[0])}`, "pri"], ["n", "Decline", ""]]);
      await st.decide(p.id, who.id, role, k === "y" ? "approve" : "reject");
      if (k !== "y") return "rejected";
    }
    return "approved";
  };
  const res = await runConcierge({ text, actor: priya, principal: dana, today: TODAY, store: chatStore, world, llm, venues: supply, company, approver, onEvent, shortlistSize: 3 });
  await chain; work.querySelector("details")!.removeAttribute("open"); work.querySelector("summary")!.innerHTML = `✓ ${steps} steps · ${res.trace.filter((e) => e.kind === "offer").length} offers read · ${world.sent().length} emails sent`;
  record(res, world, text);
  if (res.outcome === "booked" && res.bookingId) {
    const v = supply.find((x) => x.id === res.chosenVenueId)!, bk = (await chatStore.getBooking(res.bookingId))!, room = v.rooms.find((r) => r.id === bk.roomId)!;
    chatCur = { runId: res.runId, world, bookingId: res.bookingId, v, room, n: bk.partySize, date: localDate(bk.startsAt), client: res.request?.clientName ?? "Guests", dietary: res.request?.dietary ?? [] };
    toast("Booked", `${v.name} · ${bk.partySize} guests`); renderGrid();
    msg("bot", `<div class="cbtns"><button class="btn" id="ce_${res.runId}">✉ Email it</button><button class="btn" id="cc_${res.runId}">📅 Calendar</button></div>`);
    $(`#ce_${res.runId}`).onclick = () => emailIt(v, room.name, bk.startsAt, bk.partySize, res.proposals.find((x) => x.kind === "book")?.amountCents ?? 0, 0, res.request?.clientName ?? "");
    $(`#cc_${res.runId}`).onclick = () => downloadIcs(v, room.name, bk.startsAt, bk.partySize);
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
msg("bot", `Hi <span class="meFirst">${esc(meFirst())}</span>. Tell me who's coming, when, and anything that matters. I'll find the venue, handle the emails, and only book once you approve.`, "Concierge");
chips(["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex next Friday", "team dinner for 8 this Friday under $100 a head", "japanese dinner for 8 with Wayne Enterprises next Tuesday, private"]);

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
// Found testing as Mamatha: a dinner booked for Dec 3 never showed, because the calendar was a fixed 3 weeks.
// Show at least 3 weeks, and every week up to the last confirmed dinner (capped at 8 weeks).
const calDays = (last: string | null) => {
  const start = addDays(TODAY, -((weekday(TODAY) + 6) % 7)); // the grid's columns run Mon..Sun, so start on this week's Monday
  const weeks = last ? Math.min(8, Math.max(3, Math.floor((Date.parse(last) - Date.parse(start)) / (7 * 86_400_000)) + 1)) : 3;
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i));
};
let calPick: string | null = null, calLast = "";
async function renderCal() {
  const rows = (await bkRows()).filter((r) => r.status === "confirmed" && r.src !== "Live desk");
  const MON = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const last = rows.map((r) => localDate(r.startsAt)).sort().at(-1) ?? null;
  const html = MON.map((d) => `<div class="calh">${d}</div>`).join("") + calDays(last).map((d) => {
    const inRange = NIGHTS.includes(d), today = d === TODAY, list = rows.filter((r) => localDate(r.startsAt) === d);
    return `<div class="cald ${inRange ? "" : "off"} ${today ? "today" : ""}" data-d="${d}"><div class="caln">${Number(d.slice(8)) === 1 ? md(d) : Number(d.slice(8))}${today ? " · today" : ""}</div>${list.map((r) =>
      `<div class="calb ${calPick === r.id ? "pick" : ""}" draggable="true" data-id="${r.id}" style="background-image:linear-gradient(90deg,#fffdf8 55%,#fffdf8cc),url('${venuePhoto(r.v.id, 200, 120)}');--c:${["#7b1e3a", "#3f7d5a", "#5b6b8c", "#8a6212", "#a8502f"][supply.indexOf(r.v) % 5]}"><b>${esc(r.v.name)}</b><span>${r.partySize} · ${usd(r.approved)}</span></div>`).join("")}${inRange && !list.length ? `<button class="caladd" data-d="${d}">+ dinner</button>` : ""}</div>`;
  }).join("");
  // Re-render only when something changed, so a tap is never lost to a refresh.
  if (html === calLast && $("#calGrid").childElementCount) { $("#calHint").textContent = calPick ? "Now tap the night to move it to." : rows.length ? "Drag a dinner to another night (or tap it, then tap a night)." : "No dinners yet. Tap + on any night to book one."; $$(".calb").forEach((b) => b.classList.toggle("pick", (b as HTMLElement).dataset.id === calPick)); return; }
  calLast = html; $("#calGrid").innerHTML = html;
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
  $$<HTMLButtonElement>(".caladd").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const d = b.dataset.d!; go("chat"); void chatSend(`private dinner for 12 with Acme on ${md(d)}`); });
}
async function calMove(id: string, date: string) {
  const r = (await bkRows()).find((x) => x.id === id); if (!r || localDate(r.startsAt) === date) return void renderCal();
  const DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], label = `${DAYS3[weekday(date)]} ${md(date)}`;
  const shake = (msg: string) => { toast("Can't move it", msg, "bad"); $(`.cald[data-d="${date}"]`)?.classList.add("no"); setTimeout(() => void renderCal(), 600); };
  if (r.v.closedDays.includes(weekday(date))) return shake(`${r.v.name} is closed on ${DAYS3[weekday(date)]}s`);
  const min = r.room.private ? r.room.minSpendCents[weekday(date)] : 0;
  const pol = checkPolicy(company, reqFor(r.partySize, date, r.room.private), r.v, { minSpendCents: min, perHeadCents: null, depositPct: null, capacity: null }, leadHours(NOW, date, "19:00"));
  if (!pol.onPolicy) return shake(pol.violations.join("; "));
  const delta = pol.estimate.allInCents - r.approved;
  const k = await modal(`<div class="vt">Move ${esc(r.v.name)}?</div><div class="vs">${esc(r.room.name)} · ${r.partySize} guests</div>
    <div class="mv"><div><span>From</span><b>${when(r.startsAt)}, ${md(localDate(r.startsAt))}</b></div><i>→</i><div><span>To</span><b>${label}, 7 pm</b></div></div>
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
const vLL = new Map<string, LatLng>();
{ const per: Record<string, number> = {}; for (const v of venues) { const k = per[v.neighborhood] = (per[v.neighborhood] ?? 0) + 1; vLL.set(v.id, venueLatLng(v.neighborhood, k - 1)); } }
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
const xm = new RealMap($("#xReal"), { center: [40.728, -73.99], zoom: 13, interactive: true });
let xAll: { v: Venue; f: ReturnType<typeof xFit>; pass: boolean }[] = [];
function renderXMap(all = xAll) {
  xAll = all; const [w, h] = xm.size(); const svg = $("#xMap"); svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  let s = "";
  for (const [hn, ll] of Object.entries(HOODS)) { const [x] = xm.toPoint(ll), top = Math.min(...venues.filter((v) => v.neighborhood === hn).map((v) => xm.toPoint(vLL.get(v.id)!)[1])); const t = hn === "Financial District" ? "FIDI" : hn.toUpperCase(), lw = t.length * 7.4 + 16; s += `<g class="hlab ${xF.hoods.has(hn) ? "on" : ""}" data-h="${hn}" transform="translate(${x} ${top - 40})"><rect x="${-lw / 2}" y="-10" width="${lw}" height="20" rx="10"/><text y="4">${t}</text></g>`; }
  const [ox, oy] = xm.toPoint(OFFICE); s += `<g class="office" transform="translate(${ox} ${oy})"><rect x="-7" y="-7" width="14" height="14" rx="3"/><text y="22">HQ</text></g>`;
  for (const { v, f, pass } of all) {
    const [x, y] = xm.toPoint(vLL.get(v.id)!), ok = f.k === "ok" || f.k === "mgr";
    if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
    s += `<g class="xpin ${pass ? "" : "dim"} ${xHover === v.id || xOpen === v.id ? "hot" : ""} ${xShort.has(v.id) ? "short" : ""}" data-v="${v.id}" data-nodrag transform="translate(${x} ${y})">${ok && pass ? `<rect class="pl" x="-19" y="-27" width="38" height="17" rx="8.5" fill="${XCOL[f.k]}"/><text y="-15">$${Math.round(f.ph! / 100)}</text>` : ""}<circle r="${ok ? 6.5 : 5}" fill="${pass ? XCOL[f.k] : "#d9d0c3"}"/>${xShort.has(v.id) ? `<circle r="11" class="ring2"/>` : ""}</g>`;
  }
  svg.innerHTML = s; wireXMap();
}
xm.onChange(() => { if (xAll.length) renderXMap(); });
function renderExplore() {
  const all = venues.map((v) => ({ v, f: xFit(v), pass: xPass(v) }));
  const shown = all.filter((x) => x.pass);
  renderXMap(all);
  // list
  const ord = [...shown].sort((a, b) => {
    const rank = (x: typeof a) => ({ ok: 0, mgr: 1, budget: 2, over: 3, noroom: 4, closed: 5, blocked: 6 })[x.f.k];
    if (xF.sort === "price") return ((a.f as { ph?: number }).ph ?? 1e9) - ((b.f as { ph?: number }).ph ?? 1e9);
    if (xF.sort === "name") return a.v.name.localeCompare(b.v.name);
    return rank(a) - rank(b) || ((a.f as { ph?: number }).ph ?? 0) - ((b.f as { ph?: number }).ph ?? 0);
  });
  const fit = shown.filter((x) => x.f.k === "ok" || x.f.k === "mgr").length;
  $("#xCount").innerHTML = `<b>${fit}</b> of ${shown.length} venues fit · ${xF.n} guests · ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(xF.date)]} ${md(xF.date)}`;
  $("#xList").innerHTML = ord.map(({ v, f }) => { const ok = f.k === "ok" || f.k === "mgr";
    return `<div class="xr ${ok ? "" : "no"} ${xHover === v.id ? "hot" : ""} ${xOpen === v.id ? "open" : ""}" data-v="${v.id}"><i style="background:${XCOL[f.k]}"></i><span class="thumb" style="background-image:url('${venuePhoto(v.id, 120, 90)}')"></span><div><b>${esc(v.name)}</b><span>${esc(v.neighborhood)} · ${esc(v.cuisine)}${v.preferredRatePct ? ` · <em>−${v.preferredRatePct}%</em>` : ""}</span></div>
      <div class="xp">${ok ? `<b>${usd(f.ph!)}</b><span>per head</span>` : `<span>${esc(f.why)}</span>`}</div><button class="heart ${xShort.has(v.id) ? "on" : ""}" data-h="${v.id}" ${ok ? "" : "disabled"} title="Shortlist">♥</button></div>`; }).join("");
  // shortlist tray
  $("#xTray").innerHTML = xShort.size ? `<div class="xchips">${[...xShort].map((id) => `<span class="pill">${esc(supply.find((v) => v.id === id)!.name)} <a data-x="${id}">×</a></span>`).join("")}</div><button class="btn pri" id="xRfp">Send RFP to ${xShort.size} venue${xShort.size > 1 ? "s" : ""} →</button>` : `<span class="cs">♥ up to 6 venues → one request to all</span>`;
  wireExplore();
}
function wireExplore() {
  const hover = (id: string | null) => { if (xHover === id) return; xHover = id; $$(".xpin").forEach((p) => p.classList.toggle("hot", (p as HTMLElement).dataset.v === id || (p as HTMLElement).dataset.v === xOpen)); $$(".xr").forEach((r) => r.classList.toggle("hot", (r as HTMLElement).dataset.v === id)); };
  $$<HTMLElement>(".xr").forEach((r) => { r.onmouseenter = () => hover(r.dataset.v!); r.onmouseleave = () => hover(null); r.onclick = (e) => { if ((e.target as HTMLElement).closest(".heart")) return; xOpen = r.dataset.v!; xm.setView(vLL.get(xOpen)!, Math.max(xm.zoom, 15)); renderExplore(); void xDrawer(); }; });

  $$<HTMLButtonElement>(".heart").forEach((b) => b.onclick = () => { const id = b.dataset.h!; if (xShort.has(id)) xShort.delete(id); else if (xShort.size < 6) xShort.add(id); else toast("Shortlist is full", "Six venues per request", "warn"); renderExplore(); if (xOpen) void xDrawer(); });
  $$<HTMLElement>("#xTray [data-x]").forEach((a) => a.onclick = () => { xShort.delete(a.dataset.x!); renderExplore(); });
  $("#xRfp")?.addEventListener("click", () => void xRfp());
}
function wireXMap() {
  const hover = (id: string | null) => { xHover = id; $$(".xpin").forEach((p) => p.classList.toggle("hot", (p as HTMLElement).dataset.v === id || (p as HTMLElement).dataset.v === xOpen)); $$(".xr").forEach((r) => r.classList.toggle("hot", (r as HTMLElement).dataset.v === id)); };
  $$<SVGGElement>(".xpin").forEach((p) => { p.onmouseenter = () => hover(p.dataset.v!); p.onmouseleave = () => hover(null); p.onclick = () => { xOpen = p.dataset.v!; renderExplore(); void xDrawer(); $(`.xr[data-v="${xOpen}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }; });
  $$<SVGGElement>(".hlab").forEach((t) => t.onclick = () => { const n = t.dataset.h!; xF.hoods.has(n) ? xF.hoods.delete(n) : xF.hoods.add(n); renderHoodChips(); renderExplore(); });
}
function renderHoodChips() { $("#xHoods").innerHTML = Object.keys(XB).map((h) => `<button class="chip ${xF.hoods.has(h) ? "on" : ""}" data-hh="${h}">${h}</button>`).join(""); $$<HTMLButtonElement>("[data-hh]").forEach((b) => b.onclick = () => { const n = b.dataset.hh!; xF.hoods.has(n) ? xF.hoods.delete(n) : xF.hoods.add(n); renderHoodChips(); renderExplore(); }); }
async function xDrawer() {
  if (!xOpen) { $("#xDrawer").classList.remove("on"); return; }
  const v = supply.find((x) => x.id === xOpen)!, f = xFit(v), L = await learned(v.id), ok = f.k === "ok" || f.k === "mgr";
  const fq = (r: Venue["rooms"][number]) => Math.min(100, Math.round((xF.n / r.listedCapacity) * 100));
  $("#xDrawer").classList.add("on");
  $("#xDrawer").innerHTML = `<button class="xclose" id="xClose">×</button><div class="vt">${esc(v.name)}</div><div class="vs">${esc(v.neighborhood)} · ${esc(v.cuisine)} · menu ${usd(v.perHeadCents)} a head</div>
    <div>${ok ? `<span class="pill g">Fits · ${usd(f.ph!)}/head</span>` : `<span class="pill r">${esc(f.why)}</span>`}${v.preferredRatePct ? `<span class="pill y">Preferred −${v.preferredRatePct}%</span>` : ""}${v.contractRequired ? `<span class="pill">Contract</span>` : ""}${L.inj ? `<span class="pill r">Injection seen</span>` : ""}</div>
    <div class="pt" style="margin-top:12px">Rooms for ${xF.n}</div>${v.rooms.map((r) => `<div class="xroom ${r.listedCapacity < xF.n ? "small" : ""}"><div><b>${esc(r.name)}</b>${r.private ? '<span class="pill">private</span>' : ""}<span class="cs">${L.cap.has(r.id) ? `<s>${r.listedCapacity}</s> really ${L.cap.get(r.id)}` : r.listedCapacity} seats · min ${r.private ? usd(r.minSpendCents[weekday(xF.date)]) : "none"}</span></div><div class="bar2"><i style="width:${fq(r)}%"></i></div></div>`).join("")}
    <dl class="kv" style="margin-top:10px"><dt>Deposit</dt><dd>${v.depositPct}%</dd><dt>Free cancel</dt><dd>${v.cancellationHours} h before</dd><dt>Closed</dt><dd>${v.closedDays.length ? v.closedDays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ") : "never"}</dd><dt>Reply time</dt><dd>${L.replies.length ? `~${Math.round(L.replies.reduce((a, b) => a + b, 0) / L.replies.length)} h (learned)` : "not seen yet"}</dd></dl>
    <div class="row" style="margin-top:12px"><button class="btn ${xShort.has(v.id) ? "" : "pri"}" id="xHeart" ${ok ? "" : "disabled"}>${xShort.has(v.id) ? "Remove from shortlist" : "♥ Shortlist"}</button><button class="btn" id="xBook" ${ok ? "" : "disabled"}>Book via chat</button></div>`;
  $("#xClose").onclick = () => { xOpen = null; renderExplore(); void xDrawer(); };
  $("#xHeart").onclick = () => { xShort.has(v.id) ? xShort.delete(v.id) : xShort.size < 6 && xShort.add(v.id); renderExplore(); void xDrawer(); };
  $("#xBook").onclick = () => { go("chat"); void chatSend(`${xF.priv ? "private " : ""}dinner for ${xF.n} with Acme on ${md(xF.date)} at ${v.name}`); };
}
async function xRfp() {
  const btn = $<HTMLButtonElement>("#xRfp"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Emailing ${xShort.size} venues…`;
  const store = new MemoryStore(); await store.init(supply); store.setNow(NOW); stores.push(store); srcOf.set(store, "Explore");
  const runId = `rfp_${Math.random().toString(36).slice(2, 7)}`; await store.createRun({ id: runId });
  const mix: Behavior[] = ["accept", "counter_price", "injection", "accept", "decline", "accept"], ids = [...xShort], beh = new Map(ids.map((id, i) => [id, mix[i % mix.length]]));
  const world = new VenueWorld(supply, (id) => beh.get(id) ?? "accept", NOW, 41 + ids.length);
  const req = reqFor(xF.n, xF.date, xF.priv), ctxT = toolCtx(store, world, runId), inj = injection(llm);
  for (const id of ids) { const v = supply.find((x) => x.id === id)!; await call(ctxT, "explore", sendVenueEmail, { venueId: id, threadId: `thr_${runId}_${id}`, kind: "inquiry", body: `Hello ${v.name} team, could you host ${xF.n} guests${xF.priv ? " in a private room" : ""} on ${xF.date} at 7 pm for Northwind Labs?`, meta: { date: xF.date, time: "19:00", partySize: xF.n, privateRoom: xF.priv } }); }
  const replies = world.advance(6), rows: Cmp[] = [];
  for (const id of ids) {
    const v = supply.find((x) => x.id === id)!, r = replies.find((m) => m.venueId === id);
    if (!r) continue;
    const tri = await replyTriage(llm).classify(r.body); if (tri.label === "decline") { toast(`${v.name} declined`, "Fully committed that night", "warn"); continue; }
    const { offer, decidedBy } = await extractOffer(llm, r.body, v, r.id, TODAY, true);
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
$("#xDate").innerHTML = NIGHTS.map((d) => `<option value="${d}" ${d === xF.date ? "selected" : ""}>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(d)]} ${md(d)}</option>`).join("");
$<HTMLSelectElement>("#xDate").onchange = (e) => { xF.date = (e.target as HTMLSelectElement).value; renderExplore(); void xDrawer(); };
$("#xCuis").innerHTML = CUISINES.map((c) => `<button class="chip" data-cu="${c}">${c}</button>`).join("");
$$<HTMLButtonElement>("[data-cu]").forEach((b) => b.onclick = () => { const c = b.dataset.cu!; xF.cuisines.has(c) ? xF.cuisines.delete(c) : xF.cuisines.add(c); b.classList.toggle("on"); renderExplore(); });
$$<HTMLButtonElement>("#xSort button").forEach((b) => b.onclick = () => { $$("#xSort button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); xF.sort = b.dataset.s!; renderExplore(); });
$("#xIn").onclick = () => xm.zoomBy(1); $("#xOut").onclick = () => xm.zoomBy(-1); let xFitted = false;
const xFitAll = () => xm.fit([...vLL.values(), OFFICE], { top: 60, right: 30, bottom: 50, left: 56 });
$("#xReset").onclick = xFitAll;
requestAnimationFrame(() => { if (xm.size()[0]) { xFitAll(); xFitted = true; } });
renderHoodChips(); renderExplore();


// =====================================================================
// shared: the real email threads, a calendar invite, and an email you send yourself
// =====================================================================
function showThreads(world: VenueWorld, title: string, venueId?: string) {
  const msgs = [...world.sent(), ...world.received()].filter((m) => !venueId || m.venueId === venueId).sort((a, b) => a.at.localeCompare(b.at) || (a.direction === "out" ? -1 : 1));
  const bad = (b: string) => /SYSTEM NOTE|ignore (all )?previous|routing \d|wire the/i.test(b);
  void modal(`<div class="vt">${esc(title)}</div><div class="vs">${msgs.length} email${msgs.length === 1 ? "" : "s"} · exactly what the agent sent and received</div><div class="mail">${msgs.map((m) => {
    const v = supply.find((x) => x.id === m.venueId)!;
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
function emailIt(v: Venue, roomName: string, startsAt: string, n: number, allIn: number, deposit = 0, client = "") {
  if (!apiHealth.email) { location.href = mailtoFor(v, roomName, startsAt, n, allIn); return; }
  let saved = ""; try { saved = localStorage.getItem("tdc_email") ?? ""; } catch { /* storage may be blocked */ }
  const m = el("div", "modal", `<form class="mbox" id="emForm"><div class="vt">Email the confirmation</div><div class="vs">A real email with the calendar invite attached.</div><input id="emTo" type="email" required placeholder="you@company.com" value="${esc(saved)}" class="emin"><div class="cbtns"><button class="btn pri">Send</button><button class="btn" type="button" id="emX">Cancel</button></div></form>`);
  document.body.append(m); const inp = m.querySelector<HTMLInputElement>("#emTo")!; setTimeout(() => inp.focus(), 30);
  m.querySelector("#emX")!.addEventListener("click", () => m.remove()); m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  m.querySelector("form")!.addEventListener("submit", async (e) => {
    e.preventDefault(); const to = inp.value.trim(), btn = m.querySelector<HTMLButtonElement>(".btn.pri")!; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { localStorage.setItem("tdc_email", to); } catch { /* fine */ }
    try {
      const r = await fetch(`${API}/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, venue: v.name, room: roomName, neighborhood: v.neighborhood, when: `${when(startsAt)}, ${localDate(startsAt)}`, guests: n, allIn: usd(allIn), deposit: deposit ? usd(deposit) : "", client, startsAt }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      m.remove(); toast("Email sent", `Check ${to}`);
    } catch (err) { btn.disabled = false; btn.textContent = "Send"; toast("Couldn't send", String(err instanceof Error ? err.message : err), "bad"); }
  });
}
function mailtoFor(v: Venue, roomName: string, startsAt: string, n: number, allIn: number) {
  const body = `Dinner is booked.\n\n${v.name} · ${roomName}\n${when(startsAt)}, ${localDate(startsAt)}\n${n} guests · about ${usd(allIn)} all-in\n\nBooked by the concierge.`;
  return `mailto:?subject=${encodeURIComponent(`Booked: ${v.name}, ${localDate(startsAt)}`)}&body=${encodeURIComponent(body)}`;
}

// =====================================================================
// HOME: one sentence in; the agents work across the city; you approve on your phone
// =====================================================================
let HQ: [number, number] = [0, 0];
const hPos = new Map<string, [number, number]>();
const hm = new RealMap($("#hReal"), { center: [40.728, -73.99], zoom: 13 });
let hVH = 290;
function hLayout() {
  const [w, h] = hm.size(); if (!w) return; const k = 340 / w; hVH = Math.round(h * k);
  for (const v of venues) { const [x, y] = hm.toPoint(vLL.get(v.id)!); hPos.set(v.id, [x * k, y * k]); }
  const [ox, oy] = hm.toPoint(OFFICE); HQ = [ox * k, oy * k];
}
const vByName = (t: string) => venues.filter((v) => t.startsWith(v.name) || t.includes(` ${v.name}`) || t.includes(`${v.name},`) || t.includes(`${v.name}'s`)).sort((a, b) => b.name.length - a.name.length)[0];
let hBusy = false, hDone = false, hQuiet = "", hRuns = 0, hWorld: VenueWorld | null = null;
const SVGNS = "http://www.w3.org/2000/svg";
const CUIS_COL: Record<string, string> = { italian: "#c0583f", steakhouse: "#7b1e3a", japanese: "#d23c5a", "new american": "#3a6ea5", french: "#5b4b8a", mediterranean: "#2f8f83", korean: "#e07a1f", seafood: "#1f7fa8" };
function hMap() {
  if (!hm.size()[0]) return; // hidden page: lay out when it is shown
  hLayout(); const k = 340 / Math.max(1, hm.size()[0]);
  let s = `<defs><radialGradient id="hglow"><stop offset="0" stop-color="#c98a12" stop-opacity=".55"/><stop offset="1" stop-color="#c98a12" stop-opacity="0"/></radialGradient></defs>`;
    // The street map already names the neighborhoods; extra labels only collide with the pins.
  s += `<g id="hLines"></g>`;
  for (const v of venues) { const [x, y] = hPos.get(v.id)!; s += `<g class="hp" id="hp_${v.id}" data-v="${v.id}" style="--cc:${CUIS_COL[v.cuisine] ?? "#b9ad9f"}" transform="translate(${x} ${y})"><circle class="halo" r="11" fill="url(#hglow)"/><circle class="dot" r="4"/><g class="tag"></g></g>`; }
  // The office is a real map pin, labelled with the company, not a black square.
  const co = company.name.split(" ")[0];
  s += `<g class="hq" transform="translate(${HQ[0]} ${HQ[1]})"><circle class="pulse" r="7"/><path class="pin" d="M0 0C-3 -5 -6.5 -8 -6.5 -12.5A6.5 6.5 0 1 1 6.5 -12.5C6.5 -8 3 -5 0 0Z"/><circle class="pinc" cy="-12.5" r="2.4"/><rect class="lbl" x="${-co.length * 1.9 - 8}" y="3" width="${co.length * 3.8 + 16}" height="9" rx="4.5"/><text y="9.6">${esc(co)} HQ</text></g><g id="hFly"></g>`;
  $("#hMap").setAttribute("viewBox", `0 0 340 ${hVH}`); $("#hMap").innerHTML = s;
  // Pins are live: hover shows the place, tap opens its sheet (room, guests, night, real price, similar places).
  $$<SVGGElement>("#hMap .hp").forEach((g) => {
    const v = supply.find((x) => x.id === g.dataset.v)!, tip = $("#hTip");
    g.onmouseenter = () => { if (hBusy) return; const r = g.getBoundingClientRect(), st = $("#hLive .hstage").getBoundingClientRect(); tip.style.left = `${r.left + r.width / 2 - st.left}px`; tip.style.top = `${r.top - st.top}px`; tip.innerHTML = `<div style="background-image:url('${venuePhoto(v.id, 420, 200)}')"></div><p><b>${esc(v.name)}</b>${esc(v.cuisine)} · ${esc(v.neighborhood)} · from ${usd(fromPerHead(v))}/head</p>`; tip.style.display = "block"; };
    g.onmouseleave = () => { tip.style.display = "none"; };
    g.onclick = () => { if (!hBusy && !g.classList.contains("mailed") && !g.classList.contains("offer") && !g.classList.contains("win") && !g.classList.contains("no") && !g.classList.contains("inj")) { tip.style.display = "none"; openVenue(v); } };
  });
}
const hp = (id: string) => $(`#hp_${id}`) as unknown as SVGGElement;
function hTag(id: string, text: string, cls: string) {
  const g = hp(id); if (!g) return; g.setAttribute("class", `hp ${cls}`);
  const tag = g.querySelector(".tag")! as SVGGElement;
  // Less text on the map: only prices, injections and the winner get a label; everything else is told by colour.
  if (!/offer|inj|win/.test(cls)) { tag.innerHTML = ""; delete tag.dataset.side; return; }
  const w = text.length * 3.4 + 8, [x, y] = hPos.get(id)!;
  const hq = (side: string) => { const ty = side === "down" ? y + 8 : y - 12; return Math.abs(HQ[0] - x) < w / 2 + 8 && Math.abs(HQ[1] - ty) < 14; };
  const taken = (side: string) => hq(side) || [...$$<SVGGElement>(`.hp .tag[data-side='${side}']`)].some((t) => { const o = t.closest(".hp")!.id.slice(3); if (o === id || !t.innerHTML) return false; const [ox, oy] = hPos.get(o)!; return Math.abs(ox - x) < (w + 40) / 2 && Math.abs(oy - y) < 22; });
  if (!tag.dataset.side) tag.dataset.side = !taken("up") ? "up" : !taken("down") ? "down" : "right";
  const side = tag.dataset.side, dy = side === "down" ? 20 : side === "right" ? 6 : 0, dx = side === "right" ? w / 2 + 8 : 0;
  tag.innerHTML = `<rect x="${dx - w / 2}" y="${-17 + dy}" width="${w}" height="10" rx="5"/><text x="${dx}" y="${-10 + dy}">${esc(text)}</text>`;
}
function hPath(id: string) {
  const [x, y] = hPos.get(id)!, [hx, hy] = HQ, mx = (x + hx) / 2, my = Math.min(y, hy) - 30;
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
async function hRun(text: string, opt: { preferVenueId?: string } = {}) {
  if (hBusy || !text.trim()) return; hBusy = true; hDone = false; hQuiet = ""; hRuns++;
  const btn = $<HTMLButtonElement>("#hGo"); btn.disabled = true; $<HTMLInputElement>("#hIn").value = text;
  hMap(); $("#hPhone").innerHTML = `<div class="ph-s">Concierge is on it…</div>`; $("#hRes").innerHTML = ""; $("#hMap").classList.add("running"); $("#hMap").classList.remove("done");
  const c = { mail: 0, rep: 0, off: 0, inj: 0 }; ["hcMail", "hcRep", "hcOff", "hcInj"].forEach((i) => ($(`#${i}`).textContent = "0"));
  const store = new MemoryStore(); await store.init(supply); stores.push(store); srcOf.set(store, "Home");
  const pool: Behavior[] = ["accept", "injection", "counter_price", "decline", "accept", "accept_slow", "counter_capacity"], seen = new Map<string, Behavior>();
  const world = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, pool[(seen.size + hRuns) % pool.length]); return seen.get(id)!; }, NOW, 60 + hRuns);
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
      await Promise.all(names.map(async (n, i) => { const v = supply.find((x) => x.name === n); if (!v) return; await sleep(i * 180); const p = hPath(v.id); lines.set(v.id, p); hTag(v.id, "emailed", "cand mailed"); await hFly(p, false, "out"); hCount("hcMail", ++c.mail); }));
      await sleep(300);
    });
    if (e.kind === "injection_flagged") q(async () => { const v = vByName(e.text); if (!v) return; const p = lines.get(v.id); if (p) await hFly(p, true, "bad", 600); hTag(v.id, "⚠ injection ignored", "inj"); hCount("hcInj", ++c.inj); toast("Injection blocked", `${v.name} tried to change who gets paid`, "bad"); await sleep(500); });
    if (e.kind === "reply") q(async () => { const v = vByName(e.text); if (!v) return; const p = lines.get(v.id); if (p) await hFly(p, true, "in", 600); hCount("hcRep", ++c.rep); const lab = e.text.split(": ")[1]?.split(" ")[0] ?? "";
      if (lab === "decline") hTag(v.id, "✕ declined", "no"); else if (lab === "auto_reply") hTag(v.id, "out of office", "wait"); else if (!hp(v.id)?.classList.contains("inj")) hTag(v.id, "replied", "cand mailed"); });
    if (e.kind === "offer") q(async () => { const o = e.data?.offer as Offer | undefined; if (!o) return; hCount("hcOff", ++c.off); if (!hp(o.venueId)?.classList.contains("inj")) hTag(o.venueId, `offer${isAI(e) ? " ✳" : ""}`, "offer"); await sleep(250); });
    if (e.kind === "gave_up" || e.kind === "follow_up") q(async () => { const v = vByName(e.text); if (v) hTag(v.id, e.kind === "gave_up" ? "no reply" : "nudged", "wait"); });
    if (e.kind === "compared") q(async () => {
      hStage("compare");
      for (const u of (e.data?.usable ?? []) as { venue: string; perHeadAllIn: number }[]) { const v = supply.find((x) => x.name === u.venue); if (v) { const inj = hp(v.id)?.classList.contains("inj"); hTag(v.id, `$${Math.round(u.perHeadAllIn)}/head${inj ? " · ⚠ ignored" : ""}`, inj ? "offer inj" : "offer"); } }
      for (const r of (e.data?.rejected ?? []) as { venue: string; why: string }[]) { const v = supply.find((x) => x.name === r.venue); if (v && !hp(v.id)?.classList.contains("inj")) hTag(v.id, `✕ ${r.why.replace(/needs[ _]human/, "unclear reply").replace(/_/g, " ").split(/[,;(]/)[0].slice(0, 22)}`, "no"); }
      await sleep(700);
    });
    if (e.kind === "replan" && /quiet tables/.test(e.text)) hQuiet = e.text.match(/lowest (\$[\d,]+) a head/)?.[1] ?? "over the cap";
    if (e.kind === "replan") q(async () => { if (/quiet tables/.test(e.text)) toast("No private room fits the cap", "Shortlisting quiet tables instead", "warn"); else toast("Widening the search", "First round came back empty", "warn"); $$<SVGGElement>(".hp.cand").forEach((g) => g.classList.add("spent")); await sleep(400); });
    if (e.kind === "booked") q(() => hStage("book"));
  };
  const approver: Approver = async (p, st) => {
    await chain;
    if (p.kind === "pay_deposit") { for (const r of p.requiredRoles) await st.decide(p.id, approverFor(r, priya).id, r, "approve"); return "approved"; }
    hStage("approve"); const v = supply.find((x) => x.id === p.venueId)!, room = v.rooms.find((r) => r.id === p.roomId)!;
    hp(v.id)?.classList.add("win"); $("#hMap").classList.add("done");
    const ph = $("#hPhone"); ph.insertAdjacentHTML("beforeend", `<div class="ph-card"><div class="ph-v">${esc(v.name)}</div><div class="ph-r">${esc(room.name)} · ${esc(v.neighborhood)}</div>
      <div class="ph-g"><div><b>${when(p.startsAt)}</b><span>${localDate(p.startsAt).slice(5)}</span></div><div><b>${p.partySize}</b><span>guests</span></div><div><b>${usd(p.amountCents)}</b><span>all-in</span></div><div><b>${usd(Math.round(p.amountCents / p.partySize))}</b><span>per head</span></div></div>${v.preferredRatePct ? `<div class="ph-save">−${v.preferredRatePct}% corporate rate applied</div>` : ""}${hQuiet ? `<div class="ph-note">Private rooms start at ${esc(hQuiet)}/head · quiet table instead</div>` : ""}</div><div id="hSl"></div>`);
    ph.scrollTop = ph.scrollHeight;
    for (const role of p.requiredRoles) {
      const ok = await slideIn($("#hSl"), role === "booker" ? "Slide to book" : `Slide as ${approverFor(role, priya).name.split(" ")[0]}`);
      await st.decide(p.id, approverFor(role, priya).id, role, ok ? "approve" : "reject"); if (!ok) return "rejected";
    }
    return "approved";
  };
  const res = await runConcierge({ text, actor: priya, principal: dana, today: TODAY, store, world, llm, venues: supply, company, approver, onEvent, shortlistSize: opt.preferVenueId ? 1 : 4, preferVenueId: opt.preferVenueId });
  await chain; record(res, world, text);
  const ph = $("#hPhone");
  if (res.outcome === "booked" && res.chosenVenueId) {
    const v = supply.find((x) => x.id === res.chosenVenueId)!, bk = (await store.getBooking(res.bookingId!))!, room = v.rooms.find((r) => r.id === bk.roomId)!;
    const [x, y] = hPos.get(v.id)!; const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", `M${HQ[0]} ${HQ[1]} L${x} ${y}`); p.setAttribute("class", "hwin"); $("#hLines").append(p);
    ph.insertAdjacentHTML("beforeend", `<div class="ph-ok"><div class="ph-check">✓</div><b>Booked</b><span>${esc(v.name)} · ${when(bk.startsAt)}</span><span>${res.paymentId ? "Deposit paid to venue on file" : "No deposit"}</span></div>`);
    confetti(); toast("Booked", `${v.name} · ${bk.partySize} guests`);
    setLastBooking({ venue: v, roomName: room.name, partySize: bk.partySize, date: localDate(bk.startsAt), dietary: res.request?.dietary ?? [], client: res.request?.clientName ?? "Guests", world, threadId: `thr_${res.runId}_${v.id}` });
    $("#hRes").innerHTML = `<button class="btn" id="hIcs" title="Add to calendar">📅</button><button class="btn" id="hEm" title="Email it">✉</button><button class="btn" id="hMails" title="Venue emails">Threads</button><button class="btn pri" onclick="go('seating')">Seat</button><button class="btn" onclick="go('bookings')">Receipt</button>`;
    $("#hIcs").onclick = () => downloadIcs(v, room.name, bk.startsAt, bk.partySize); $("#hEm").onclick = () => emailIt(v, room.name, bk.startsAt, bk.partySize, res.proposals.find((x) => x.kind === "book")?.amountCents ?? 0, res.proposals.find((x) => x.kind === "pay_deposit")?.amountCents ?? 0, res.request?.clientName ?? ""); $("#hMails").onclick = () => showThreads(world, `Emails for ${res.request?.clientName ?? "this"} dinner`);
    renderGrid();
  } else {
    const last = res.messagesToBooker.at(-1) ?? "";
    ph.insertAdjacentHTML("beforeend", `<div class="ph-bot">${esc(last.length > 220 ? last.slice(0, 218) + "…" : last)}</div>`);
    $("#hRes").innerHTML = `<button class="btn" onclick="go('chat')">Answer in chat</button>`;
  }
  ph.scrollTop = ph.scrollHeight; $("#hMap").classList.remove("running"); btn.disabled = false; hBusy = false; hDone = true;
}
function confetti() {
  const box = $("#hConf"); const cols = ["#7b1e3a", "#c98a12", "#3f7d5a", "#5b6b8c", "#e7c27d"];
  for (let i = 0; i < 70; i++) { const s = el("i"); s.style.cssText = `left:${50 + (Math.random() - .5) * 30}%;background:${cols[i % 5]};--dx:${(Math.random() - .5) * 520}px;--dy:${-160 - Math.random() * 260}px;--r:${Math.random() * 720}deg;animation-delay:${Math.random() * 120}ms`; box.append(s); setTimeout(() => s.remove(), 1700); }
}
const HPH = ["dinner for 12 with the Acme team next Thursday, somewhere private", "private dinner for 20 with Globex next Friday", "team dinner for 8 this Friday under $100 a head", "japanese dinner for 8 with Wayne Enterprises next Tuesday, private"];
{ let i = 0; setInterval(() => { const inp = $<HTMLInputElement>("#hIn"); if (document.activeElement !== inp && !inp.value) inp.placeholder = HPH[i++ % HPH.length]; }, 2600); }
$("#hChips").innerHTML = HPH.slice(0, 3).map((t) => `<button class="chip" data-t="${esc(t)}">${esc(t.length > 42 ? t.slice(0, 40) + "…" : t)}</button>`).join("");
$$<HTMLButtonElement>("#hChips .chip").forEach((b) => b.onclick = () => void hRun(b.dataset.t!));
$("#hMap").addEventListener("click", (e) => { const g = (e.target as Element).closest(".hp"); if (!g || !hWorld) return; const id = g.id.slice(3), v = supply.find((x) => x.id === id)!; if (hWorld.sent().some((m) => m.venueId === id)) showThreads(hWorld, v.name, id); });
$<HTMLFormElement>("#hForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $<HTMLInputElement>("#hIn").value || $<HTMLInputElement>("#hIn").placeholder; void hRun(v); });
hm.onChange(() => { if (!hBusy && !hDone) hMap(); });
const hFit = () => hm.fit([...vLL.values(), OFFICE], innerWidth < 700 ? { top: 70, right: 16, bottom: 90, left: 16 } : { top: 92, right: 40, bottom: 74, left: 40 });
requestAnimationFrame(() => { hFit(); hMap(); });

// =====================================================================
// VOICE: say the request
// =====================================================================
function mic(btn: HTMLButtonElement, input: HTMLInputElement, done: (t: string) => void) {
  const SR = (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
  if (!SR) { btn.remove(); return; }
  let rec: any = null;
  btn.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; let text = "";
    rec.onresult = (e: any) => { text = [...e.results].map((r: any) => r[0].transcript).join(""); input.value = text; };
    rec.onerror = (e: any) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Microphone blocked", "Allow it in the browser to talk to the concierge", "warn"); };
    rec.onend = () => { btn.classList.remove("rec"); rec = null; if (text.trim()) done(text.trim()); };
    btn.classList.add("rec"); input.value = ""; input.placeholder = "Listening…"; rec.start();
  };
}
mic($<HTMLButtonElement>("#hMic"), $<HTMLInputElement>("#hIn"), (t) => void hRun(t));
mic($<HTMLButtonElement>("#cMic"), $<HTMLInputElement>("#chatIn"), (t) => void chatSend(t));

// First visit to a page that shows results: run it, so nobody lands on an empty screen.
const autoRan = new Set<string>();
function autoRun(page: string) {
  if (autoRan.has(page) || touring) return; autoRan.add(page);
  setTimeout(() => {
    if (!$(`#p-${page}.on`)) { autoRan.delete(page); return; }
    if (page === "controls") $<HTMLButtonElement>("#runAll").click();
    if (page === "evals") $<HTMLButtonElement>("#runEvals").click();
    if (page === "compare" && !cmpRows.length) void cmpLoad(replayLLM);
    if (page === "fix") $<HTMLButtonElement>("#fixGo").click();
    if (page === "memory") $<HTMLButtonElement>("#rkGo").click();
  }, 450);
}

// =====================================================================
// VENUE SIDE: the marketplace's other half. You answer the agent's inquiry as the restaurant; your email is read
// exactly like a simulated venue's (same extraction, same injection check, same policy comparison).
// =====================================================================
const ptStats = { asked: 0, won: 0, revenue: 0 };
let ptBusy = false;
const PT_QUICK: [string, Behavior][] = [["Offer the room", "accept"], ["Raise the minimum", "counter_price"], ["Another night", "counter_date"], ["Room's too small", "counter_capacity"], ["Fully booked", "decline"], ["Slip in a scam", "injection"]];
function ptRenderBook() { $("#ptBook").innerHTML = [["Inquiries", ptStats.asked], ["Won", ptStats.won], ["Revenue", usd(ptStats.revenue)]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(""); }
function ptStep(text: string, cls = "") { $$("#ptSteps .wait").forEach((x) => x.classList.remove("wait")); $("#ptSteps").append(el("div", `ptst ${cls}`, `<i></i>${esc(text)}`)); }
async function ptRun() {
  const text = $<HTMLInputElement>("#ptAsk").value.trim(); if (ptBusy || !text) return; ptBusy = true;
  const go = $<HTMLButtonElement>("#ptGo"), send = $<HTMLButtonElement>("#ptSend"), skip = $<HTMLButtonElement>("#ptSkip"), box = $<HTMLTextAreaElement>("#ptReply"); go.disabled = true;
  $("#ptSteps").innerHTML = ""; $("#ptRead").innerHTML = `<div class="empty">Your reply is read here.</div>`; $("#ptVerdict").innerHTML = ""; $("#ptQuick").innerHTML = ""; box.value = "";
  $("#ptMail").innerHTML = `<div class="empty">The agent is choosing venues…</div>`; $("#ptWho").textContent = "Your inbox";
  const store = new MemoryStore(); await store.init(supply);
  const rest: Behavior[] = ["accept", "counter_price", "decline"], seen = new Map<string, Behavior>();
  const world = new VenueWorld(supply, (id) => { if (!seen.has(id)) seen.set(id, rest[seen.size % rest.length]); return seen.get(id)!; }, NOW, 31 + ptStats.asked);
  let mine: Venue | null = null;
  world.playFirstVenue((venueId, inquiry, meta) => new Promise<string | null>((resolve) => {
    mine = supply.find((v) => v.id === venueId)!; ptStats.asked++; ptRenderBook();
    $("#ptWho").textContent = `Your inbox · ${mine.name}`;
    $("#ptMail").innerHTML = `<div class="from">From the concierge · ${esc(company.name)}</div>${esc(inquiry.body)}`;
    $("#ptQuick").innerHTML = PT_QUICK.map(([l, b]) => `<button data-b="${b}" class="${b === "injection" ? "scam" : ""}">${l}</button>`).join("");
    $$<HTMLButtonElement>("#ptQuick button").forEach((q) => q.onclick = () => { $$("#ptQuick button").forEach((x) => x.classList.remove("on")); q.classList.add("on"); box.value = world.draft(venueId, q.dataset.b as Behavior, meta); });
    box.disabled = false; send.disabled = false; skip.disabled = false; ptStep("Venues emailed · waiting for you", "wait");
    const done = (t: string | null) => { box.disabled = true; send.disabled = true; skip.disabled = true; $$<HTMLButtonElement>("#ptQuick button").forEach((x) => (x.disabled = true)); ptStep(t ? "Reply sent" : "You stayed silent", t ? "" : "bad"); resolve(t); };
    send.onclick = () => { if (box.value.trim()) done(box.value); else box.focus(); }; skip.onclick = () => done(null);
  }));
  const said: Record<string, string> = { parsed: "Request understood", sourced: "Venues shortlisted", followed_up: "The agent followed up", compared: "Offers compared against policy" };
  const shown = new Set<string>();
  const res = await runConcierge({
    text, actor: priya, principal: dana, today: TODAY, store, world, llm, venues: supply, company, shortlistSize: 3,
    onEvent: (e) => { if (said[e.kind] && !shown.has(e.kind)) { shown.add(e.kind); ptStep(said[e.kind]); } },
    approver: async (p, st) => { for (const r of p.requiredRoles) await st.decide(p.id, approverFor(r, priya).id, r, "approve"); return "approved"; },
  });
  record(res, world, "Venue side");
  const me = mine as Venue | null;
  if (!me) { $("#ptMail").innerHTML = `<div class="empty">No venue was emailed.</div>`; $("#ptVerdict").innerHTML = `<div class="ptv lose"><b>No inquiry</b><span>${esc(res.messagesToBooker.at(-1) ?? "")}</span></div>`; ptBusy = false; go.disabled = false; return; }
  const about = res.trace.filter((e) => e.agent === "coordination" && e.text.startsWith(me.name));
  const o = about.find((e) => e.kind === "offer")?.data?.offer as { roomName: string | null; minSpendCents: number | null; depositPct: number | null; holdExpiresHours: number | null; capacity: number | null; alternativeDates?: string[] } | undefined;
  const flagged = about.some((e) => e.kind === "injection_flagged");
  $("#ptRead").innerHTML = (o ? `<div class="ptf">${[["Room", o.roomName ?? "–"], ["Minimum", o.minSpendCents !== null ? usd(o.minSpendCents) : "–"], ["Deposit", o.depositPct !== null ? `${o.depositPct}%` : "–"], ["Hold", o.holdExpiresHours ? `${o.holdExpiresHours} h` : "–"]].map(([k, v]) => `<div><span>${k}</span><b>${esc(String(v))}</b></div>`).join("")}</div>`
    : `<div class="empty">${about.some((e) => e.kind === "gave_up") ? "No reply to read." : "Read as: not an offer."}</div>`)
    + (flagged ? `<div class="ptflag">⚠ Instructions in your email were ignored. The booker was warned.</div>` : "");
  const won = res.outcome === "booked" && res.chosenVenueId === me.id, cmp = res.trace.filter((e) => e.kind === "compared").at(-1)?.data as { usable: { venue: string; perHeadAllIn: number }[]; rejected: { venue: string; why: string }[] } | undefined;
  if (won) {
    const bk = res.proposals.find((p) => p.kind === "book")!, dep = res.proposals.find((p) => p.kind === "pay_deposit");
    ptStats.won++; ptStats.revenue += bk.amountCents; ptRenderBook(); confetti();
    $("#ptVerdict").innerHTML = `<div class="ptv win"><b>You won it · ${usd(bk.amountCents)}</b><span>${bk.partySize} guests${dep ? ` · ${usd(dep.amountCents)} deposit paid to your account on file` : ""}</span></div>`;
    ptStep("Booked with you");
  } else {
    const why = cmp?.rejected.find((r) => r.venue === me.name)?.why, winner = res.chosenVenueId ? supply.find((v) => v.id === res.chosenVenueId)! : null;
    const mineP = cmp?.usable.find((u) => u.venue === me.name)?.perHeadAllIn, theirP = winner ? cmp?.usable.find((u) => u.venue === winner.name)?.perHeadAllIn : undefined;
    const line = flagged && winner ? `${winner.name} took it: a venue whose email didn't try to instruct the agent` : why ? why[0].toUpperCase() + why.slice(1) : mineP && theirP ? `${winner!.name} came in at $${Math.round(theirP)} a head; you were $${Math.round(mineP)}` : winner ? `${winner.name} took it` : "Nobody was booked";
    $("#ptVerdict").innerHTML = `<div class="ptv lose"><b>Not this time</b><span>${esc(line)}</span></div>`;
    ptStep(winner ? `Booked with ${winner.name}` : "No booking", "bad");
  }
  ptBusy = false; go.disabled = false;
}
$("#ptGo").onclick = () => void ptRun(); $<HTMLInputElement>("#ptAsk").onkeydown = (e) => { if (e.key === "Enter") void ptRun(); };
ptRenderBook();

// =====================================================================
// INVOICE: every confirmed dinner on one statement, pre-coded to a cost center, PO and GL account. Drag a line
// onto a budget (or tap its chip) to recode it; the PO balances follow.
// =====================================================================
const CENTERS = [
  { id: "sales", name: "Sales", po: "PO-4411", gl: "6420 Client entertainment", budget: 400_000, color: "#7b1e3a" },
  { id: "mkt", name: "Marketing", po: "PO-4412", gl: "6435 Events", budget: 300_000, color: "#b8862b" },
  { id: "exec", name: "Executive", po: "PO-4413", gl: "6420 Client entertainment", budget: 300_000, color: "#5b6b8c" },
  { id: "people", name: "People", po: "PO-4414", gl: "6450 Team events", budget: 200_000, color: "#3f7d5a" },
];
const invCode = new Map<string, string>();
const centerOf = (r: BkRow) => CENTERS.find((c) => c.id === (invCode.get(r.id) ?? CENTERS[Math.max(0, supply.indexOf(r.v)) % 3].id))!;
async function invRows() { return (await bkRows()).filter((r) => r.status === "confirmed" && r.src !== "Live desk"); }
let invMonth = "all", invCenter: string | null = null, invSel: string | null = null;
const monthOf = (r: BkRow) => localDate(r.startsAt).slice(0, 7);
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString([], { month: "long", year: "numeric" });
async function renderInvoice() {
  const all = await invRows(), months = [...new Set(all.map(monthOf))].sort();
  if (invMonth !== "all" && !months.includes(invMonth)) invMonth = "all";
  $("#invMonth").innerHTML = [`<button data-m="all" class="${invMonth === "all" ? "on" : ""}">All months</button>`, ...months.map((m) => `<button data-m="${m}" class="${invMonth === m ? "on" : ""}">${monthName(m).split(" ")[0]}</button>`)].join("");
  $$<HTMLButtonElement>("#invMonth button").forEach((b) => b.onclick = () => { invMonth = b.dataset.m!; invSel = null; void renderInvoice(); });
  const inMonth = all.filter((r) => invMonth === "all" || monthOf(r) === invMonth);
  const rows = inMonth.filter((r) => !invCenter || centerOf(r).id === invCenter);
  const total = rows.reduce((a, r) => a + r.approved, 0), saved = rows.reduce((a, r) => a + receipt(r).disc, 0), guests = rows.reduce((a, r) => a + r.partySize, 0);
  const spent = (id: string) => inMonth.filter((r) => centerOf(r).id === id).reduce((a, r) => a + r.approved, 0);
  $("#invVisit").textContent = `${me.name} · ${visitLine()}`;
  $("#invFilt").innerHTML = invCenter ? `Showing ${CENTERS.find((c) => c.id === invCenter)!.name} only · <a href="#" id="invClr">show all</a>` : "";
  $("#invClr")?.addEventListener("click", (e) => { e.preventDefault(); invCenter = null; void renderInvoice(); });
  $("#invKpis").innerHTML = [["Dinners", rows.length], ["Invoice total", usd(total)], ["Per guest", guests ? usd(Math.round(total / guests)) : "–"], ["Saved · preferred rates", usd(saved)], ["Budgets over", CENTERS.filter((c) => spent(c.id) > c.budget).length]].map(([k, v]) => `<div class="tk"><span>${k}</span><b>${v}</b></div>`).join("");
  $("#invPos").innerHTML = CENTERS.map((c) => { const sp = spent(c.id), over = sp > c.budget, n = inMonth.filter((r) => centerOf(r).id === c.id).length; return `<div class="invpo ${over ? "bust" : ""} ${invCenter === c.id ? "flt" : ""}" data-c="${c.id}"><div class="top"><b>${c.name}</b><span>${c.po} · ${n} dinner${n === 1 ? "" : "s"}</span></div><div class="pbar"><i style="width:${Math.min(100, (sp / c.budget) * 100)}%;background:${c.color}"></i></div><small>${usd(sp)} of ${usd(c.budget)}${over ? ` · over by ${usd(sp - c.budget)}` : ` · ${usd(c.budget - sp)} left`} · GL ${c.gl}</small></div>`; }).join("");
  const tot = CENTERS.reduce((a, c) => a + spent(c.id), 0) || 1;
  $("#invMix").innerHTML = `<div class="pt">Where the money went</div><div class="mixbar">${CENTERS.map((c) => `<i title="${c.name}: ${usd(spent(c.id))}" style="width:${(spent(c.id) / tot) * 100}%;background:${c.color}"></i>`).join("")}</div><div class="cs">${CENTERS.map((c) => `<span style="color:${c.color};font-weight:800">●</span> ${c.name} ${Math.round((spent(c.id) / tot) * 100)}%`).join(" &nbsp; ")}</div>`;
  $("#invLines").innerHTML = rows.length ? rows.map((r) => { const c = centerOf(r); return `<div class="invl ${invSel === r.id ? "sel" : ""}" draggable="true" data-id="${r.id}"><span>${localDate(r.startsAt).slice(5)}</span><div><b>${esc(r.v.name)}</b><small>${r.partySize} guests · ${esc(r.room.name)}${isPast(r.store) ? " · earlier visit" : ""}</small></div><span class="amt">${usd(r.approved)}</span><button class="invc" data-id="${r.id}" title="Tap to recode"><i style="background:${c.color}"></i>${c.name}</button></div>`; }).join("")
      + `<div class="invsub"><span>${rows.length} line${rows.length === 1 ? "" : "s"} · ${guests} guests</span><b>${usd(total)}</b></div>`
    : `<div class="empty">${all.length ? "No dinners in this month or budget." : 'No confirmed dinners yet. <button class="btn pri" onclick="go(\'book\')">Book one</button>'}</div>`;
  $$<HTMLButtonElement>("#invLines .invc").forEach((b) => b.onclick = (e) => { e.stopPropagation(); const r = rows.find((x) => x.id === b.dataset.id)!, i = CENTERS.indexOf(centerOf(r)); invCode.set(r.id, CENTERS[(i + 1) % CENTERS.length].id); histDirty = true; void renderInvoice(); });
  $$<HTMLElement>("#invLines .invl").forEach((l) => {
    l.onclick = () => { invSel = invSel === l.dataset.id ? null : l.dataset.id!; void renderInvoice(); };
    l.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/plain", l.dataset.id!); l.classList.add("drag"); }); l.addEventListener("dragend", () => l.classList.remove("drag"));
  });
  $$<HTMLElement>("#invPos .invpo").forEach((po) => {
    po.onclick = () => { invCenter = invCenter === po.dataset.c ? null : po.dataset.c!; void renderInvoice(); };
    po.addEventListener("dragover", (e) => { e.preventDefault(); po.classList.add("over"); }); po.addEventListener("dragleave", () => po.classList.remove("over"));
    po.addEventListener("drop", (e) => { e.preventDefault(); const id = e.dataTransfer!.getData("text/plain"); if (id) { invCode.set(id, po.dataset.c!); histDirty = true; toast("Recoded", `Moved to ${CENTERS.find((c) => c.id === po.dataset.c)!.name}`); void renderInvoice(); } });
  });
  const sel = rows.find((r) => r.id === invSel);
  if (sel) {
    const rc = receipt(sel), c = centerOf(sel), prop = await sel.store.getProposal(sel.proposalId), run = runsLog.findIndex((x) => x.id === prop?.runId);
    const line = (k: string, v: string, cls = "") => `<div class="rl ${cls}"><span>${k}</span><b>${v}</b></div>`;
    $("#invRcpt").innerHTML = `<div class="rcpt"><div class="trh"><b>${esc(sel.v.name)} · ${esc(sel.room.name)}</b><span class="mono">${sel.id}</span></div><div class="cs" style="margin-bottom:8px">${when(sel.startsAt)}, ${localDate(sel.startsAt)} · ${sel.partySize} guests · ${c.name} (${c.po}, ${c.gl})</div>
      ${line(rc.min ? "Room minimum" : `Food and drink, ${usd(rc.per)} × ${sel.partySize}`, usd(rc.list))}${rc.disc ? line(`Preferred rate, ${sel.v.preferredRatePct}% off`, `−${usd(rc.disc)}`) : ""}${line("Tax 8.875%", usd(rc.tax))}${line("Service 20%", usd(rc.svc))}${line("Estimated all-in", usd(rc.total), "t")}
      ${line("Approved amount", usd(sel.approved))}${line("Deposit paid", sel.paid ? `${usd(sel.paid)} → ${esc(sel.v.payeeId)} (payee on file)` : "none")}${line("Approvals", prop ? prop.requiredRoles.join(" + ") : "–")}
      <div class="row" style="margin-top:10px;gap:8px">${run >= 0 ? `<button class="btn" id="rcTrace">Open the agent run ↗</button>` : `<span class="cs">Agent run from an earlier session not kept.</span>`}<button class="btn" id="rcBk">Open in Bookings</button></div></div>`;
    $("#rcTrace")?.addEventListener("click", () => { trSel = run; trEv = -1; go("traces"); });
    $("#rcBk").onclick = () => { bkPick = sel.id; go("bookings"); };
  } else $("#invRcpt").innerHTML = rows.length ? '<div class="cs" style="margin-top:10px">Tap a line to see its receipt, approvals and the agent run behind it.</div>' : "";
}
$("#invCsv").onclick = async () => {
  const rows = await invRows(), q = (x: string | number) => `"${String(x).replace(/"/g, '""')}"`;
  const csv = [["date", "venue", "room", "guests", "cost_center", "po", "gl_account", "amount_usd", "saved_usd"].join(","),
    ...rows.map((r) => { const c = centerOf(r); return [localDate(r.startsAt), r.v.name, r.room.name, r.partySize, c.name, c.po, c.gl, (r.approved / 100).toFixed(2), (receipt(r).disc / 100).toFixed(2)].map(q).join(","); })].join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `entertainment-invoice-${TODAY.slice(0, 7)}.csv`; document.body.append(a); a.click(); a.remove();
};

// =====================================================================
// AGENT WATCH: the scheduled runs (npm run monitor, 3x a day in CI), read from the repo so the page is always current
// =====================================================================
interface MonRow { at: string; mode: string; model: string; scenarios: { ran: number; passed: number; ids: string[] }; modelDecisions: { parse: number; offers: number; fellBack: number }; worlds: { ran: number; checks: number; failed: number }; users: { ran: number; asExpected: number }; calls: number; p50ms: number; p95ms: number; costUsd: number; ok: boolean }
const MON_SRC = ["https://raw.githubusercontent.com/AKilalours/thursday-dinner-concierge/main/docs/monitor.json", "./monitor.json"];
let monRows: MonRow[] | null = null;
async function loadMonitor(): Promise<MonRow[]> {
  for (const u of MON_SRC) { try { const r = await fetch(u, { cache: "no-store" }); if (r.ok) { const d = await r.json(); if (Array.isArray(d)) return d as MonRow[]; } } catch { /* next source */ } }
  return [];
}
function ago(iso: string) { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; }
function spark(vals: number[], opt: { max?: number; min?: number; color: string; fmt: (v: number) => string; second?: number[] }) {
  if (!vals.length) return `<div class="none">The first scheduled run will appear here.</div>`;
  const W = 420, H = 150, P = 22, max = opt.max ?? Math.max(...vals, ...(opt.second ?? []), 1), min = opt.min ?? 0;
  const x = (i: number) => P + (vals.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (vals.length - 1)), y = (v: number) => H - P - ((v - min) / Math.max(1e-9, max - min)) * (H - 2 * P);
  const line = (vs: number[], c: string, w: number) => `<polyline fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" points="${vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`;
  const last = vals.at(-1)!;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="#e8dfd2"/>${opt.second ? line(opt.second, "#c9a46a", 1.5) : ""}${line(vals, opt.color, 2.5)}<circle cx="${x(vals.length - 1)}" cy="${y(last)}" r="4" fill="${opt.color}"/><text x="${W - P}" y="14" text-anchor="end" font-size="12" font-weight="700" fill="${opt.color}">${opt.fmt(last)}</text></svg>`;
}
let moRange: string = "10", moSel: string | null = null;
function nextRun() {
  // Agent Watch cron: 12:17, 20:17 and 04:17 UTC.
  const now = new Date(), cands = [4, 12, 20].flatMap((h) => [0, 1].map((d) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, h, 17)));
  const t = Math.min(...cands.filter((x) => x > now.getTime())), m = Math.round((t - now.getTime()) / 60000);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function sparkPts(vals: number[], labels: string[], opt: { max?: number; min?: number; color: string; fmt: (v: number) => string; second?: number[] }) {
  const base = spark(vals, opt); if (!vals.length) return base;
  const W = 420, H = 150, P = 22, max = opt.max ?? Math.max(...vals, ...(opt.second ?? []), 1), min = opt.min ?? 0;
  const x = (i: number) => P + (vals.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (vals.length - 1)), y = (v: number) => H - P - ((v - min) / Math.max(1e-9, max - min)) * (H - 2 * P);
  return base.replace("</svg>", vals.map((v, i) => `<circle class="pt" data-at="${labels[i]}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="#fff" stroke="${opt.color}" stroke-width="2"><title>${new Date(labels[i]).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: ${opt.fmt(v)}</title></circle>`).join("") + "</svg>");
}
async function renderMonitor() {
  if (!monRows) monRows = await loadMonitor();
  const allRows = monRows, rows = moRange === "all" ? allRows : allRows.slice(-Number(moRange)), live = allRows.filter((r) => r.mode === "live" || r.mode === "record");
  $$<HTMLButtonElement>("#moRange button").forEach((b) => { b.classList.toggle("on", b.dataset.r === moRange); b.onclick = () => { moRange = b.dataset.r!; void renderMonitor(); }; });
  const worlds = allRows.reduce((a, r) => a + r.worlds.ran, 0), checks = allRows.reduce((a, r) => a + r.worlds.checks, 0), fails = allRows.filter((r) => !r.ok).length;
  const dec = live.reduce((a, r) => a + r.modelDecisions.parse + r.modelDecisions.offers, 0), fb = live.reduce((a, r) => a + r.modelDecisions.fellBack, 0);
  const days = live.length ? Math.max(1, (Date.parse(live.at(-1)!.at) - Date.parse(live[0].at)) / 86_400_000) : 1;
  { const ok = allRows.length - fails, pctOk = allRows.length ? ok / allRows.length : 1, C = 2 * Math.PI * 40, last = allRows.at(-1);
    $("#moHero").innerHTML = `<svg class="ring" viewBox="0 0 96 96"><circle cx="48" cy="48" r="40" fill="none" stroke="#ffffff22" stroke-width="10"/><circle cx="48" cy="48" r="40" fill="none" stroke="${fails ? "#ff6b81" : "#5fd38d"}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pctOk)}" transform="rotate(-90 48 48)"/><text x="48" y="54" text-anchor="middle" fill="#fff" font-size="20" font-weight="700" font-family="Fraunces,Georgia,serif">${Math.round(pctOk * 100)}%</text></svg>
      <div><h2><span class="pulse ${last && !last.ok ? "bad" : ""}"></span>${last && !last.ok ? "Last run failed" : "All checks green"}</h2><p>${allRows.length} scheduled runs · last ${last ? ago(last.at) : "pending"} · next in ${nextRun()} · ${live.length ? "live Claude" : "recorded Claude until the key is seen"}</p></div>
      <div class="mstat"><div><b>${worlds.toLocaleString()}</b><span>worlds</span></div><div><b>${checks.toLocaleString()}</b><span>safety checks</span></div><div><b>${fails}</b><span>failures</span></div></div>`; }
  $("#moKpis").innerHTML = [["Runs", allRows.length], ["Last run", allRows.length ? ago(allRows.at(-1)!.at) : "pending"], ["Next run", `in ${nextRun()}`], ["Failed runs", fails], ["Worlds tested", worlds.toLocaleString()],
    ["Safety checks", checks.toLocaleString()], ["Live runs", `${live.length} of ${allRows.length}`], ["Model decided", dec + fb ? `${Math.round((dec / (dec + fb)) * 100)}%` : "–"], ["p50 live", live.length ? `${live.at(-1)!.p50ms} ms` : "–"], ["Cost / day", live.length ? `$${(live.reduce((a, r) => a + r.costUsd, 0) / days).toFixed(2)}` : "$0.00"]]
    .filter(([k]) => !["Runs", "Last run", "Next run", "Failed runs", "Worlds tested", "Safety checks"].includes(String(k))) // the status card above shows these
    .map(([k, v]) => `<div class="tk"><span>${k}</span><b>${v}</b></div>`).join("");
  $("#moStrip").innerHTML = allRows.map((r) => `<button class="${r.ok ? "" : "bad"} ${r.mode === "live" || r.mode === "record" ? "live" : ""} ${moSel === r.at ? "on" : ""}" data-at="${r.at}" title="${new Date(r.at).toLocaleString()} · ${r.ok ? "passed" : "failed"} · ${r.mode === "replay" ? "recorded" : "live"}"></button>`).join("") || '<span class="cs">The first scheduled run will appear here.</span>';
  const labels = rows.map((r) => r.at);
  $("#moPass").innerHTML = sparkPts(rows.map((r) => (r.scenarios.passed / Math.max(1, r.scenarios.ran)) * 100), labels, { max: 100, min: 0, color: "#3f7d5a", fmt: (v) => `${Math.round(v)}% scenarios` });
  let acc = allRows.slice(0, allRows.length - rows.length).reduce((a, r) => a + r.worlds.ran, 0);
  $("#moWorlds").innerHTML = sparkPts(rows.map((r) => (acc += r.worlds.ran)), labels, { color: "#7b1e3a", fmt: (v) => `${v.toLocaleString()} worlds` });
  const lr = rows.filter((r) => r.mode === "live" || r.mode === "record");
  $("#moLat").innerHTML = lr.length ? sparkPts(lr.map((r) => r.p50ms), lr.map((r) => r.at), { color: "#5b6b8c", fmt: (v) => `${v} ms p50`, second: lr.map((r) => r.p95ms) }) : `<div class="none">No live runs in this range yet. The next run uses live Claude now that the key is set (in ${nextRun()}).</div>`;
  $$<SVGCircleElement>("#p-monitor circle.pt").forEach((c) => c.addEventListener("click", () => { moSel = c.dataset.at!; void renderMonitor(); }));
  $$<HTMLButtonElement>("#moStrip button").forEach((b) => b.onclick = () => { moSel = moSel === b.dataset.at ? null : b.dataset.at!; void renderMonitor(); });
  const shown = moSel && !rows.some((r) => r.at === moSel) ? [...rows, allRows.find((r) => r.at === moSel)!] : rows;
  $("#moRuns").innerHTML = shown.length ? `<div class="mowrap"><table class="mot"><thead><tr><th>When</th><th>Model</th><th>Scenarios</th><th>New worlds</th><th>Real-user</th><th>Calls</th><th>p50</th><th>Cost</th><th></th></tr></thead><tbody>${shown.slice().reverse().map((r) => `<tr class="mor ${moSel === r.at ? "on" : ""}" data-at="${r.at}"><td>${new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${r.mode === "replay" ? "recorded" : `<b style="color:#8a6420">● ${esc(r.model)}</b>`}</td><td>${r.scenarios.passed}/${r.scenarios.ran}</td><td>${r.worlds.ran} · ${r.worlds.failed} failed</td><td>${r.users.asExpected}/${r.users.ran}</td><td>${r.calls}</td><td>${r.p50ms ? `${r.p50ms} ms` : "–"}</td><td>$${r.costUsd.toFixed(3)}</td><td class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"}</td></tr>${moSel === r.at ? `<tr class="modet"><td colspan="9"><b>Scenarios run:</b> ${r.scenarios.ids.map(esc).join(", ")}<br><b>Model decided:</b> ${r.modelDecisions.parse} request parses, ${r.modelDecisions.offers} offer readings, ${r.modelDecisions.fellBack} fell back to rules · <b>Safety checks:</b> ${r.worlds.checks.toLocaleString()} in ${r.worlds.ran} never-seen worlds · <b>Real-user sentences:</b> ${r.users.asExpected} of ${r.users.ran} as a person would expect<br>Full report: <a href="https://github.com/AKilalours/thursday-dinner-concierge/tree/main/evals/history" target="_blank" rel="noopener">evals/history/${r.at.slice(0, 13).replace("T", "_")}.json ↗</a></td></tr>` : ""}`).join("")}</tbody></table></div>`
    : `<p style="color:var(--dim);margin:0">No scheduled runs yet. They run at about 7:17 am, 3:17 pm and 11:17 pm New York time.</p>`;
  $$<HTMLElement>("#moRuns tr.mor").forEach((t) => t.onclick = () => { moSel = moSel === t.dataset.at ? null : t.dataset.at!; void renderMonitor(); });
}

// =====================================================================
// TRACES: every run's spans and every model call, the way you'd debug it in production
// =====================================================================
let trSel = 0, trEv = -1;
function renderTraces() { try { renderTracesInner(); } catch (err) { console.warn("traces", err); } }
let trQ = "", trOut = "all", trPlay: ReturnType<typeof setInterval> | null = null;
const trHide = new Set<string>();
const askedOut = (o: string) => o === "needs_clarification";
function renderTracesInner() {
  const calls = llmLog, live = calls.filter((c) => c.source === "live"), ok = calls.filter((c) => c.ok);
  const lat = ok.map((c) => c.ms).sort((a, b) => a - b), p = (q: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0;
  const cost = live.reduce((a, c) => a + c.tin * 3e-6 + c.tout * 15e-6, 0), spans = runsLog.reduce((a, r) => a + r.trace.length, 0);
  $("#trKpis").innerHTML = [["Runs", runsLog.length], ["Earlier visits", runsLog.filter((r) => r.past).length], ["Spans", spans.toLocaleString()], ["Booked", runsLog.filter((r) => r.outcome === "booked").length], ["Model calls", calls.length], ["Live", `${calls.length ? Math.round((live.length / calls.length) * 100) : 0}%`], ["p50", `${p(0.5)} ms`], ["Live cost", `$${cost.toFixed(3)}`]]
    .map(([k, v]) => `<div class="tk"><span>${k}</span><b>${v}</b></div>`).join("");
  const q = trQ.toLowerCase();
  const vis = runsLog.map((r, i) => ({ r, i })).filter(({ r }) => (trOut === "all" || (trOut === "booked" ? r.outcome === "booked" : trOut === "asked" ? askedOut(r.outcome) : r.outcome !== "booked" && !askedOut(r.outcome)))
    && (!q || `${r.label} ${r.outcome} ${r.trace.map((e) => e.text).join(" ")}`.toLowerCase().includes(q)));
  if (!vis.some((x) => x.i === trSel) && vis.length) { trSel = vis[0].i; trEv = -1; }
  $("#trRuns").innerHTML = vis.map(({ r, i }) => `<button class="trr ${i === trSel ? "on" : ""}" data-i="${i}"><i class="${r.outcome === "booked" ? "ok" : "bad"}"></i><div><b>${esc(r.label)}</b>${r.past ? '<span class="pastb">earlier visit</span>' : ""}<span class="mono">${new Date(r.at).toLocaleDateString([], { month: "short", day: "numeric" })} · ${r.trace.length} spans · ${r.emails} emails</span></div><em>${r.outcome.replace(/_/g, " ")}</em></button>`).join("") || `<div class="empty">${runsLog.length ? "No run matches." : "Runs appear as the agent works."}</div>`;
  $$<HTMLButtonElement>("#trRuns .trr").forEach((b) => b.onclick = () => { stopPlay(); trSel = Number(b.dataset.i); trEv = -1; renderTraces(); });
  const lanes = ["concierge", "sourcing", "coordination", "comparison"];
  $("#trLanes").innerHTML = lanes.map((l) => `<button class="chip ${trHide.has(l) ? "" : "on"}" data-l="${l}">${l}</button>`).join("");
  $$<HTMLButtonElement>("#trLanes .chip").forEach((b) => b.onclick = () => { if (trHide.has(b.dataset.l!)) trHide.delete(b.dataset.l!); else trHide.add(b.dataset.l!); renderTraces(); });
  const r = vis.length ? runsLog[trSel] : undefined;
  if (r) {
    const t0 = Date.parse(r.trace[0]?.at ?? r.trace.at(-1)?.at ?? ""), t1 = Date.parse(r.trace.at(-1)?.at ?? "") || t0 + 1, span = Math.max(1, t1 - t0);
    $("#trWater").innerHTML = `<div class="trh"><b>${esc(r.label)}</b><span class="mono">${r.id}</span></div><div class="row" style="gap:8px;margin:6px 0 8px"><button class="btn" id="trPlay">${trPlay ? "■ Stop" : "▶ Replay this run"}</button><span class="cs">${r.trace.length} spans over ${Math.max(1, Math.round(span / 60000))} simulated minutes · ${r.outcome.replace(/_/g, " ")}</span></div>` + r.trace.map((e, i) => {
      const x = ((Date.parse(e.at) - t0) / span) * 100, ai = isAI(e), nx = r.trace[i + 1] ? ((Date.parse(r.trace[i + 1].at) - t0) / span) * 100 : x, w = Math.max(1.6, nx - x);
      return `<div class="tre ${i === trEv ? "on" : ""} ${e.kind === "injection_flagged" ? "bad" : ""} ${trHide.has(e.agent) ? "hid" : ""}" data-i="${i}"><span class="tlane ${AGENT[e.agent] ?? "c"}">${e.agent}</span><span class="tk2">${esc(e.kind.replace(/_/g, " "))}${ai ? '<span class="ai"></span>' : ""}</span><span class="bar3" title="${esc(e.text)}"><i style="left:${Math.min(98.4, x)}%;width:${Math.min(w, 100 - Math.min(98.4, x))}%" class="${AGENT[e.agent] ?? "c"}${i <= trEv || trEv < 0 ? "" : " fut"}"></i></span><span class="mono tt">+${Math.round((Date.parse(e.at) - t0) / 60000)}m</span></div>`;
    }).join("");
    $$<HTMLElement>("#trWater .tre").forEach((d) => d.onclick = () => { stopPlay(); trEv = Number(d.dataset.i); renderTraces(); });
    $("#trPlay").onclick = () => {
      if (trPlay) { stopPlay(); renderTraces(); return; }
      trEv = -1; trPlay = setInterval(() => { trEv++; if (trEv >= r.trace.length) { stopPlay(); trEv = r.trace.length - 1; } renderTraces(); $("#trWater .tre.on")?.scrollIntoView({ block: "nearest" }); }, 420);
      renderTraces();
    };
    const e = r.trace[trEv];
    $("#trJson").innerHTML = e ? `<div class="trh"><b>${esc(e.kind.replace(/_/g, " "))}</b><span>${esc(e.agent)} · ${when(e.at)}</span></div><div class="cs" style="margin-bottom:6px">${esc(e.text)}</div>${isAI(e) ? '<div class="cs" style="margin-bottom:6px"><b>Decided by the model</b>, checked by code before it counted.</div>' : ""}<pre class="json">${esc(JSON.stringify(e.data ?? {}, null, 2)).slice(0, 4000)}</pre>` : '<div class="cs">Tap a span, or press ▶ to replay the run step by step.</div>';
  } else { $("#trWater").innerHTML = '<div class="empty">Book a dinner and its trace appears here.</div>'; $("#trJson").innerHTML = ""; }
  $("#trCalls").innerHTML = calls.slice(0, 40).map((c) => `<div class="trc"><span class="src ${c.source}">${c.source === "live" ? "● live" : c.source === "recorded" ? "recorded" : "fallback"}</span><span class="mono">${esc(c.task)}</span><span class="mono">${c.ms} ms</span><span class="mono">${c.tin + c.tout} tok</span></div>`).join("") || '<div class="cs">No model calls yet this visit. Book on Home or Chat to see them.</div>';
}
function stopPlay() { if (trPlay) { clearInterval(trPlay); trPlay = null; } }
$<HTMLInputElement>("#trQ").addEventListener("input", (e) => { trQ = (e.target as HTMLInputElement).value; renderTraces(); });
$$<HTMLButtonElement>("#trOut button").forEach((b) => b.onclick = () => { trOut = b.dataset.o!; $$("#trOut button").forEach((x) => x.classList.toggle("on", x === b)); renderTraces(); });

// =====================================================================
// IDENTITY + HISTORY: who is signed in, and the dinners already on the books
// =====================================================================
/** People who agreed to try Thursday under their own name. Each gets their own saved history. */
const TEAM = ["Akila Lourdes", "Akilan", "Francis", "Mamatha", "Chrisen", "Lilly Grace", "Thomas", "Irudayaraj", "Nirmala Anitha", "Sudeep", "Amul Raj", "Babu", "Joyce", "Samantha", "Patricia", "Davis"];
function editMe() {
  const saved = (n: string) => { const d = readSaved(n); return d ? d.stores.reduce((a, s) => a + s.snap.bookings.filter((b) => b.status === "confirmed").length, 0) : 0; };
  const team = TEAM.map((n) => { const k = saved(n), cur = n.toLowerCase() === me.name.toLowerCase(); return `<button type="button" class="teamc ${cur ? "on" : ""}" data-n="${esc(n)}"><i>${esc(n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase())}</i><span>${esc(n)}</span><small>${cur ? "signed in" : k ? `${k} saved booking${k === 1 ? "" : "s"}` : "new"}</small></button>`; }).join("");
  const m = el("div", "modal", `<form class="mbox wide" id="meForm"><div class="ph2"><i class="avbig">${esc(meIni())}</i></div><div class="cs" style="text-align:center;margin:-4px 0 10px">Pick your name. Add a PIN to see your dinners on any phone or laptop.</div><div class="teamg">${team}</div><input id="meIn" class="emin" maxlength="40" value="" placeholder="Or type another name"><div class="cs" style="text-align:center;margin-top:12px">PIN · keeps your dinners on every device</div><div class="pinrow">${[0, 1, 2, 3].map((i) => `<input inputmode="numeric" maxlength="1" class="pind" data-i="${i}" aria-label="PIN digit ${i + 1}">`).join("")}</div><div class="cs" id="meErr" style="text-align:center;color:var(--rose);min-height:18px"></div><div class="cbtns"><button class="btn pri">Sign in</button><button class="btn" type="button" id="meX">Cancel</button></div></form>`);
  document.body.append(m); const inp = m.querySelector<HTMLInputElement>("#meIn")!; setTimeout(() => { inp.focus(); inp.select(); }, 30);
  inp.oninput = () => { m.querySelector(".avbig")!.textContent = inp.value.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"; };
  m.querySelector("#meX")!.addEventListener("click", () => m.remove()); m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  const pins = [...m.querySelectorAll<HTMLInputElement>(".pind")];
  pins.forEach((p, i) => { p.oninput = () => { p.value = p.value.replace(/\D/g, "").slice(-1); if (p.value && pins[i + 1]) pins[i + 1].focus(); }; p.onkeydown = (e) => { if (e.key === "Backspace" && !p.value && pins[i - 1]) pins[i - 1].focus(); }; });
  let chosen = "";
  const switchTo = async (v: string) => {
    v = v.trim().replace(/\s+/g, " "); if (!v) return;
    const p = pins.map((x) => x.value).join("");
    if (p && p.length !== 4) { m.querySelector("#meErr")!.textContent = "A PIN is 4 digits."; return; }
    if (!p && !inp.value.trim() && chosen !== v) { chosen = v; m.querySelector(".avbig")!.textContent = v.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(); m.querySelectorAll(".teamc").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.n === v)); inp.placeholder = v; pins[0].focus(); m.querySelector("#meErr")!.textContent = ""; return; }
    if (p && API) {
      try { const r = await histCall("load", v, p); if (r.status === 403 || r.status === 429) { m.querySelector("#meErr")!.textContent = r.body.error ?? "Wrong PIN."; pins.forEach((x) => (x.value = "")); pins[0].focus(); return; } } catch { /* offline: keep the PIN, sync later */ }
    }
    if (v.toLowerCase() === me.name.toLowerCase() && p === pin) { m.remove(); return; }
    saveHistory(); // keep this person's visit before switching
    try { localStorage.setItem(ME_KEY, v); if (p) localStorage.setItem(PINK(v), p); } catch { /* fine */ }
    location.reload(); // the next person starts from their own saved history, never from this one
  };
  m.querySelectorAll<HTMLButtonElement>(".teamc").forEach((b) => b.onclick = () => void switchTo(b.dataset.n!));
  m.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); void switchTo(inp.value.trim() || chosen || me.name); });
}
$("#wsBtn").onclick = editMe; $("#meBtn").onclick = editMe;

// =====================================================================
// SAVED HISTORY: each person's bookings, approvals, payments and agent runs are kept in this browser under their name,
// so signing in again shows everything from earlier visits, not just this one. Nothing leaves the browser.
// =====================================================================
const HIST = (name: string) => `tdc_hist_v1:${name.trim().toLowerCase()}`;
interface Saved { v: 1; name: string; visits: number[]; stores: { src: string; snap: StoreSnapshot }[]; runs: RunLog[]; codes: [string, string][]; asks?: [string, string][]; deals?: [string, Deal][]; savedAt?: number }
let histDirty = false, histLoaded = false, visits: number[] = [], lastBody = "", savedAt = 0;
// ---- across devices: the same history, kept on the server under a hash of name + 4-digit PIN ----
const PINK = (name: string) => `tdc_pin:${name.trim().toLowerCase()}`;
let pin = (() => { try { return localStorage.getItem(PINK(me.name)) ?? ""; } catch { return ""; } })();
let syncState: "off" | "ok" | "err" = "off", pushedAt = 0, pushed = "", pushTimer: ReturnType<typeof setTimeout> | null = null;
async function histCall(path: "load" | "save", name: string, p: string, data?: unknown): Promise<{ status: number; body: { data?: Saved | null; error?: string } }> {
  const r = await fetch(`${API}/history/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, pin: p, data }), signal: AbortSignal.timeout(6000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function pushHistory(full: string) {
  if (!API || !pin || syncState === "err" || full === pushed) return;
  const wait = Math.max(0, 8000 - (Date.now() - pushedAt)); if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null; pushedAt = Date.now();
    try { const r = await histCall("save", me.name, pin, JSON.parse(full)); if (r.status === 200) { pushed = full; syncState = "ok"; } else syncState = r.status === 403 ? "err" : "off"; } catch { syncState = "off"; }
    if ($("#p-bookings.on")) $("#ordSub").innerHTML = `${esc(visitLine())} · ${syncBadge()}`;
  }, wait);
}
function syncBadge() {
  return pin && syncState === "ok" ? `<span class="synb">● Synced across your devices</span>` : pin && syncState === "err" ? `<span class="synb off">PIN not accepted: saved in this browser</span>` : `<span class="synb off">Saved in this browser${pin ? " (sync offline)" : ""}</span>`;
}
const pastStores = new Set<MemoryStore>();
function readSaved(name: string): Saved | null { try { const raw = localStorage.getItem(HIST(name)); const d = raw ? JSON.parse(raw) as Saved : null; return d?.v === 1 ? d : null; } catch { return null; } }
const slimTrace = (t: TraceEvent[]) => t.slice(0, 80).map((e) => { const d = e.data && JSON.stringify(e.data).length > 1500 ? undefined : e.data; return { ...e, data: d }; });
function saveHistory() {
  if (!histLoaded) return;
  try {
    const keep = stores.filter((st) => (srcOf.get(st) ?? "Live desk") !== "Live desk" && st.allBookings().length);
    const data: Saved = { v: 1, name: me.name, visits: visits.slice(-50), stores: keep.map((st) => ({ src: srcOf.get(st)!, snap: st.snapshot() })),
      runs: runsLog.filter((r) => !/^desk/.test(r.id)).slice(0, 40).map((r) => ({ ...r, trace: slimTrace(r.trace), past: undefined })), codes: [...invCode], asks: [...bkAsk], deals: [...deals] };
    const body = JSON.stringify(data); if (body !== lastBody) { lastBody = body; savedAt = Date.now(); }
    data.savedAt = savedAt; const full = JSON.stringify(data);
    localStorage.setItem(HIST(me.name), full); histDirty = false; pushHistory(full);
  } catch { /* storage full or blocked: history just isn't kept */ }
}
setInterval(() => { if (histDirty || histLoaded) saveHistory(); }, 5000);
addEventListener("pagehide", saveHistory);
async function startHistory() {
  if (API && pin) {
    try {
      const r = await histCall("load", me.name, pin);
      if (r.status === 200) {
        syncState = "ok"; const remote = r.body.data, local = readSaved(me.name);
        if (remote?.v === 1 && (remote.savedAt ?? 0) > (local?.savedAt ?? 0)) localStorage.setItem(HIST(me.name), JSON.stringify(remote));
      } else if (r.status === 403) { syncState = "err"; toast("That PIN didn't match", `Showing what's saved in this browser for ${meFirst()}`, "warn"); }
    } catch { syncState = "off"; }
  }
  const saved = readSaved(me.name);
  visits = [...(saved?.visits ?? []), Date.now()];
  if (saved && saved.stores.length + saved.runs.length) {
    for (const s of saved.stores) { const st = new MemoryStore(); await st.init(supply); st.restore(s.snap); stores.push(st); srcOf.set(st, s.src); pastStores.add(st); }
    runsLog.push(...saved.runs.map((r) => ({ ...r, past: true })));
    for (const [k, v] of saved.codes ?? []) invCode.set(k, v);
    for (const [k, v] of saved.asks ?? []) bkAsk.set(k, v);
    for (const [k, v] of saved.deals ?? []) deals.set(k, v);
    histLoaded = true;
    const n = saved.stores.reduce((a, s) => a + s.snap.bookings.filter((b) => b.status === "confirmed").length, 0);
    const last = saved.visits.at(-1);
    toast(`Welcome back, ${meFirst()}`, `${n} booking${n === 1 ? "" : "s"} and ${saved.runs.length} agent run${saved.runs.length === 1 ? "" : "s"} from earlier visits${last ? ` (last one ${ago(new Date(last).toISOString())})` : ""}`);
    renderGrid(); if (!cmpRows.length) void cmpLoad(replayLLM);
  } else {
    await seedHistory();
    histLoaded = true; saveHistory();
  }
  try { const a = JSON.parse(localStorage.getItem(`tdc_active:${me.name.toLowerCase()}`) ?? "null") as Active | null; if (a?.req?.date && !active) active = a; } catch { /* fine */ }
  const page = location.hash.slice(1); void hIdle(); void renderHomeRails(); void reorderPrompt(); applyActive(page);
  if (page === "invoice") void renderInvoice(); if (page === "bookings") void renderBookings(); if (page === "traces") renderTraces(); if (page === "calendar") void renderCal();
}
const isPast = (st: MemoryStore) => pastStores.has(st);
const visitLine = () => visits.length > 1 ? `Visit ${visits.length} · first ${new Date(visits[0]).toLocaleDateString([], { month: "short", day: "numeric" })}` : "First visit";

/** A few dinners booked earlier this week, through the same agent, so every planning page opens with real data. */
async function seedHistory() {
  const store = new MemoryStore(); await store.init(supply); stores.push(store); srcOf.set(store, "Sample · first visit");
  const asks = ["private dinner for 14 with Initech next Thursday", "team dinner for 8 at 7:30pm on Friday in Tribeca", "dinner for 10 with the Globex team next Tuesday, private room, two vegetarians"];
  let last: { v: Venue; room: string; n: number; date: string; diet: string[]; client: string; world: VenueWorld; thread: string } | null = null;
  for (const [i, text] of asks.entries()) {
    const world = new VenueWorld(supply, () => "accept", NOW, 70 + i);
    const res = await runConcierge({ text, actor: priya, principal: dana, today: TODAY, store, world, llm: replayLLM, venues: supply, company,
      approver: async (p, st) => { for (const role of p.requiredRoles) await st.decide(p.id, approverFor(role, priya).id, role, "approve"); return "approved"; } });
    if (res.outcome === "booked" && res.bookingId) {
      const v = supply.find((x) => x.id === res.chosenVenueId)!, bk = (await store.getBooking(res.bookingId))!;
      last = { v, room: v.rooms.find((r) => r.id === bk.roomId)!.name, n: bk.partySize, date: localDate(bk.startsAt), diet: res.request?.dietary ?? [], client: res.request?.clientName ?? "Team", world, thread: `thr_${res.runId}_${v.id}` };
      record(res, world, text);
    }
  }
  if (last && !lastBk) { setLastBooking({ venue: last.v, roomName: last.room, partySize: last.n, date: last.date, dietary: last.diet, client: last.client, world: last.world, threadId: last.thread }); $<HTMLButtonElement>("#seatAuto").click(); }
  renderGrid();
  if (!cmpRows.length) void cmpLoad(replayLLM);
}

// ---------- start ----------
function renderLive() {
  const on = llm.target !== replayLLM && !(llm.live && llm.live.liveCalls === 0 && llm.live.replayed > 0), b = $("#livePill"); if (!b) return;
  b.className = `livepill ${on ? "on" : ""}`; b.innerHTML = on ? `<span class="live"></span>Live Claude` : `<i>✳</i>Recorded Claude`;
  b.title = on ? `Calls go to Claude now. ${llm.live?.liveCalls ?? 0} live calls this visit${llm.live?.replayed ? `, ${llm.live.replayed} fell back to recordings` : ""}.` : "Answers Claude really gave, replayed. Connect the server for live calls.";
}
if (API) fetch(`${API}/health`).then((r) => r.json()).then((h: { llm: boolean; email: boolean }) => { apiHealth = h; if (h.llm) { llm.live = new LiveThenReplay(new RemoteLLM(API), replayLLM); llm.target = llm.live; } renderLive(); }).catch(() => renderLive());
renderLive(); setInterval(() => { if (llm.live) renderLive(); }, 3000);
void startHistory();
if (!new URLSearchParams(location.search).has("still")) void deskLoop();
{ const h = location.hash.slice(1), ask0 = new URLSearchParams(location.search).get("ask"); go(ask0 ? "home" : $(`#p-${h}`) ? h : "home"); if (ask0) setTimeout(() => void hRun(ask0.slice(0, 200)), 700); }
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if ($(`#p-${h}`) && !$(`#p-${h}.on`)) go(h); });
