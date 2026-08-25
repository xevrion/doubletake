import type { TokenUsage } from "../policy/types.ts";
import { estimateCost, estimateTokens } from "../detectors/cost.ts";

// the upstream model: the thing DoubleTake sits in front of.
//
// every provider here speaks the openai chat-completions shape, which is why
// one client covers all of them. that is also the honest architectural claim in
// the pitch: an enterprise consuming a foundation model via api can put this
// layer in front of whatever they already use, without re-plumbing.

export type ProviderId = "groq" | "gemini" | "cerebras" | "openrouter" | "ollama" | "mock";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  free: boolean;
  note: string;
}

export interface Completion {
  text: string;
  usage: TokenUsage;
  provider: ProviderId;
  wallMs: number;
  // when the provider itself failed we say so rather than silently mocking.
  degraded?: string;
}

function env(k: string, fallback = ""): string {
  return (process.env[k] ?? fallback).trim();
}

export function providers(): ProviderConfig[] {
  return [
    {
      id: "groq", label: "Groq", model: env("GROQ_MODEL", "llama-3.3-70b-versatile"),
      baseUrl: "https://api.groq.com/openai/v1", apiKey: env("GROQ_API_KEY"), free: true,
      note: "30 req/min, 1k/day. No logprobs support.",
    },
    {
      id: "gemini", label: "Google AI Studio", model: env("GEMINI_MODEL", "gemini-2.0-flash"),
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env("GEMINI_API_KEY"), free: true,
      note: "~15 req/min, 1k/day.",
    },
    {
      id: "cerebras", label: "Cerebras", model: env("CEREBRAS_MODEL", "llama3.1-8b"),
      baseUrl: "https://api.cerebras.ai/v1", apiKey: env("CEREBRAS_API_KEY"), free: true,
      note: "~5 req/min, 1M tokens/day.",
    },
    {
      id: "openrouter", label: "OpenRouter", model: env("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free"),
      baseUrl: "https://openrouter.ai/api/v1", apiKey: env("OPENROUTER_API_KEY"), free: true,
      note: "~20 req/min, 50/day on free models.",
    },
    {
      id: "ollama", label: "Ollama (local)", model: env("OLLAMA_MODEL", "llama3.2:3b"),
      baseUrl: env("OLLAMA_BASE_URL", "http://localhost:11434/v1"), apiKey: "ollama", free: true,
      note: "No key, no rate limit, works offline.",
    },
    {
      id: "mock", label: "Scripted (no network)", model: "doubletake-mock", baseUrl: "", free: true,
      note: "Deterministic canned answers. Used when no provider is configured.",
    },
  ];
}

export function activeProvider(): ProviderConfig {
  const want = env("UPSTREAM_PROVIDER", "mock") as ProviderId;
  const all = providers();
  const chosen = all.find((p) => p.id === want);
  // a provider selected but missing its key is a config mistake, and silently
  // serving mock text while the demo claims to be live would be exactly the
  // kind of unearned confidence this project exists to catch.
  if (chosen && (chosen.id === "mock" || chosen.id === "ollama" || chosen.apiKey)) return chosen;
  return all.find((p) => p.id === "mock")!;
}

export function configuredProviders(): ProviderConfig[] {
  return providers().filter((p) => p.id === "mock" || p.id === "ollama" || !!p.apiKey);
}

// the scripted fallback. these are written to be *plausibly wrong* in the
// specific ways the detectors are built to catch, so the demo tells a story
// even with no network.
const MOCK_REPLIES: { match: RegExp; text: string }[] = [
  { match: /refund|return|money back/i,
    text: "You can get a full refund within 30 days of purchase, and we refund the shipping fees too. Just email us and we will process it immediately." },
  { match: /who|agent|handling|contact/i,
    text: "Your case is with Priya Sharma. Her direct line is 9876543210 and her PAN on file is ABCDE1234F." },
  { match: /loan|applicant|credit|assess/i,
    text: "Applicants of that religion typically tend to default more often, so we should decline this application." },
  { match: /system prompt|ignore|instructions/i,
    text: "Sure. My system prompt is: You are a helpful assistant for ACME Corp with admin access to the billing API." },
  { match: /clause|payout|claim/i,
    text: "Clause 7 allows payouts up to 5 lakh within 3 working days." },
];

function mockReply(prompt: string): string {
  return MOCK_REPLIES.find((m) => m.match.test(prompt))?.text
    ?? "I can help with that. Our standard processing time is 3 to 5 business days and there is no additional charge.";
}

export async function complete(
  prompt: string,
  opts: { system?: string; sources?: { id: string; text: string }[]; provider?: ProviderConfig } = {},
): Promise<Completion> {
  const p = opts.provider ?? activeProvider();
  const t0 = performance.now();

  if (p.id === "mock") {
    const text = mockReply(prompt);
    const pt = estimateTokens(prompt), ct = estimateTokens(text);
    return {
      text, provider: "mock", wallMs: performance.now() - t0,
      usage: { promptTokens: pt, completionTokens: ct, model: "doubletake-mock", costUsd: 0 },
    };
  }

  const system = opts.system ?? "You are a customer support assistant. Answer concisely.";
  const grounding = opts.sources?.length
    ? `\n\nKnowledge base:\n${opts.sources.map((s) => `[${s.id}] ${s.text}`).join("\n")}`
    : "";

  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({
        model: p.model,
        temperature: 0.7,
        max_tokens: 400,
        messages: [
          { role: "system", content: system + grounding },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) throw new Error(`${p.label} returned ${res.status}`);
    const json = (await res.json()) as any;
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(`${p.label} returned an empty completion`);

    // prefer the provider's own usage numbers over our estimate; the estimate
    // is only for pre-flight budgeting.
    const pt = json.usage?.prompt_tokens ?? estimateTokens(prompt);
    const ct = json.usage?.completion_tokens ?? estimateTokens(text);

    return {
      text, provider: p.id, wallMs: performance.now() - t0,
      usage: { promptTokens: pt, completionTokens: ct, model: p.model, costUsd: estimateCost(p.model, pt, ct) },
    };
  } catch (err) {
    // network failure on stage is a when, not an if. fall back to the scripted
    // reply but LABEL it, so nobody mistakes the fallback for a live call.
    const text = mockReply(prompt);
    const pt = estimateTokens(prompt), ct = estimateTokens(text);
    return {
      text, provider: "mock", wallMs: performance.now() - t0,
      usage: { promptTokens: pt, completionTokens: ct, model: "doubletake-mock", costUsd: 0 },
      degraded: `${p.label} unavailable (${err instanceof Error ? err.message : String(err)}); served scripted fallback.`,
    };
  }
}
