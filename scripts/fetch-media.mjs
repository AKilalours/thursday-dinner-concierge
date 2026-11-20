// One-time download of the media the site serves itself, run on a machine with normal internet:
//   node scripts/fetch-media.mjs
// - docs/img/v/<photo>-s.jpg and -l.jpg: the Unsplash photos used for the fictional venues (Unsplash License).
// - .video-cache/tiles/z/x/y.png: OpenStreetMap tiles for the Manhattan view, used only to record the README video
//   offline (not committed; the live site loads tiles from OpenStreetMap with attribution).
// Then it packs both into node_modules/.media.tgz for the recording step.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { ALL_PHOTOS } from "../web/photos.ts";

const root = new URL("..", import.meta.url).pathname, UA = "ThursdayDinnerConcierge/1.0 (portfolio project; github.com/AKilalours/thursday-dinner-concierge)";
async function get(url, file) {
  if (existsSync(file)) return "cached";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { "user-agent": UA } }).catch(() => null);
    if (r?.ok) { writeFileSync(file, Buffer.from(await r.arrayBuffer())); return "ok"; }
    await new Promise((s) => setTimeout(s, 800));
  }
  return "FAILED";
}
const vdir = join(root, "docs/img/v"); mkdirSync(vdir, { recursive: true });
let n = 0, bad = 0;
for (const id of ALL_PHOTOS) for (const [k, q] of [["s", "w=520&h=340"], ["l", "w=1600&h=1000"]]) {
  const r = await get(`https://images.unsplash.com/${id}?${q}&fit=crop&auto=format&fm=jpg&q=72`, join(vdir, `${id}-${k}.jpg`)); n++; if (r === "FAILED") { bad++; console.log("photo failed", id, k); }
}
console.log(`photos: ${n - bad}/${n}`);
// Tiles: zooms 12-15 over lower and midtown Manhattan plus Williamsburg, politely (one at a time, small delay).
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z), lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
let t = 0, tb = 0;
for (let z = 12; z <= 15; z++) for (let x = lon2x(-74.03, z); x <= lon2x(-73.93, z); x++) for (let y = lat2y(40.775, z); y <= lat2y(40.695, z); y++) {
  const d = join(root, ".video-cache/tiles", String(z), String(x)); mkdirSync(d, { recursive: true });
  const r = await get(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, join(d, `${y}.png`)); t++; if (r === "FAILED") tb++; if (r === "ok") await new Promise((s) => setTimeout(s, 60));
}
console.log(`tiles: ${t - tb}/${t}`);
execSync(`tar czf node_modules/.media.tgz docs/img/v .video-cache`, { cwd: root });
console.log("packed node_modules/.media.tgz");
