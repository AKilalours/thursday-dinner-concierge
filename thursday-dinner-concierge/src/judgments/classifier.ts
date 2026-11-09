// A fast judgment: typed labels, a labelled confidence threshold per label, a timeout, a fallback,
// and a rollout mode. In shadow mode the deterministic rules decide and the model's answer is only
// logged next to it, so we can measure agreement on real traffic before letting the model decide.
import { z } from "zod";
import { structured } from "../llm/client.ts";
import type { LLM } from "../llm/client.ts";

export type Mode = "rules" | "shadow" | "live";

export interface Judgment<L extends string> {
  label: L;
  confidence: number;
  decidedBy: "model" | "rules" | "fallback";
  reason: string;
  shadow?: { label: L; confidence: number } | { error: string };
  latencyMs: number;
}

export interface ClassifierSpec<I, L extends string> {
  name: string;
  version: string;
  labels: readonly [L, ...L[]];
  /** Minimum confidence to act on each label. Labels with higher cost of error get higher thresholds. */
  thresholds: Record<L, number>;
  /** The safe answer when nothing clears its threshold. */
  fallback: L;
  timeoutMs: number;
  rules(input: I): { label: L; confidence: number; reason: string };
  prompt?(input: I): { system: string; user: string };
}

export const shadowLog: { classifier: string; version: string; rules: string; model: string | null; agree: boolean | null }[] = [];

export class Classifier<I, L extends string> {
  spec: ClassifierSpec<I, L>;
  mode: Mode;
  llm: LLM;
  constructor(spec: ClassifierSpec<I, L>, llm: LLM, mode: Mode = "rules") {
    this.spec = spec; this.llm = llm; this.mode = spec.prompt ? mode : "rules";
  }

  private gate(label: L, confidence: number): boolean {
    return confidence >= this.spec.thresholds[label];
  }

  private async model(input: I) {
    const p = this.spec.prompt!(input);
    const schema = z.object({ label: z.enum(this.spec.labels as unknown as [string, ...string[]]), confidence: z.number().min(0).max(1), reason: z.string().max(300) });
    return structured(this.llm, `classify_${this.spec.name}`, schema, p.system, p.user, this.spec.timeoutMs);
  }

  async classify(input: I): Promise<Judgment<L>> {
    const t0 = Date.now();
    const r = this.spec.rules(input);
    const ruled: Judgment<L> = this.gate(r.label, r.confidence)
      ? { label: r.label, confidence: r.confidence, decidedBy: "rules", reason: r.reason, latencyMs: 0 }
      : { label: this.spec.fallback, confidence: r.confidence, decidedBy: "fallback", reason: `below threshold: ${r.reason}`, latencyMs: 0 };

    if (this.mode === "rules" || this.llm.mode === "off") return { ...ruled, latencyMs: Date.now() - t0 };

    const m = await this.model(input);
    if (this.mode === "shadow") {
      const shadow = m.value ? { label: m.value.label as L, confidence: m.value.confidence } : { error: m.error ?? "no answer" };
      shadowLog.push({ classifier: this.spec.name, version: this.spec.version, rules: ruled.label, model: m.value?.label ?? null, agree: m.value ? m.value.label === ruled.label : null });
      return { ...ruled, shadow, latencyMs: Date.now() - t0 };
    }
    if (m.value && this.gate(m.value.label as L, m.value.confidence)) {
      return { label: m.value.label as L, confidence: m.value.confidence, decidedBy: "model", reason: m.value.reason, latencyMs: Date.now() - t0 };
    }
    // Timeout, error, or not confident enough: the rules decide, and below-threshold rules fall back.
    return { ...ruled, reason: `${m.error ?? "model below threshold"}; ${ruled.reason}`, latencyMs: Date.now() - t0 };
  }
}
