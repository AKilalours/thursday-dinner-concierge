// Browser check of the published site (docs/). Runs in CI on every push, so a broken page,
// a JS error, a clipped nav item or a page wider than a phone fails the build before it deploys.
//   npm run site:check            (needs playwright: npm i --no-save playwright && npx playwright install chromium)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const root = new URL("../docs/", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".gif": "image/gif", ".mp4": "video/mp4", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\/$/, "/index.html"));
  try { res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); res.end(await readFile(path)); } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const failures = [];
const fail = (w, m) => { failures.push(`[${w}px] ${m}`); console.log(`  ✗ ${m}`); };
const browser = await chromium.launch();

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => fail(width, `page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/.test(m.text())) fail(width, `console error: ${m.text()}`); });
  // External fonts are optional; never let a missing network make the check flaky.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(url); await page.waitForFunction(() => typeof window.go === "function");
  return page;
}
const slideAll = async (page, sel) => { for (let i = 0; i < 4 && await page.$(`${sel} .slide:not(.done)`); i++) { await page.click(`${sel} .slide:not(.done) .lbl`); await page.waitForTimeout(400); } };

// 1. Every page renders at desktop, laptop and phone width: no errors, no sideways scroll, every nav item reachable.
for (const [w, h] of [[1440, 900], [1024, 768], [390, 844]]) {
  console.log(`width ${w}`);
  const page = await open(w, h);
  const pages = await page.$$eval("#tabs button", (b) => b.map((x) => x.dataset.p));
  if (w < 1100) await page.click("#menuBtn");
  for (const p of pages) {
    const btn = page.locator(`#tabs button[data-p="${p}"]`);
    await btn.scrollIntoViewIfNeeded();
    if (!(await btn.isVisible())) fail(w, `nav item "${p}" is not reachable`);
    const box = await btn.boundingBox(), vw = await page.evaluate(() => innerWidth);
    if (box && (box.x < 0 || box.x + box.width > vw + 1)) fail(w, `nav item "${p}" is cut off`);
  }
  if (w < 1100) await page.click("#menuBtn");
  for (const p of pages) {
    await page.evaluate((x) => window.go(x), p); await page.waitForTimeout(250);
    if (!(await page.$(`#p-${p}.on`))) fail(w, `page ${p} did not open`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 0) fail(w, `page ${p} is ${over}px wider than the screen`);
  }
  await page.close();
}

// 2. The main flows, end to end, through the real agent, tools and store.
console.log("flows");
const page = await open(1440, 900);
await page.fill("#hIn", "dinner for 12 with the Acme team next Thursday, somewhere private"); await page.click("#hGo"); await page.waitForSelector("#hSl .slide", { timeout: 30000 }).catch(() => fail(1440, "home: no proposal reached the phone"));
await page.click("#hSl .slide .lbl"); await page.waitForSelector(".ph-ok", { timeout: 15000 }).catch(() => fail(1440, "home: booking did not complete"));
{ const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null); await page.click("#hIcs"); const d = await dl; if (!d || !d.suggestedFilename().endsWith(".ics")) fail(1440, "home: calendar invite did not download"); }
await page.click("#hMails"); await page.waitForSelector(".modal .mm", { timeout: 5000 }).catch(() => fail(1440, "home: email threads did not open"));
if ((await page.$$(".modal .mm")).length < 2) fail(1440, "home: expected the sent and received emails"); await page.click(".modal [data-k=n]");
await page.evaluate(() => window.go("desk"));
await page.waitForSelector(".kc.need [data-ok]", { timeout: 60000 }).then(() => page.click(".kc.need [data-ok]")).catch(() => fail(1440, "live desk: nothing reached Needs you"));
await page.waitForFunction(() => Number(document.querySelector(".kcol.ok .kch b")?.textContent) > 0, null, { timeout: 30000 }).catch(() => fail(1440, "live desk: nothing reached Confirmed"));
await page.click(".kc"); await page.waitForSelector("#dDrawer.on"); await page.click("#dMail"); await page.waitForSelector(".modal .mm", { timeout: 5000 }).catch(() => fail(1440, "live desk: email threads did not open")); await page.click(".modal [data-k=n]"); await page.click("#dClose");
{ const p2 = await open(1440, 900); await p2.goto(url + "?ask=private%20dinner%20for%2020%20with%20Globex%20on%20Nov%2019#home"); await p2.waitForSelector("#hSl .slide, .ph-bot", { timeout: 30000 }).catch(() => fail(1440, "?ask= link did not run the request")); await p2.close(); }
await page.evaluate(() => window.go("chat"));
await page.fill("#chatIn", "dinner for 12 with the Acme team next Thursday, somewhere private"); await page.press("#chatIn", "Enter");
await page.waitForSelector(".cm.card2 [data-k=y]", { timeout: 30000 }); await page.click(".cm.card2 [data-k=y]");
await page.waitForSelector("#chatChips .chip", { timeout: 30000 });
if (!(await page.textContent("#chatLog")).includes("Confirmed")) fail(1440, "chat: request did not end in a confirmed booking");
await page.click("#chatChips .chip"); // "Make it N people"
await page.waitForSelector(".cm.card2 [data-k=y]:not([disabled])", { timeout: 15000 }); await page.click(".cm.card2 [data-k=y]:not([disabled])");
await page.waitForFunction(() => /Done\.|already taken/.test(document.querySelector("#chatLog").textContent), null, { timeout: 15000 }).catch(() => fail(1440, "chat: follow-up change did not finish"));

await page.evaluate(() => window.go("avail")); await page.waitForTimeout(300);
await page.click(".gc.ok"); await page.click("#gReq");
await page.waitForSelector("#gFlow .slide", { timeout: 15000 }); await slideAll(page, "#gFlow");
await page.waitForSelector("#gFlow .gstep.ok", { timeout: 10000 }).catch(() => fail(1440, "availability: booking did not complete"));

await page.evaluate(() => window.go("calendar")); await page.waitForTimeout(400);
await page.click(".calb"); await page.click('.cald[data-d="2026-11-17"]');
await page.waitForSelector(".modal [data-k=y]", { timeout: 5000 }).then(() => page.click(".modal [data-k=y]")).catch(() => {});
await page.waitForSelector(".toast", { timeout: 5000 }).catch(() => fail(1440, "calendar: moving a dinner gave no result"));

await page.evaluate(() => window.go("bookings")); await page.waitForTimeout(400);
const rows = await page.$$eval("#bkTable tbody tr", (r) => r.length);
if (rows < 2) fail(1440, `bookings: expected the chat and availability bookings, saw ${rows}`);

await page.evaluate(() => window.go("explore")); await page.waitForTimeout(300);
for (let i = 0; i < 3; i++) await page.click(".heart:not([disabled]):not(.on)");
await page.click("#xRfp"); await page.waitForSelector("#p-compare.on table.ctable tbody tr", { timeout: 20000 }).catch(() => fail(1440, "explore: RFP to the shortlist produced no offers"));

await page.evaluate(() => window.go("compare")); await page.click("#cmpGo");
await page.waitForSelector("table.ctable tbody tr", { timeout: 30000 }).catch(() => fail(1440, "compare: no offers"));

await page.evaluate(() => window.go("controls")); await page.click("#runAll"); await page.waitForTimeout(4000);
const ctl = await page.textContent("#cSum"); if (/fail/i.test(ctl) && !/0 fail/i.test(ctl)) fail(1440, `controls: ${ctl}`);

await browser.close(); server.close();
if (failures.length) { console.log(`\n${failures.length} problem(s):\n${failures.join("\n")}`); process.exit(1); }
console.log("\nsite check passed");
