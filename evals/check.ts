// npm run llm:check   One real model call: proves the key and model work before a long eval run.
import { z } from "zod";
import { llmFromEnv, structured } from "../src/llm/client.ts";

const llm = llmFromEnv();
console.log(`mode: ${llm.mode} · model: ${process.env.ANDE_MODEL ?? "claude-sonnet-4-5"}`);
if (llm.mode !== "live" && llm.mode !== "record") { console.log("No live model: set ANTHROPIC_API_KEY (keys start with sk-ant-api03-)."); process.exit(1); }
const r = await structured(llm, "check", z.object({ partySize: z.number().int() }), "Reply with JSON only.", 'Extract {"partySize"} from: "dinner for 12 with the Acme team next Thursday"', 20000);
if (r.value) console.log(`OK · model answered partySize=${r.value.partySize} in ${r.latencyMs} ms`);
else { console.log(`FAILED · ${r.error}`); console.log("401 = bad key · 404 = model name not available to you (set ANDE_MODEL) · timed out = network"); process.exit(1); }
