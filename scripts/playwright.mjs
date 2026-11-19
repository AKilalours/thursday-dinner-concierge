// Playwright is not a dependency (CI installs a pinned copy with --no-save), so a fresh clone has no
// local copy. ESM imports ignore NODE_PATH and global installs; fall back to them before giving up,
// and say how to install it instead of dumping ERR_MODULE_NOT_FOUND.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { join } from "node:path";

async function load() {
  try { return await import("playwright"); } catch (e) { if (e.code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const require = createRequire(import.meta.url);
  try { return require("playwright"); } catch {}
  try { return require(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright")); } catch {}
  console.error("site:check needs playwright: npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

export const { chromium } = await load();
