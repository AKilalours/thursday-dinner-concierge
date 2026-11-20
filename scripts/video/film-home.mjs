// Films the README video: node scripts/video/film-home.mjs, then scripts/video/encode.sh. Needs scripts/fetch-media.mjs run once.
// Films the real app (docs/) frame by frame under virtual time: 3840x2160, 30 fps, one folder of JPEGs per scene.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { serve, browser, vclock } from "./common.mjs";
const FPS = 30, DT = 1000 / FPS, OUT = new URL("../../.video-cache/frames", import.meta.url).pathname;
const only = process.argv[2];
const { server, url } = await serve(); const { b, ctx } = await browser(2);

const T0 = Date.now(), log = (m) => console.log(`${((Date.now() - T0) / 1000).toFixed(0)}s ${m}`);
// 1) A first visit, in real time, so the person has a dinner on file when they come back.
{ const p = await ctx.newPage(); await p.goto(url + "#home"); await p.waitForFunction(() => typeof window.go === "function"); await p.waitForTimeout(1500);
  await p.evaluate(() => { localStorage.setItem("tdc_me", "Akila Lourdes"); });
  await p.fill("#hIn", "client dinner for 14 with Initech next Thursday, private room"); await p.click("#hGo");
  for (let i = 0; i < 4; i++) { const s = await p.waitForSelector("#hSl .slide:not(.done) .lbl", { timeout: 40000 }).catch(() => null); if (!s) break; await s.click(); await p.waitForTimeout(600); }
  await p.waitForSelector(".ph-ok", { timeout: 20000 }).catch(() => console.log("seed booking did not finish"));
  await p.waitForTimeout(6500); await p.close(); log("seeded"); }

const page = await ctx.newPage(); page.on("pageerror", (e) => console.log("ERR", e.message));
await page.goto(url + "#home"); await page.waitForFunction(() => typeof window.go === "function"); await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelector(".rosheet")?.remove()); // the scene brings it back on cue
await page.addStyleTag({ content: `
  #vcur{position:fixed;z-index:9999;width:34px;height:34px;pointer-events:none;transform:translate(-6px,-4px);filter:drop-shadow(0 3px 5px #0006);transition:none}
  #vcur.dn::after{content:"";position:absolute;left:-14px;top:-14px;width:40px;height:40px;border-radius:50%;background:#7b1e3a44;animation:none}
  #vcap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:9998;display:flex;gap:14px;align-items:center;background:#1a0f12ee;color:#fff;border-radius:22px;padding:16px 26px 16px 18px;font:600 30px Inter,system-ui;box-shadow:0 20px 50px #0007;opacity:0;white-space:nowrap}
  #vcap b{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:#e2b45a;color:#4a0f24;font:800 22px Inter}
  #zcard{position:fixed;inset:0;z-index:9997;display:grid;place-items:center;text-align:center;color:#fff;background:#1a0f12 center/cover;opacity:0;pointer-events:none}
  #zcard::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at center,#1a0f12aa,#1a0f12f2)}#zcard>div{position:relative}
  #zcard h1{font:700 104px Fraunces,Georgia,serif;margin:0;color:#fff;letter-spacing:-.02em}#zcard p{font:500 36px Inter;opacity:.85;margin:18px 0 0}#zcard .k{display:flex;gap:56px;justify-content:center;margin-top:54px}#zcard .k b{display:block;font:700 64px Fraunces,Georgia,serif;color:#e2b45a}#zcard .k span{font:600 20px Inter;letter-spacing:.12em;text-transform:uppercase;opacity:.75}
  #zcard .tag{font:800 20px Inter;letter-spacing:.2em;text-transform:uppercase;color:#e2b45a;margin-bottom:22px}#zcard .u{margin-top:46px;font:600 30px Inter;color:#fff;opacity:.9}` });
await page.evaluate(() => {
  const c = document.createElement("div"); c.id = "vcur"; c.innerHTML = `<svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#1a0f12" stroke-width="1.6" stroke-linejoin="round"/></svg>`; document.body.append(c);
  const k = document.createElement("div"); k.id = "vcap"; document.body.append(k);
  const d = document.createElement("div"); d.id = "zcard"; d.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;opacity:0;background-image:url('img/v/photo-1786209677036-1580ca1b280d-l.jpg')"; document.documentElement.append(d);
});
const { step, E, snap } = await vclock(page);

let cur = [1500, 700], frame = 0, dir = "";
const scene = (name) => { log(`scene ${name}`); dir = `${OUT}/${name}`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); frame = 0; };
const ease = (t) => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
let nshot = 0;
async function shot() { if (++nshot % 60 === 0) log(`frame ${nshot}`); await E(`(()=>{const c=document.getElementById("vcur");c.style.left="${cur[0]}px";c.style.top="${cur[1]}px"})()`); await step(DT); writeFileSync(`${dir}/${String(frame++).padStart(5, "0")}.jpg`, await snap()); }
const hold = async (sec) => { for (let i = 0; i < Math.round(sec * FPS); i++) await shot(); };
const J = JSON.stringify;
async function center(sel) { return E(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`); }
async function move(sel, sec = .8, dx = 0, dy = 0) { const t = await center(sel); if (!t) { console.log("missing", sel); return; } const [x0, y0] = cur, n = Math.round(sec * FPS); for (let i = 1; i <= n; i++) { const e = ease(i / n); cur = [x0 + (t[0] + dx - x0) * e, y0 + (t[1] + dy - y0) * e]; await shot(); } }
async function click(sel, how = "click") { await E(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return;e.dispatchEvent(new MouseEvent(${J(how === "enter" ? "mouseenter" : "click")},{bubbles:${how !== "enter"}}))})()`); await E(`document.getElementById("vcur").classList.add("dn")`); await hold(.12); await E(`document.getElementById("vcur").classList.remove("dn")`); }
async function cap(n, text, top = false) { await E(`(()=>{const k=document.getElementById("vcap");k.innerHTML=${J(text ? `<b>${n}</b>${text}` : "")};k.style.transition="opacity .35s";k.style.opacity=${text ? 1 : 0};k.style.top=${J(top ? "84px" : "auto")};k.style.bottom=${J(top ? "auto" : "44px")}})()`); }
async function card(html) { await E(`(()=>{const d=document.getElementById("zcard");${html ? `d.innerHTML=${J(`<div>${html}</div>`)};` : ""}d.style.transition="opacity .6s";d.style.opacity=${html ? 1 : 0}})()`); }
async function scroll(y, sec = .8) { const y0 = await E("scrollY"), n = Math.round(sec * FPS); for (let i = 1; i <= n; i++) { const e = ease(i / n); await E(`scrollTo({top:${y0 + (y - y0) * e},behavior:"instant"})`); await shot(); } }
const want = (n) => !only || only.split(",").includes(n);

const STATS = `<div class="k"><div><b>60/60</b><span>eval scenarios</span></div><div><b>0</b><span>of 2,035 safety checks failed</span></div><div><b>92.5%</b><span>unseen venue emails read right</span></div><div><b>146</b><span>tests</span></div></div>`;
if (want("s0")) { scene("s0"); const keep = cur; cur = [-80, -80]; log(await E(`(()=>{const d=document.getElementById("zcard");return d?getComputedStyle(d).opacity+" "+getComputedStyle(d).display+" "+d.getBoundingClientRect().width:"none"})()`)); await card(`<div class="tag">Built for Ande · AI Engineer</div><h1>Thursday Dinner Concierge</h1><p>One sentence in. A booked, on-policy dinner out. Nothing happens until you approve.</p>`); await hold(1); log(await E(`(()=>{const d=document.getElementById("zcard");return getComputedStyle(d).opacity+" z"+getComputedStyle(d).zIndex+" "+d.innerHTML.length})()`)); await hold(3.2); await card(""); cur = keep; await hold(.7); }
if (want("s1")) { scene("s1"); await cap(1, "Comes back. It remembers your last dinner.", true); await hold(.6); await E("window.reorderPromptForVideo()"); await hold(3.4); await move(".rosheet [data-a=sim]", .9); await hold(.6); await click(".rosheet [data-a=no]"); await hold(.3); }
if (want("s2")) { scene("s2"); await cap(2, "Real photos. Real streets. Tap any place."); await scroll(620, 1.1); await hold(.4); await move("#hp_ven_09", 1); await click("#hp_ven_09", "enter"); await hold(1.4); await click("#hp_ven_09"); await hold(1.2); }
if (want("s3")) { scene("s3"); await cap(3, "Pick the room, guests and night. Real price, checked against policy."); await move(".vsheet .roomc:nth-child(2)", .8); await hold(.5); await move(".vsheet .step button[data-d='1']", .7); for (let i = 0; i < 2; i++) { await click(".vsheet .step button[data-d='1']"); await hold(.25); } await move(".vsheet .nights button:nth-child(5)", .7); await click(".vsheet .nights button:nth-child(5)"); await hold(1.2); }
if (want("s4")) { scene("s4"); await cap(4, "Similar places at about the same price that night."); const n = 30; for (let i = 1; i <= n; i++) { await E(`document.querySelector(".vsheet").scrollTop=${420 * ease(i / n)}`); await shot(); } await move(".vsheet [data-sim]", .8); await hold(1.6); await E(`document.querySelector(".vsheet").scrollTop=0`); await move("#vsGo", .9); await hold(.4); }
if (want("s5")) { scene("s5"); await cap(5, "One tap: the agent emails venues live."); await click("#vsGo"); await hold(.5); await scroll(await E(`scrollY+document.querySelector("#hLive").getBoundingClientRect().top-140`), .8);
  for (let i = 0; i < 9 * FPS; i++) { if (i === 4 * FPS) await cap(5, "Reads every reply. A scam in an email is ignored."); await shot(); if (await E(`!!document.querySelector("#hSl .slide:not(.done)")`)) break; }
  await cap(6, "Nothing books until you slide.");
  for (let k = 0; k < 3; k++) { if (!(await E(`!!document.querySelector("#hSl .slide:not(.done)")`))) break; await move("#hSl .slide:not(.done) .knob", .7); const x0 = cur[0]; for (let i = 1; i <= 20; i++) { cur = [x0 + 300 * ease(i / 20), cur[1]]; await shot(); } await click("#hSl .slide:not(.done) .lbl"); for (let i = 0; i < 40; i++) { await shot(); if (await E(`!!document.querySelector("#hSl .slide:not(.done)")||!!document.querySelector(".ph-ok")`)) break; } }
  for (let i = 0; i < 5 * FPS; i++) { await shot(); if (i > 10 && await E(`!!document.querySelector(".ph-ok")`)) { await cap(6, "Booked, on policy. Saved to your orders."); await hold(2.6); break; } } }
if (want("s6")) { scene("s6"); await cap(7, "Every page follows your one request."); await E(`window.go("compare");scrollTo(0,0)`); await hold(.4); await move("#actBar [data-go=compare]", .8); await hold(2.6); await move("#actBar [data-go=bookings]", .8); await click("#actBar [data-go=bookings]"); await cap(8, "Your dinners, like order history. Book again in one tap."); await hold(2.8); }
if (want("s7")) { scene("s7"); await cap(9, "A venue email tries to redirect the deposit."); await E(`window.go("lab");scrollTo(0,0)`); await hold(.5); await move("#tmpl [data-t=injection]", .9); await click("#tmpl [data-t=injection]"); await hold(1.2); await cap(9, "The agent reads it as data, flags it, and pays only the payee on file."); await move("#nextmv", .9); await hold(2.2); }
if (want("s8")) { scene("s8"); await cap(10, "Tested three times a day, automatically."); await E(`window.go("monitor");scrollTo(0,0)`); await hold(.6); await move("#moHero", 1); await hold(2.6); }
if (want("s9")) { scene("s9"); cur = [-80, -80]; await cap(0, ""); await card(`<div class="tag">Thursday Dinner Concierge</div><h1>Real agent. Real checks.</h1>${STATS}<div class="u">akilalours.github.io/thursday-dinner-concierge</div>`); await hold(5.2); }
console.log("done"); await b.close(); server.close(); process.exit(0);
