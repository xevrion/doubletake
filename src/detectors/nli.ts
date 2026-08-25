import type { Detector, DetectorInput, Finding, Evidence, GroundingSource } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";
import { splitSentences, isCheckableClaim } from "./groundedness.ts";
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@huggingface/transformers";

// natural-language-inference grounding. this is the real hallucination check;
// the lexical one in groundedness.ts is the sub-millisecond pre-filter.
//
// why NLI and not "ask a model if it's true": entailment gives us three distinct
// states, and the difference between them is the difference between three
// different actions:
//   entailed      -> the sources back this claim         -> pass
//   neutral       -> the sources don't mention it        -> unverified, hedge it
//   contradiction -> the sources say otherwise           -> this is the bad one
// collapsing those into one "hallucination score" throws away the signal that
// tells a reviewer whether they're looking at a gap or a lie.

env.cacheDir = "./data/models";
env.allowRemoteModels = true;

const MODEL_ID = "Xenova/nli-deberta-v3-xsmall";

type Nli = {
  tokenizer: any;
  model: any;
  idx: { contradiction: number; entailment: number; neutral: number };
};

let nliPromise: Promise<Nli> | null = null;

// one shared load, kicked off at boot by warmNli(). a request must never be the
// thing that triggers a 7-second model download.
export function warmNli(): Promise<Nli> {
  if (!nliPromise) {
    nliPromise = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8" });
      // label order differs between NLI repos, so read it rather than assume it.
      const id2label: Record<string, string> = (model as any).config?.id2label ?? {};
      const idx = { contradiction: 0, entailment: 1, neutral: 2 };
      for (const [k, v] of Object.entries(id2label)) {
        const key = String(v).toLowerCase();
        if (key in idx) (idx as any)[key] = Number(k);
      }
      return { tokenizer, model, idx };
    })();
  }
  return nliPromise;
}

export function isNliReady(): boolean {
  return nliPromise !== null;
}

function softmax(xs: number[]): number[] {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export interface Entailment {
  entailment: number;
  contradiction: number;
  neutral: number;
}

export async function entail(premise: string, hypothesis: string): Promise<Entailment> {
  const { tokenizer, model, idx } = await warmNli();
  // the pair API, not the zero-shot pipeline: we need explicit control over
  // which side is the source and which is the claim.
  const inputs = await tokenizer(premise, { text_pair: hypothesis });
  const out = await model(inputs);
  const logits = out.logits.tolist()[0] as number[];
  const probs = softmax(logits);
  return {
    entailment: probs[idx.entailment]!,
    contradiction: probs[idx.contradiction]!,
    neutral: probs[idx.neutral]!,
  };
}

// sources get chunked so a long document doesn't dilute the one sentence that
// actually addresses the claim.
export function chunkSource(src: GroundingSource, sentencesPerChunk = 3): { id: string; text: string }[] {
  const sents = splitSentences(src.text).map((s) => s.text);
  if (sents.length <= sentencesPerChunk) return [{ id: src.id, text: src.text }];
  const chunks: { id: string; text: string }[] = [];
  // overlapping window: a claim spanning a chunk boundary still finds support.
  for (let i = 0; i < sents.length; i += sentencesPerChunk - 1) {
    const text = sents.slice(i, i + sentencesPerChunk).join(" ");
    if (text.trim()) chunks.push({ id: `${src.id}#${chunks.length}`, text });
  }
  return chunks;
}

export type ClaimVerdict = "entailed" | "contradicted" | "unsupported";

export interface NliClaim {
  claim: string;
  start: number;
  end: number;
  verdict: ClaimVerdict;
  entailment: number;
  contradiction: number;
  bestChunkId?: string;
  bestChunkText?: string;
}

export async function verifyClaims(response: string, sources: GroundingSource[]): Promise<NliClaim[]> {
  const claims = splitSentences(response).filter((s) => isCheckableClaim(s.text));
  if (claims.length === 0 || sources.length === 0) return [];

  const chunks = sources.flatMap((s) => chunkSource(s));
  const results: NliClaim[] = [];

  for (const c of claims) {
    let bestEnt = 0, bestContra = 0;
    let bestId: string | undefined, bestText: string | undefined;

    for (const chunk of chunks) {
      const e = await entail(chunk.text, c.text);
      // a claim only needs ONE passage to support it, so we take the max
      // entailment rather than averaging across chunks.
      if (e.entailment > bestEnt) {
        bestEnt = e.entailment;
        bestId = chunk.id;
        bestText = chunk.text;
      }
      // contradiction is tracked separately: being contradicted by any source
      // is serious even if a different source happens to support you.
      if (e.contradiction > bestContra) bestContra = e.contradiction;
    }

    const verdict: ClaimVerdict =
      bestContra > 0.5 && bestContra > bestEnt ? "contradicted"
      : bestEnt > 0.5 ? "entailed"
      : "unsupported";

    results.push({
      claim: c.text, start: c.start, end: c.end, verdict,
      entailment: bestEnt, contradiction: bestContra,
      bestChunkId: bestId, bestChunkText: bestText,
    });
  }
  return results;
}

export const nliDetector: Detector = {
  name: "groundedness:nli",
  tier: 1,
  categories: ["hallucination"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const sources = input.sources ?? [];
    if (sources.length === 0) return null; // the lexical detector owns this case

    const claims = await verifyClaims(input.response, sources);
    const latencyMs = performance.now() - t0;
    if (claims.length === 0) return null;

    const contradicted = claims.filter((c) => c.verdict === "contradicted");
    const unsupported = claims.filter((c) => c.verdict === "unsupported");

    // a contradiction is categorically worse than a gap, and the score has to
    // reflect that or the policy ladder can't tell them apart.
    let score: number;
    if (contradicted.length > 0) {
      score = Math.min(1, 0.75 + Math.max(...contradicted.map((c) => c.contradiction)) * 0.25);
    } else if (unsupported.length > 0) {
      score = Math.min(0.7, 0.25 + (unsupported.length / claims.length) * 0.45);
    } else {
      score = 0.05;
    }
    if (score < 0.15) return null;

    const evidence: Evidence[] = [
      ...contradicted.slice(0, 3).map((c): Evidence => ({
        kind: "citation",
        text: `CONTRADICTED (${(c.contradiction * 100).toFixed(0)}%): "${trunc(c.claim, 110)}" — sources say: "${trunc(c.bestChunkText ?? "", 110)}"`,
        start: c.start, end: c.end, sourceId: c.bestChunkId, value: c.contradiction,
      })),
      ...unsupported.slice(0, 3).map((c): Evidence => ({
        kind: "citation",
        text: `UNSUPPORTED (best entailment ${(c.entailment * 100).toFixed(0)}%): "${trunc(c.claim, 110)}"`,
        start: c.start, end: c.end, sourceId: c.bestChunkId, value: c.entailment,
      })),
      { kind: "metric", text: `${claims.length} claim(s) checked: ${claims.length - contradicted.length - unsupported.length} entailed, ${unsupported.length} unsupported, ${contradicted.length} contradicted`, value: claims.length },
    ];

    return {
      detector: "groundedness:nli",
      categories: ["hallucination"],
      score,
      severity: severityOf(score),
      // a confident contradiction is a strong, trustworthy signal. a pile of
      // "unsupported" is weaker: the sources may simply be incomplete.
      confidence: contradicted.length > 0 ? 0.85 : 0.6,
      evidence,
      latencyMs,
      tier: 1,
    };
  },
};

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
