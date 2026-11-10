// Typed capabilities. Every call is validated in and out, runs as the acting user for a principal they
// may act for, is idempotent by key, and is audited. Consequential tools only run against an approved
// proposal, and the store refuses them otherwise even if this layer had a bug.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Company, User, Venue } from "../domain/types.ts";
import type { LLM } from "../llm/client.ts";
import type { VenueWorld } from "../sim/world.ts";
import type { Store } from "../store/store.ts";

export interface Ctx {
  store: Store;
  world: VenueWorld;
  llm: LLM;
  company: Company;
  venues: Venue[];
  actor: User;
  principal: User;
  runId: string;
  today: string;
  smsOptedOut: Set<string>;
  trace: TraceEvent[];
  /** Optional live listener (the web playground animates events as they happen). */
  onEvent?: (e: TraceEvent) => void;
  /** Re-enable a fixed bug, only to replay the original failure in the Fix lab. Never set in production paths. */
  legacy?: { r7?: boolean; r8?: boolean; r10?: boolean };
}

export interface TraceEvent { at: string; agent: string; kind: string; text: string; data?: Record<string, unknown> }

export interface Tool<I, O> {
  name: string;
  description: string;
  consequential: boolean;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  run(ctx: Ctx, input: I): Promise<O>;
}

export class ToolDenied extends Error {}

export function canActFor(actor: User, principal: User): boolean {
  return actor.companyId === principal.companyId && (actor.id === principal.id || actor.actsFor.includes(principal.id));
}

export async function call<I, O>(ctx: Ctx, agent: string, tool: Tool<I, O>, raw: unknown, key?: string): Promise<O> {
  if (!canActFor(ctx.actor, ctx.principal)) throw new ToolDenied(`${ctx.actor.name} may not act for ${ctx.principal.name}`);
  const input = tool.input.parse(raw);
  const idem = key ?? createHash("sha256").update(JSON.stringify([ctx.runId, tool.name, input])).digest("hex").slice(0, 32);
  const prior = await ctx.store.findToolCall(idem);
  if (prior) return tool.output.parse(prior.output);
  const out = tool.output.parse(await tool.run(ctx, input));
  await ctx.store.saveToolCall({ key: idem, runId: ctx.runId, tool: tool.name, actorId: ctx.actor.id, principalId: ctx.principal.id, input, output: out });
  await ctx.store.audit(ctx.runId, ctx.actor.id, `tool:${tool.name}`, { agent, onBehalfOf: ctx.principal.id, consequential: tool.consequential, input: input as unknown as Record<string, unknown> });
  return out;
}

export function log(ctx: Ctx, agent: string, kind: string, text: string, data?: Record<string, unknown>) {
  const e = { at: ctx.world.now, agent, kind, text, data };
  ctx.trace.push(e);
  ctx.onEvent?.(e);
  return ctx.store.appendStep(ctx.runId, agent, kind, { text, ...data });
}
