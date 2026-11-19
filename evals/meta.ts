// npm run evals:metamorphic
// Rewrites every real-user and scenario sentence the ways people type (caps, lowercase, pasted line breaks, "please",
// doubled spaces) and checks the booking it would make doesn't change, and that a changed headcount is followed.
import { metamorphic, SAME_MEANING } from "./metamorphic.ts";

const r = metamorphic();
for (const f of r.failures.slice(0, 20)) console.log(`✗ ${f.rewrite}: "${f.variant}"\n    was ${f.before}\n    now ${f.after}`);
console.log(`metamorphic: ${r.sentences} sentences, ${SAME_MEANING.length} same-meaning rewrites each plus a headcount change = ${r.checks} checks, ${r.failures.length} changed the booking`);
if (r.failures.length) process.exitCode = 1;
