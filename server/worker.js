// Thursday Dinner Concierge: the small server behind the live site.
//   POST /llm    one model call for the agent (Claude), key kept server-side
//   POST /email  a real booking confirmation with a calendar invite, sent through Resend
//   GET  /health which features are configured
// Secrets (never in the repo): ANTHROPIC_API_KEY, RESEND_API_KEY. Optional vars: MODEL, MAIL_FROM, ALLOWED_ORIGINS.
// It is deliberately narrow: only the agent's own tasks, capped tokens, capped emails, booking fields only (no free-form HTML),
// so it can't be used as a general model proxy or a spam relay.

const TASKS = /^(parse_request|extract_offer|classify_[a-z_]+|judge_proposal_message)$/;
const LIMITS = { llm: [60, 3600], email: [3, 3600] };      // per IP: count per window (seconds)
const DAILY_EMAILS = 100;                                   // whole worker, per isolate day
const hits = new Map();
let day = "", emailsToday = 0;

function limited(kind, ip) {
  const [max, win] = LIMITS[kind], now = Date.now(), k = `${kind}:${ip}`, h = hits.get(k);
  if (!h || now > h.reset) { hits.set(k, { n: 1, reset: now + win * 1000 }); return false; }
  return ++h.n > max;
}
function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "https://akilalours.github.io,https://ande-thursday-dinner-concierge.streamlit.app,null").split(",").map((s) => s.trim());
  return { "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0], "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" };
}
const json = (body, status, h) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...h } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clean = (s, n) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, n);

function ics(b) {
  const f = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = new Date(b.startsAt), end = new Date(start.getTime() + 3 * 3600_000);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Thursday Dinner Concierge//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@thursday-dinner`, `DTSTAMP:${f(new Date().toISOString())}`, `DTSTART:${f(start.toISOString())}`, `DTEND:${f(end.toISOString())}`,
    `SUMMARY:Dinner at ${clean(b.venue, 80)} (${b.guests} guests)`, `LOCATION:${clean(b.venue, 80)}\\, ${clean(b.neighborhood, 40)}\\, New York`,
    `DESCRIPTION:${clean(b.room, 60)}. Booked by the Thursday Dinner concierge (demo\\, fictional venue).`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
function html(b) {
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#8c7c6f;font-size:13px">${k}</td><td style="padding:6px 0;font-weight:600;text-align:right">${v}</td></tr>`;
  return `<div style="font-family:Inter,Helvetica,Arial,sans-serif;background:#f6f1e8;padding:24px"><div style="max-width:480px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e9dfcf">
  <div style="background:#7b1e3a;color:#fff;padding:18px 22px"><div style="font-size:12px;letter-spacing:.08em;opacity:.8">THURSDAY DINNER · CONFIRMED</div><div style="font:700 24px Georgia,serif;margin-top:4px">${esc(b.venue)}</div><div style="opacity:.85">${esc(b.room)} · ${esc(b.neighborhood)}</div></div>
  <div style="padding:18px 22px"><table style="width:100%;border-collapse:collapse">${row("When", esc(b.when))}${row("Guests", esc(b.guests))}${row("All-in estimate", esc(b.allIn))}${row("Deposit", esc(b.deposit || "none"))}${b.client ? row("Hosting", esc(b.client)) : ""}</table>
  <p style="font-size:13px;color:#5d4f45;margin:16px 0 0">The calendar invite is attached. Nothing else is charged without your approval.</p></div>
  <div style="padding:12px 22px;background:#fbf7f0;font-size:11px;color:#a39380">Sent from the Thursday Dinner Concierge demo (an independent project; venue and booking are fictional).</div></div></div>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("origin") ?? "", h = cors(origin, env), ip = req.headers.get("cf-connecting-ip") ?? "?";
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    if (url.pathname === "/health") return json({ llm: !!env.ANTHROPIC_API_KEY, email: !!env.RESEND_API_KEY, model: env.MODEL ?? "claude-sonnet-4-5" }, 200, h);
    if (req.method !== "POST") return json({ error: "not found" }, 404, h);
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400, h); }

    if (url.pathname === "/llm") {
      if (!env.ANTHROPIC_API_KEY) return json({ error: "llm not configured" }, 503, h);
      if (limited("llm", ip)) return json({ error: "slow down" }, 429, h);
      if (!TASKS.test(b.task ?? "") || typeof b.system !== "string" || typeof b.user !== "string" || b.system.length > 6000 || b.user.length > 6000) return json({ error: "task not allowed" }, 400, h);
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: env.MODEL ?? "claude-sonnet-4-5", max_tokens: Math.min(Number(b.maxTokens) || 800, 800), temperature: 0, system: b.system, messages: [{ role: "user", content: b.user }] }) });
      if (!r.ok) return json({ error: `model HTTP ${r.status}` }, 502, h);
      const d = await r.json();
      return json({ text: d.content.filter((c) => c.type === "text").map((c) => c.text).join(""), inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0, model: d.model }, 200, h);
    }

    if (url.pathname === "/email") {
      if (!env.RESEND_API_KEY) return json({ error: "email not configured" }, 503, h);
      const today = new Date().toISOString().slice(0, 10); if (today !== day) { day = today; emailsToday = 0; }
      if (limited("email", ip) || emailsToday >= DAILY_EMAILS) return json({ error: "email limit reached, try later" }, 429, h);
      if (!/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(b.to ?? "")) return json({ error: "invalid email" }, 400, h);
      const bk = { venue: clean(b.venue, 80), room: clean(b.room, 60), neighborhood: clean(b.neighborhood, 40), when: clean(b.when, 60), guests: Number(b.guests) | 0, allIn: clean(b.allIn, 20), deposit: clean(b.deposit, 20), client: clean(b.client, 60), startsAt: clean(b.startsAt, 30) };
      if (!bk.venue || !bk.guests || Number.isNaN(Date.parse(bk.startsAt))) return json({ error: "missing booking" }, 400, h);
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM ?? "Thursday Dinner <onboarding@resend.dev>", to: [b.to], subject: `Booked: ${bk.venue}, ${bk.when}`, html: html(bk),
          attachments: [{ filename: "dinner.ics", content: btoa(ics(bk)) }] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d.message ?? `mail HTTP ${r.status}` }, 502, h);
      emailsToday++;
      return json({ id: d.id }, 200, h);
    }
    return json({ error: "not found" }, 404, h);
  },
};
