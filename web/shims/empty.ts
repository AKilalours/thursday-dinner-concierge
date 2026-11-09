// Browser stand-in for node:fs and node:path. Reads come from the recorded model outputs bundled at
// build time, so the playground replays exactly what Claude answered; writes are no-ops.
// @ts-expect-error virtual module provided by web/build.mjs
import RECORDINGS from "virtual:recordings";
const rec = RECORDINGS as Record<string, string>;
const key = (p: string) => p.replace(/^.*evals\/recordings\//, "");
export const existsSync = (p: string) => key(p) in rec;
export const readFileSync = (p: string) => rec[key(p)] ?? "";
export const mkdirSync = () => undefined;
export const writeFileSync = () => undefined;
export const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
export const recordingCount = Object.keys(rec).length;
