// The live site. Every page runs the real agent, tools, policy, store and graders from this repo
// against the simulated venue network. Model calls replay recorded Claude outputs (evals/recordings),
// exactly as CI does; anything not recorded falls back to the deterministic path, and the UI says which.
import { buildVenues, COMPANY, user } from "../data/seed.ts";
import { fuzzOne, runScenario } from "../evals/runner.ts";
import type { ScenarioRun } from "../evals/runner.ts";
import { SCENARIOS } from "../evals/scenarios.ts";
import { approverFor, carefulApprover, runConcierge } from "../src/agents/concierge.ts";
import type { Approver, RunResult } from "../src/agents/concierge.ts";
import type { Company, Proposal } from "../src/domain/types.ts";
import { injection, replyTriage } from "../src/judgments/judgments.ts";
import { ReplayLLM } from "../src/llm/client.ts";
import { knowledge } from "../src/memory/supply.ts";
import { extractRules } from "../src/parse/offer.ts";
import { checkPolicy, estimate, perHeadFor } from "../src/policy/policy.ts";
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
  
  window.scrollTo({ top: 0 });
}
$$<HTMLButtonElement>("#tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.p!)));
Object.assign(window, { go, caption: (n: string, t: string) => { const c = $("#caption"); c.style.display = t ? "flex" : "none"; $("#capN").textContent = n; $("#capT").textContent = t; } });

// =====================================================================
// LIVE DESK: the queue an EA or the concierge team actually watches
// =====================================================================
const STAGES = ["Understand", "Shortlist", "Email venues", "Compare", "Approval", "Confirmed"];
const PIN: Record<string, string> = { cand: "#5b6b8c", mail: "#c98a12", offer: "#3f7d5a", decl: "#b9ad9f", inj: "#c2455d", win: "#7b1e3a" };
interface DeskRow { venueId: string; name: string; state: "cand" | "mail" | "offer" | "decl" | "inj" | "win"; room: string; min: string; perHead: string; note: string; ai: boolean }
interface DeskReq { s: (typeof SCENARIOS)[number]; status: string; tone: string; stage: number; acts: TraceEvent[]; rows: Map<string, DeskRow>; parsed: Record<string, unknown> | null; ai: number; done: boolean }
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
function renderQueue() {
  $("#queue").innerHTML = desk.map((r, i) => `<button class="qi ${i === sel ? "on" : ""}" data-i="${i}"><div class="qh"><span class="av">PR</span><b>${esc(r.s.text)}</b></div>
    <div class="qm"><span class="st ${r.tone}">${esc(r.status)}</span>${r.ai ? `<span class="ai">${r.ai}</span>` : ""}</div><div class="prog"><i style="width:${r.done ? 100 : (r.stage / 5) * 100}%" class="${r.tone}"></i></div></button>`).join("");
  $$<HTMLButtonElement>("#queue .qi").forEach((b) => b.onclick = () => { sel = Number(b.dataset.i); renderQueue(); renderDetail(); });
}
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
  const world = new VenueWorld(venues, (id) => { if (!seen.has(id)) seen.set(id, order[seen.size] ?? "accept"); return seen.get(id)!; }, "2026-11-09T15:00:00.000Z", 11);
  const store = new MemoryStore(); await store.init(venues); stores.push(store);
  const events: TraceEvent[] = [];
  const res = await runConcierge({ text: s.text, actor: priya, principal: dana, today: "2026-11-09", store, world, llm, venues, company, onEvent: (e) => events.push(e),
    approver: async (p, st) => carefulApprover(priya, { partySize: p.partySize, date: localDate(p.startsAt), privateRoom: false })(p, st) });
  for (const e of events) {
    if (g !== deskGen) return;
    apply(r, e); $("#dClock").textContent = when(e.at);
    if (e.kind === "proposed") { renderQueue(); if (sel === i) renderDetail(); await dsleep(1400); r.acts.push({ ...e, kind: "approved_sim", agent: "concierge", text: "Priya approved on her phone (simulated booker)" }); }
    renderQueue(); if (sel === i) renderDetail();
    await dsleep(["reply", "offer", "injection_flagged"].includes(e.kind) ? 650 : 900);
  }
  if (!r.done) { r.done = true; r.status = res.outcome === "booked" ? "Confirmed" : res.outcome === "escalated" ? "Escalated to team" : res.outcome.replace(/_/g, " "); r.tone = res.outcome === "booked" ? "ok" : "bad"; }
  record(res, world); renderQueue(); if (sel === i) renderDetail();
}
async function deskLoop() {
  const g = ++deskGen;
  desk = DESK.map((s) => ({ s, status: "Queued", tone: "mute", stage: 0, acts: [], rows: new Map(), parsed: null, ai: 0, done: false }));
  sel = 0; renderQueue(); renderDetail();
  for (let i = 0; i < desk.length && g === deskGen; i++) { if (sel === i - 1 || i === 0) { sel = i; } renderQueue(); renderDetail(); await deskRun(i, g); await dsleep(1200); }
}
$("#dPause").onclick = () => { deskPaused = !deskPaused; $("#dPause").textContent = deskPaused ? "Resume" : "Pause"; };
$("#dReplay").onclick = () => { deskPaused = false; $("#dPause").textContent = "Pause"; void deskLoop(); };
$$<HTMLButtonElement>("#dSpeed button").forEach((b) => b.onclick = () => { $$("#dSpeed button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); deskSpeed = Number(b.dataset.s); });
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
  bookStore = new MemoryStore(); await bookStore.init(venues); stores.push(bookStore);
  const res = await runConcierge({ text: $<HTMLInputElement>("#ask").value, actor: priya, principal: dana, today: "2026-11-09", store: bookStore, world: bookWorld, llm, venues, company, approver: tap, onEvent: addEvent });
  await drained(); record(res, bookWorld);
  const v = res.chosenVenueId ? venues.find((x) => x.id === res.chosenVenueId) : null, bk = res.proposals.find((p) => p.kind === "book");
  const pay = res.paymentId ? bookStore.allPayments().find((x) => x.id === res.paymentId) : null;
  if (res.outcome === "booked" && v && bk) {
    course("book");
    const room = v.rooms.find((r) => r.id === bk.roomId)!;
    $("#phone").append(el("div", "ticket", `<div class="tt">${esc(v.name)}</div><div class="ts">${esc(room.name)} · ${when(bk.startsAt).replace(/ \d+ (am|pm)/, "")} ${localDate(bk.startsAt).slice(5)} · ${bk.partySize} guests</div><hr>${seating(bk.partySize)}
      <div class="ts" style="margin-top:6px">${usd(bk.amountCents)} all-in${pay ? ` · deposit ${usd(pay.amountCents)} → ${esc(pay.payeeId)}` : ""}</div>`));
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

// ---------- start ----------
if (!new URLSearchParams(location.search).has("still")) void deskLoop();
