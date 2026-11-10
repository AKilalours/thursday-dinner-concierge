// One small model client. Modes:
//   off     - no model; every judgment uses its deterministic fallback
//   live    - call the model
//   record  - call the model and save each output by prompt hash (evals/recordings)
//   replay  - only recorded outputs; an unrecorded prompt raises NotRecorded (CI runs this way, no key, no cost)
// A replayed answer is always one the model really gave for exactly that prompt.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

export interface Completion { text: string; inputTokens: number; outputTokens: number; model: string }
export interface LLM {
  readonly mode: "off" | "live" | "record" | "replay";
  complete(task: string, system: string, user: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<Completion>;
}

export class NotRecorded extends Error {}
export class ModelOff extends Error {}

const RECORDINGS = new URL("../../evals/recordings/", import.meta.url).pathname;

function key(task: string, system: string, user: string, model: string) {
  return createHash("sha256").update([task, model, system, user].join("\u001f")).digest("hex").slice(0, 24);
}

class Off implements LLM {
  readonly mode = "off" as const;
  async complete(): Promise<Completion> { throw new ModelOff("no model configured"); }
}

export class AnthropicLLM implements LLM {
  readonly mode: "live" | "record";
  private model: string;
  private apiKey: string;
  private dir: string;
  constructor(apiKey: string, model: string, mode: "live" | "record" = "live", dir = RECORDINGS) {
    this.apiKey = apiKey; this.model = model; this.mode = mode; this.dir = dir;
  }

  async complete(task: string, system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: opts.signal,
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, max_tokens: opts.maxTokens ?? 800, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`model endpoint returned HTTP ${res.status}`);
    const d = await res.json() as { content: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    const out: Completion = {
      text: d.content.filter((c) => c.type === "text").map((c) => c.text).join(""),
      inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0, model: this.model,
    };
    if (this.mode === "record") {
      mkdirSync(join(this.dir, task), { recursive: true });
      writeFileSync(join(this.dir, task, `${key(task, system, user, this.model)}.json`), JSON.stringify(out, null, 1));
    }
    return out;
  }
}

export class ReplayLLM implements LLM {
  readonly mode = "replay" as const;
  private model: string;
  private dir: string;
  constructor(model: string, dir = RECORDINGS) { this.model = model; this.dir = dir; }
  async complete(task: string, system: string, user: string): Promise<Completion> {
    const f = join(this.dir, task, `${key(task, system, user, this.model)}.json`);
    if (!existsSync(f)) throw new NotRecorded(`no recording for ${task}`);
    return JSON.parse(readFileSync(f, "utf8"));
  }
}

/** Calls the model through the project's small server (server/worker.js), so the API key never reaches a browser. */
export class RemoteLLM implements LLM {
  readonly mode = "live" as const;
  private base: string;
  constructor(base: string) { this.base = base.replace(/\/$/, ""); }
  async complete(task: string, system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    const res = await fetch(`${this.base}/llm`, { method: "POST", signal: opts.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ task, system, user, maxTokens: opts.maxTokens }) });
    if (!res.ok) throw new Error(`model endpoint returned HTTP ${res.status}`);
    return await res.json() as Completion;
  }
}

/** Live first; if the live call fails for any reason other than our own timeout, answer from the recordings. */
export class LiveThenReplay implements LLM {
  readonly mode = "live" as const;
  live: LLM; replay: LLM; liveCalls = 0; replayed = 0;
  constructor(live: LLM, replay: LLM) { this.live = live; this.replay = replay; }
  async complete(task: string, system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
    try { const c = await this.live.complete(task, system, user, opts); this.liveCalls++; return c; }
    catch (e) { if (opts.signal?.aborted) throw e; this.replayed++; return this.replay.complete(task, system, user); }
  }
}

export function llmFromEnv(env = process.env): LLM {
  const model = env.ANDE_MODEL ?? "claude-sonnet-4-5";
  const mode = env.ANDE_LLM_MODE ?? (env.ANTHROPIC_API_KEY ? "live" : "replay");
  if (mode === "off") return new Off();
  if (mode === "replay") return new ReplayLLM(model);
  if (!env.ANTHROPIC_API_KEY) throw new Error(`ANDE_LLM_MODE=${mode} needs ANTHROPIC_API_KEY`);
  return new AnthropicLLM(env.ANTHROPIC_API_KEY, model, mode === "record" ? "record" : "live");
}

export const offline: LLM = new Off();

export interface StructuredResult<T> { value: T | null; attempts: number; error: string | null; latencyMs: number }

/**
 * Ask for JSON matching a schema. The output is parsed and validated by code; one retry with the
 * validation error; a hard timeout. Never throws: callers decide the fallback.
 */
export async function structured<T>(
  llm: LLM, task: string, schema: z.ZodType<T>, system: string, user: string, timeoutMs = 8000,
): Promise<StructuredResult<T>> {
  const t0 = Date.now();
  if (llm.mode === "off") return { value: null, attempts: 0, error: "model off", latencyMs: 0 };
  let prompt = user;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const c = await Promise.race([
        llm.complete(task, system, prompt, { signal: ctl.signal }),
        new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error(`timed out after ${timeoutMs} ms`)))),
      ]);
      const json = c.text.slice(c.text.indexOf("{"), c.text.lastIndexOf("}") + 1);
      const parsed = schema.safeParse(JSON.parse(json || "null"));
      if (parsed.success) return { value: parsed.data, attempts: attempt, error: null, latencyMs: Date.now() - t0 };
      prompt = `${user}\n\nYour last answer did not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Reply with JSON only.`;
    } catch (e) {
      // Regression R9: an aborted fetch rejects with "This operation was aborted", not our "timed out" message,
      // so a timeout used to be retried and cost twice the budget. Our own abort always means a timeout.
      if (ctl.signal.aborted) return { value: null, attempts: attempt, error: `timed out after ${timeoutMs} ms`, latencyMs: Date.now() - t0 };
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof NotRecorded || e instanceof ModelOff || /timed out|HTTP 4/.test(msg)) {
        return { value: null, attempts: attempt, error: msg, latencyMs: Date.now() - t0 };
      }
      if (attempt === 2) return { value: null, attempts: attempt, error: msg, latencyMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
  return { value: null, attempts: 2, error: "invalid output twice", latencyMs: Date.now() - t0 };
}
