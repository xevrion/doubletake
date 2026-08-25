import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";
import { splitSentences, isCheckableClaim, normalise } from "./groundedness.ts";

// tier 1: a second model reviews the first model's answer.
//
// two design decisions worth defending:
//   1. the judge NEVER returns prose. it returns a strict json verdict, because
//      a free-text opinion can't be thresholded and can't be audited.
//   2. the judge runs on a CHEAP model. using a frontier model to grade a
//      frontier model doubles your bill to catch a minority of cases; the whole
//      economic argument of this layer collapses if the checker costs as much
//      as the thing it checks.
//
// with no api key configured this falls back to a deterministic heuristic so the
// prototype still demos end-to-end offline. the fallback says so in its evidence
// -- pretending an offline stub is a model verdict would be exactly the kind of
// unearned confidence this whole project exists to catch.

const JUDGE_SYSTEM = `You are a verification model. You do not answer the user's question.
You assess whether the ASSISTANT ANSWER is supported by the SOURCES provided.

Return ONLY a JSON object, no prose, matching this shape:
{"supported": <0.0-1.0>, "unsupported_claims": ["..."], "confidence": <0.0-1.0>, "reasoning": "one sentence"}

Rules:
- "supported" is the fraction of factual claims that the SOURCES directly back up.
- A claim that contradicts a source scores 0.0, not a middling value.
- Specific numbers, dates, prices and policy terms must match the sources exactly.
- If SOURCES are empty, set confidence below 0.3: you cannot verify without them.
- Do not use outside knowledge. Only the SOURCES count as truth here.`;

export interface JudgeVerdict {
  supported: number;
  unsupported_claims: string[];
  confidence: number;
  reasoning: string;
}

// provider-agnostic on purpose: an enterprise consuming a foundation model via
// api shouldn't have to re-plumb its guardrails to switch vendors.
async function callJudge(prompt: string, response: string, sources: string): Promise<JudgeVerdict | null> {
  const base = process.env.JUDGE_BASE_URL ?? "https://api.groq.com/openai/v1";
  const key = process.env.JUDGE_API_KEY;
  const model = process.env.JUDGE_MODEL ?? "llama-3.1-8b-instant";
  if (!key) return null;

  const body = {
    model,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: `SOURCES:\n${sources || "(none provided)"}\n\nUSER QUESTION:\n${prompt}\n\nASSISTANT ANSWER:\n${response}` },
    ],
  };

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`judge http ${res.status}`);
  const json = (await res.json()) as any;
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) return null;

  const parsed = JSON.parse(raw) as JudgeVerdict;
  // never trust the shape a model hands back.
  return {
    supported: clamp01(Number(parsed.supported)),
    unsupported_claims: Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims.slice(0, 5).map(String) : [],
    confidence: clamp01(Number(parsed.confidence)),
    reasoning: String(parsed.reasoning ?? "").slice(0, 300),
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

// offline fallback: stricter than the tier-0 lexical check (it looks for direct
// numeric contradiction, not just absence) but clearly labelled as a stub.
function offlineVerdict(response: string, sources: string): JudgeVerdict {
  const claims = splitSentences(response).filter((s) => isCheckableClaim(s.text));
  const srcNums = new Set(normalise(sources).match(/\d+(?:\.\d+)?/g) ?? []);
  const contradicted: string[] = [];

  for (const c of claims) {
    const nums = normalise(c.text).match(/\d+(?:\.\d+)?/g) ?? [];
    // a number stated in the answer that the sources never mention, when the
    // sources DO talk in numbers, is the contradiction signature.
    if (nums.length > 0 && srcNums.size > 0 && nums.every((n) => !srcNums.has(n))) {
      contradicted.push(c.text.slice(0, 120));
    }
  }
  const supported = claims.length === 0 ? 1 : Math.max(0, 1 - contradicted.length / claims.length);
  return {
    supported,
    unsupported_claims: contradicted.slice(0, 5),
    confidence: sources ? 0.5 : 0.2,
    reasoning: "Offline heuristic verdict (no judge model configured): numeric claims cross-checked against source figures.",
  };
}

export const judgeDetector: Detector = {
  name: "groundedness:judge",
  tier: 1,
  categories: ["hallucination"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const sourceText = (input.sources ?? []).map((s) => `[${s.id}] ${s.text}`).join("\n\n");

    let verdict: JudgeVerdict | null = null;
    let offline = false;
    try {
      verdict = await callJudge(input.prompt, input.response, sourceText);
    } catch {
      verdict = null; // fall through to offline rather than failing the request
    }
    if (!verdict) {
      verdict = offlineVerdict(input.response, sourceText);
      offline = true;
    }

    const latencyMs = performance.now() - t0;
    const score = 1 - verdict.supported;
    if (score < 0.15) return null;

    const evidence: Evidence[] = [
      { kind: "metric", text: `Judge support score ${verdict.supported.toFixed(2)}${offline ? " (offline heuristic)" : ""}`, value: verdict.supported },
      { kind: "note", text: verdict.reasoning },
      ...verdict.unsupported_claims.map((c): Evidence => ({ kind: "citation", text: `Judge flagged: "${c}"` })),
    ];

    return {
      detector: offline ? "groundedness:judge-offline" : "groundedness:judge",
      categories: ["hallucination"],
      score,
      severity: severityOf(score),
      // the judge reports its own confidence; an offline stub is capped lower
      // so the policy layer treats it as the weaker signal it is.
      confidence: offline ? Math.min(0.5, verdict.confidence) : verdict.confidence,
      evidence,
      latencyMs,
      tier: 1,
    };
  },
};
