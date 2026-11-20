import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "../playwright.mjs";
const REPO = new URL("../..", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".css": "text/css", ".gif": "image/gif", ".mp4": "video/mp4" };
export async function serve() {
  const server = createServer(async (req, res) => {
    const path = join(REPO, "docs", decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\/$/, "/index.html"));
    let body; try { body = await readFile(path); } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); res.end(body);
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://localhost:${server.address().port}/` };
}
export async function browser(scale = 2) {
  const b = await chromium.launch({ args: ["--font-render-hinting=none"] });
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale, timezoneId: "America/New_York" });
  await ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, async (route) => {
    const m = route.request().url().match(/(\d+)\/(\d+)\/(\d+)\.png/);
    try { route.fulfill({ body: await readFile(join(REPO, ".video-cache/tiles", m[1], m[2], `${m[3]}.png`)), contentType: "image/png" }); } catch { route.fulfill({ status: 404, body: "" }); }
  });
  await ctx.route(/workers\.dev|unsplash/, (r) => r.abort());
  return { b, ctx };
}
/** Virtual time: the page's clock (timers, animations, rAF) only moves when we say so, so every frame is exactly 1/fps apart. */
export async function vclock(page) {
  const cdp = await page.context().newCDPSession(page);
  const E = async (expr) => { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.exceptionDetails) console.log("EVAL ERR", r.exceptionDetails.text, expr.slice(0, 80)); return r.result?.value; };
  const snap = async () => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 2 } })).data, "base64");
  const step = async (ms) => { const done = new Promise((r) => cdp.once("Emulation.virtualTimeBudgetExpired", r)); await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms }); await done; };
  return { step, E, snap };
}
