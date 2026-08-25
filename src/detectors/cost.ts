import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// the cost axis. this is the part every other guardrail product leaves out,
// and it's the one that makes the whole layer self-funding.
//
// prices are USD per million tokens. VERIFY THESE before quoting them in the
// pitch -- provider pricing moves and this table is a snapshot, not a source
// of truth. structure matters more than the exact cents here.
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  tier: "frontier" | "mid" | "cheap";
  // rough capability score, used by the router to find the cheapest model that
  // can still plausibly do the job.
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

// no tokenizer dependency: ~4 chars per token is close enough for budgeting and
// avoids shipping a 2MB wasm blob for a number we only use to compare against
// a threshold. swap in tiktoken if exact accounting is ever needed.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// budget state per API key / tenant. in production this is redis; a map is
// honest for a prototype and keeps the demo dependency-free.
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

const DEFAULT_BUDGET: BudgetConfig = { hourlyUsdCap: 5.0, perRequestUsdCap: 0.25, loopThreshold: 4 };

function hashish(s: string): string {
  // cheap content signature; we only need "is this the same request again".
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

      const sig = hashish(input.prompt);
      b.recentHashes.push(sig);
      if (b.recentHashes.length > 12) b.recentHashes.shift();
      const repeats = b.recentHashes.filter((h) => h === sig).length;

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

      // 3. the same prompt over and over: a runaway agent loop, which is the
      // expensive failure mode nobody notices until the invoice arrives.
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
        confidence: 0.99, // arithmetic on observed usage; nothing to be unsure about
        evidence,
        latencyMs,
        tier: 0,
      };
    },
  };
}

// the routing side of the cost story: pick the cheapest model whose capability
// clears what the task needs. this is where the savings that fund the oversight
// actually come from.
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
