import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveThenReplay } from "../src/llm/client.ts";
import type { LLM } from "../src/llm/client.ts";
// @ts-expect-error plain JS module deployed as a Cloudflare Worker
import worker from "../server/worker.js";

const env = { ANTHROPIC_API_KEY: "k", RESEND_API_KEY: "r" };
const post = (path: string, body: unknown, ip = "1.1.1.1") => worker.fetch(new Request(`https://w.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { origin: "https://akilalours.github.io", "cf-connecting-ip": ip } }), env);
function mockFetch(handler: (url: string, init: RequestInit) => unknown) {
  const real = globalThis.fetch; const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify(handler(url, init)), { status: 200 }); }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const booking = { venue: "Casa Verbena", room: "Wine Cellar", neighborhood: "Tribeca", when: "Thu Nov 12, 7 pm", guests: 12, allIn: "$1,769", startsAt: "2026-11-13T00:00:00.000Z" };

describe("server: live model and real email", () => {
  it("reports which features are configured", async () => {
    const r = await worker.fetch(new Request("https://w.test/health"), { ANTHROPIC_API_KEY: "k" });
    assert.deepEqual(await r.json(), { llm: true, email: false, model: "claude-sonnet-4-5" });
  });
  it("only forwards the agent's own tasks, and caps tokens", async () => {
    assert.equal((await post("/llm", { task: "write_me_a_poem", system: "s", user: "u" })).status, 400);
    const m = mockFetch(() => ({ content: [{ type: "text", text: '{"x":1}' }], usage: { input_tokens: 3, output_tokens: 2 }, model: "claude-sonnet-4-5" }));
    try {
      const r = await post("/llm", { task: "parse_request", system: "s", user: "u", maxTokens: 99999 }, "2.2.2.2");
      assert.equal(r.status, 200); assert.equal((await r.json()).text, '{"x":1}');
      assert.equal(m.calls[0].body.max_tokens, 800); assert.equal(m.calls[0].body.temperature, 0);
    } finally { m.restore(); }
  });
  it("sends a confirmation built from booking fields only, with a calendar invite", async () => {
    const m = mockFetch(() => ({ id: "em_1" }));
    try {
      assert.equal((await post("/email", { ...booking, to: "not-an-email" }, "3.3.3.3")).status, 400);
      const r = await post("/email", { ...booking, venue: "<script>x</script>Casa", to: "me@example.com" }, "3.3.3.4");
      assert.equal(r.status, 200);
      const sent = m.calls[0].body;
      assert.deepEqual(sent.to, ["me@example.com"]);
      assert.ok(!sent.html.includes("<script>"), "venue name is escaped");
      assert.match(atob(sent.attachments[0].content), /BEGIN:VEVENT[\s\S]*DTSTART:20261113T000000Z/);
    } finally { m.restore(); }
  });
  it("rate-limits email per visitor", async () => {
    const m = mockFetch(() => ({ id: "em" }));
    try {
      const codes = []; for (let i = 0; i < 5; i++) codes.push((await post("/email", { ...booking, to: "me@example.com" }, "9.9.9.9")).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    } finally { m.restore(); }
  });
});

describe("browser model client", () => {
  const replay: LLM = { mode: "replay", complete: async () => ({ text: "recorded", inputTokens: 0, outputTokens: 0, model: "m" }) };
  it("uses the live answer when the server responds", async () => {
    const l = new LiveThenReplay({ mode: "live", complete: async () => ({ text: "live", inputTokens: 1, outputTokens: 1, model: "m" }) }, replay);
    assert.equal((await l.complete("t", "s", "u")).text, "live"); assert.equal(l.liveCalls, 1);
  });
  it("falls back to the recording when the server fails, and counts it", async () => {
    const l = new LiveThenReplay({ mode: "live", complete: async () => { throw new Error("HTTP 502"); } }, replay);
    assert.equal((await l.complete("t", "s", "u")).text, "recorded"); assert.equal(l.replayed, 1);
  });
  it("does not hide our own timeout behind a recording", async () => {
    const ctl = new AbortController(); ctl.abort();
    const l = new LiveThenReplay({ mode: "live", complete: async () => { throw new Error("aborted"); } }, replay);
    await assert.rejects(l.complete("t", "s", "u", { signal: ctl.signal }));
  });
});
