// Bundles the real agent code (not a mock) for the browser playground in docs/, together with every
// recorded model output in evals/recordings, so the playground replays real Claude answers.
import { build } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const shim = join(root, "web/shims/");
const recDir = join(root, "evals/recordings");
const recordings = {};
if (existsSync(recDir)) for (const task of readdirSync(recDir)) {
  const dir = join(recDir, task);
  if (!task.startsWith(".") && existsSync(dir) && !task.includes(".")) for (const f of readdirSync(dir)) if (f.endsWith(".json")) recordings[`${task}/${f}`] = readFileSync(join(dir, f), "utf8");
}
await build({
  entryPoints: [join(root, "web/playground.ts")],
  bundle: true, format: "esm", minify: true, target: "es2022",
  outfile: join(root, "docs/app.js"),
  alias: { "node:crypto": `${shim}crypto.ts`, "node:fs": `${shim}empty.ts`, "node:path": `${shim}empty.ts` },
  define: { "process.env": "{}", "import.meta.url": '"https://example.invalid/"' },
  plugins: [{ name: "recordings", setup(b) {
    b.onResolve({ filter: /^virtual:recordings$/ }, () => ({ path: "recordings", namespace: "rec" }));
    b.onLoad({ filter: /.*/, namespace: "rec" }, () => ({ contents: JSON.stringify(recordings), loader: "json" }));
  } }],
});
console.log(`built docs/app.js with ${Object.keys(recordings).length} recorded model outputs`);
