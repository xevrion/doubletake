import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// The cost axis, which is the part other guardrail products leave out.
//
// Prices are USD per million tokens and are a snapshot, not a source of truth.
// Re-verify before quoting them anywhere it matters.
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  tier: "frontier" | "mid" | "cheap";
  // Used by the router to find the cheapest model that can still do the job.
  capability: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "gpt-class-frontier":   { inputPerM: 2.50,  outputPerM: 10.00, tier: "frontier", capability: 0.95 },
  "claude-class-frontier":{ inputPerM: 3.00,  outputPerM: 15.00, tier: "frontier", capability: 0.97 },
  "gpt-class-mini":       { inputPerM: 0.15,  outputPerM: 0.60,  tier: "mid",      capability: 0.78 },
  "claude-class-haiku":   { inputPerM: 0.25,  outputPerM: 1.25,  tier: "mid",      capability: 0.80 },
  "llama-70b-groq":       { inputPerM: 0.59,  outputPerM: 0.79,  tier: "mid",      capability: 0.74 },
  "llama-8b-groq":        { inputPerM: 0.05,  outputPerM: 0.08,  tier: "cheap",    capability: 0.55 },
  "gemini-flash":         { inputPerM: 0.075, outputPerM: 0.30,  tier: "cheap",    capability: 0.72 },
  "local-ollama":         { inputPerM: 0,     outputPerM: 0,     tier: "cheap",    capability: 0.50 },
};

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? { inputPerM: 1, outputPerM: 3, tier: "mid", capability: 0.7 };
}

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceOf(model);
  return (promptTokens / 1e6) * p.inputPerM + (completionTokens / 1e6) * p.outputPerM;
}

// Four characters per token is close enough for budgeting. Real usage figures
// from the provider are preferred wherever they exist; this is for pre-flight.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Per-tenant budget state. Redis in production; a map keeps the prototype free
// of dependencies.
interface Budget {
  spentUsd: number;
  windowStart: number;
  requestCount: number;
  // consecutive near-identical requests: the signature of an agent stuck in a loop.
  recentHashes: string[];
}

const budgets = new Map<string, Budget>();
const WINDOW_MS = 60 * 60 * 1000;

export interface BudgetConfig {
  hourlyUsdCap: number;
  perRequestUsdCap: number;
  loopThreshold: number;
}

// A runaway loop is one caller repeating itself, not many callers asking the
// same popular question. Keying repetition on the profile made "what is your
// refund window?" look like an agent stuck in a cycle, which in a load test
// flagged a third of all clean traffic. Repetition only counts within a single
// conversation, so a session id is required before the check runs at all.

const DEFAULT_BUDGET: BudgetConfig = { hourlyUsdCap: 5.0, perRequestUsdCap: 0.25, loopThreshold: 4 };

function hashish(s: string): string {
  let h = 0;
  const norm = s.toLowerCase().replace(/\s+/g, " ").slice(0, 400);
  for (let i = 0; i < norm.length; i++) { h = ((h << 5) - h + norm.charCodeAt(i)) | 0; }
  return String(h);
}

export function resetBudgets(): void { budgets.clear(); }

export function budgetState(key: string): Budget {
  const now = Date.now();
  let b = budgets.get(key);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { spentUsd: 0, windowStart: now, requestCount: 0, recentHashes: [] };
    budgets.set(key, b);
  }
  return b;
}

export function makeCostDetector(cfg: BudgetConfig = DEFAULT_BUDGET): Detector {
  return {
    name: "cost:meter",
    tier: 0,
    categories: ["cost"],
    async run(input: DetectorInput): Promise<Finding | null> {
      const t0 = performance.now();
      const usage = input.usage;
      if (!usage) return null;

      const key = input.profileId;
      const b = budgetState(key);
      b.spentUsd += usage.costUsd;
      b.requestCount += 1;

      // Repetition is tracked per conversation. Without one there is nothing to
      // loop within, and counting across callers produces false alarms on
      // exactly the questions a support bot is meant to answer often.
      let repeats = 0;
      if (input.sessionId) {
        const conv = budgetState(`session:${input.sessionId}`);
        const sig = hashish(input.prompt);
        conv.recentHashes.push(sig);
        if (conv.recentHashes.length > 12) conv.recentHashes.shift();
        repeats = conv.recentHashes.filter((h) => h === sig).length;
      }

      const evidence: Evidence[] = [];
      let score = 0;

      // 1. this single call was disproportionately expensive.
      const perReq = usage.costUsd / cfg.perRequestUsdCap;
      if (perReq > 0.5) {
        score = Math.max(score, Math.min(1, perReq));
        evidence.push({ kind: "metric", text: `Request cost $${usage.costUsd.toFixed(4)} against a $${cfg.perRequestUsdCap} per-request cap`, value: usage.costUsd });
      }

      // 2. the hourly budget for this use case is running out.
      const burn = b.spentUsd / cfg.hourlyUsdCap;
      if (burn > 0.6) {
        score = Math.max(score, Math.min(1, burn));
        evidence.push({ kind: "metric", text: `Hourly spend $${b.spentUsd.toFixed(2)} of $${cfg.hourlyUsdCap} cap (${(burn * 100).toFixed(0)}%)`, value: b.spentUsd });
      }

      // A runaway agent loop: the expensive failure nobody notices until the invoice.
      if (repeats >= cfg.loopThreshold) {
        const s = Math.min(1, 0.6 + repeats * 0.08);
        score = Math.max(score, s);
        evidence.push({ kind: "metric", text: `Near-identical prompt repeated ${repeats}x in the last 12 requests: possible agent loop`, value: repeats });
      }

      const latencyMs = performance.now() - t0;
      if (evidence.length === 0) return null;

      return {
        detector: "cost:meter",
        categories: ["cost"],
        score,
        severity: severityOf(score),
        confidence: 0.99, // arithmetic on observed usage
        evidence,
        latencyMs,
        tier: 0,
      };
    },
  };
}

// Cheapest model whose capability clears the task. This is where the savings that
// fund the oversight come from.
export function routeModel(requiredCapability: number, exclude: string[] = []): { model: string; price: ModelPrice } {
  const candidates = Object.entries(PRICES)
    .filter(([name, p]) => p.capability >= requiredCapability && !exclude.includes(name))
    .sort((a, b) => (a[1].inputPerM + a[1].outputPerM) - (b[1].inputPerM + b[1].outputPerM));
  const [model, price] = candidates[0] ?? ["claude-class-frontier", PRICES["claude-class-frontier"]!];
  return { model, price };
}

export function routingSavings(baselineModel: string, chosenModel: string, promptTokens: number, completionTokens: number): number {
  return estimateCost(baselineModel, promptTokens, completionTokens) - estimateCost(chosenModel, promptTokens, completionTokens);
}
