// A small slippy map: real OpenStreetMap data (CARTO light tiles), Web Mercator, pan and zoom, no library.
// Callers draw their own SVG on top using toPoint(lat, lng); onChange fires whenever the view moves.
export type LatLng = [number, number];
const TILE = 256;
const tileUrl = (z: number, x: number, y: number) => `https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}${devicePixelRatio > 1 ? "@2x" : ""}.png`;
const worldPx = ([lat, lng]: LatLng, z: number): [number, number] => {
  const s = TILE * 2 ** z, r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return [((lng + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
};
const fromWorld = (x: number, y: number, z: number): LatLng => {
  const s = TILE * 2 ** z, n = Math.PI - (2 * Math.PI * y) / s;
  return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), (x / s) * 360 - 180];
};

export class RealMap {
  el: HTMLElement; tiles: HTMLDivElement; center: LatLng; zoom: number; min: number; max: number;
  private cache = new Map<string, HTMLImageElement>(); private listeners: (() => void)[] = []; failed = 0; loaded = 0;
  constructor(el: HTMLElement, opts: { center: LatLng; zoom: number; interactive?: boolean; min?: number; max?: number }) {
    this.el = el; this.center = opts.center; this.zoom = opts.zoom; this.min = opts.min ?? 11; this.max = opts.max ?? 17;
    el.classList.add("rmap"); this.tiles = document.createElement("div"); this.tiles.className = "rtiles"; el.prepend(this.tiles);
    const attr = document.createElement("div"); attr.className = "rattr"; attr.innerHTML = `© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`; el.append(attr);
    if (opts.interactive) this.interact();
    new ResizeObserver(() => this.render()).observe(el);
    this.render();
  }
  onChange(fn: () => void) { this.listeners.push(fn); }
  size() { return [this.el.clientWidth, this.el.clientHeight] as const; }
  /** Container pixel position of a coordinate at the current view. */
  toPoint(ll: LatLng): [number, number] {
    const [w, h] = this.size(), [cx, cy] = worldPx(this.center, this.zoom), [x, y] = worldPx(ll, this.zoom);
    return [x - cx + w / 2, y - cy + h / 2];
  }
  /** Fit a set of coordinates with some padding (integer zoom, so tiles stay sharp). */
  fit(points: LatLng[], pad = 40) {
    const [w, h] = this.size(); if (!w || !h) return;
    for (let z = this.max; z >= this.min; z--) {
      const px = points.map((p) => worldPx(p, z)), xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
      if (Math.max(...xs) - Math.min(...xs) <= w - 2 * pad && Math.max(...ys) - Math.min(...ys) <= h - 2 * pad) {
        this.zoom = z; this.center = fromWorld((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, z); break;
      }
    }
    this.render();
  }
  setView(center: LatLng, zoom: number) { this.center = center; this.zoom = Math.max(this.min, Math.min(this.max, zoom)); this.render(); }
  zoomBy(d: number, at?: [number, number]) {
    const nz = Math.max(this.min, Math.min(this.max, this.zoom + d)); if (nz === this.zoom) return;
    if (at) { const [w, h] = this.size(), [cx, cy] = worldPx(this.center, this.zoom), wx = cx + at[0] - w / 2, wy = cy + at[1] - h / 2, k = 2 ** (nz - this.zoom); this.center = fromWorld(wx * k - (at[0] - w / 2), wy * k - (at[1] - h / 2), nz); }
    this.zoom = nz; this.render();
  }
  render() {
    const [w, h] = this.size(); if (!w || !h) return;
    const z = this.zoom, [cx, cy] = worldPx(this.center, z), x0 = cx - w / 2, y0 = cy - h / 2, n = 2 ** z, want = new Set<string>();
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const key = `${z}/${tx}/${ty}`; want.add(key);
      let img = this.cache.get(key);
      if (!img) {
        img = new Image(); img.alt = ""; img.draggable = false; img.className = "rtile";
        img.onload = () => { this.loaded++; img!.classList.add("on"); this.el.classList.remove("offline"); };
        img.onerror = () => { this.failed++; if (!this.loaded) this.el.classList.add("offline"); };
        img.src = tileUrl(z, ((tx % n) + n) % n, ty); this.cache.set(key, img); this.tiles.append(img);
      }
      img.style.transform = `translate(${Math.round(tx * TILE - x0)}px,${Math.round(ty * TILE - y0)}px)`;
    }
    for (const [k, img] of this.cache) if (!want.has(k)) { img.remove(); this.cache.delete(k); }
    this.listeners.forEach((f) => f());
  }
  private interact() {
    const el = this.el; let drag: { x: number; y: number; c: [number, number] } | null = null; let moved = false;
    el.addEventListener("pointerdown", (e) => { if ((e.target as Element).closest("[data-nodrag],button,a")) return; drag = { x: e.clientX, y: e.clientY, c: worldPx(this.center, this.zoom) }; moved = false; el.classList.add("grab"); });
    window.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; this.center = fromWorld(drag.c[0] - dx, drag.c[1] - dy, this.zoom); this.render(); });
    window.addEventListener("pointerup", () => { drag = null; el.classList.remove("grab"); });
    el.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    let wheelT = 0;
    el.addEventListener("wheel", (e) => { e.preventDefault(); const now = Date.now(); if (now - wheelT < 220) return; wheelT = now; const r = el.getBoundingClientRect(); this.zoomBy(e.deltaY > 0 ? -1 : 1, [e.clientX - r.left, e.clientY - r.top]); }, { passive: false });
    el.addEventListener("dblclick", (e) => { const r = el.getBoundingClientRect(); this.zoomBy(1, [e.clientX - r.left, e.clientY - r.top]); });
  }
}

/** Real neighborhood centres; fictional venues are placed around them so the map reads like the city. */
export const HOODS: Record<string, LatLng> = {
  Midtown: [40.7549, -73.9840], Chelsea: [40.7465, -74.0014], Flatiron: [40.7411, -73.9897], "West Village": [40.7358, -74.0036],
  SoHo: [40.7233, -74.0030], Tribeca: [40.7163, -74.0086], "Financial District": [40.7075, -74.0113], Williamsburg: [40.7135, -73.9571],
};
export const OFFICE: LatLng = [40.7406, -73.9877];
export function venueLatLng(neighborhood: string, k: number): LatLng {
  const [lat, lng] = HOODS[neighborhood] ?? HOODS.Flatiron, a = k * 2.399963, r = 0.0016 + 0.0011 * Math.sqrt(k);
  return [lat + r * Math.sin(a), lng + r * Math.cos(a) * 1.3];
}
