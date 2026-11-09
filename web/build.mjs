// Bundles the real agent code (not a mock) for the browser playground in docs/.
import { build } from "esbuild";
const shim = new URL("./shims/", import.meta.url).pathname;
await build({
  entryPoints: [new URL("./playground.ts", import.meta.url).pathname],
  bundle: true, format: "esm", minify: true, target: "es2022",
  outfile: new URL("../docs/app.js", import.meta.url).pathname,
  alias: { "node:crypto": `${shim}crypto.ts`, "node:fs": `${shim}empty.ts`, "node:path": `${shim}empty.ts` },
  define: { "process.env": "{}", "import.meta.url": '"https://example.invalid/"' },
});
console.log("built docs/app.js");
