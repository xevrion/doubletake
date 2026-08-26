import type { Detector, DetectorInput, Finding, Evidence, GroundingSource } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";
import { splitSentences, isCheckableClaim, normalise as normaliseText } from "./groundedness.ts";
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@huggingface/transformers";

// NLI grounding: the real hallucination check.
//
// Entailment gives three states where a judge model gives a score, and the
// difference between them maps onto different actions. Entailed passes;
// unsupported means the sources are silent, which is often a knowledge-base gap;
// contradicted means the sources say otherwise, which is the serious one.
// Collapsing them into one score loses exactly what a reviewer needs.

env.cacheDir = "./data/models";
env.allowRemoteModels = true;

const MODEL_ID = "Xenova/nli-deberta-v3-xsmall";

type Nli = {
  tokenizer: any;
  model: any;
  idx: { contradiction: number; entailment: number; neutral: number };
};

let nliPromise: Promise<Nli> | null = null;

// Loaded once at boot. A request must never trigger the 7-second cold start.
export function warmNli(): Promise<Nli> {
  if (!nliPromise) {
    nliPromise = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8" });
      // Label order differs between NLI repos.
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

// the model is loaded lazily on first use anyway; this just makes the intent
// explicit at the call site.
export function ensureNli(): Promise<unknown> {
  return warmNli();
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
  // Pair API, not the zero-shot pipeline: premise and hypothesis must be explicit.
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

// Chunked so a long document cannot dilute the sentence that addresses the claim.
export function chunkSource(src: GroundingSource, sentencesPerChunk = 3): { id: string; text: string }[] {
  const sents = splitSentences(src.text).map((s) => s.text);
  if (sents.length <= sentencesPerChunk) return [{ id: src.id, text: src.text }];
  const chunks: { id: string; text: string }[] = [];
  // Overlapping, so a claim spanning a boundary still finds its support.
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

// NLI models are unreliable on unrelated pairs: given a lending policy as the
// premise and a refund statement as the hypothesis, the model returns 0.99
// contradiction rather than neutral, because the pair is out of distribution.
// Checking every claim against every document therefore manufactures
// contradictions purely from corpus size.
//
// A cheap lexical filter fixes it. Only passages that share vocabulary with the
// claim are worth asking about, which is what a retrieval step would do in a
// real deployment anyway.
const CHUNK_STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "within", "after", "not"]);

function keyTerms(text: string): Set<string> {
  const words = normaliseText(text).toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  return new Set(words.filter((w) => w.length > 3 && !CHUNK_STOPWORDS.has(w)));
}

export function relevantChunks(
  claim: string,
  chunks: { id: string; text: string }[],
  minOverlap = 2,
): { id: string; text: string }[] {
  const claimTerms = keyTerms(claim);
  const scored = chunks
    .map((c) => {
      const t = keyTerms(c.text);
      let overlap = 0;
      for (const w of claimTerms) if (t.has(w)) overlap++;
      return { chunk: c, overlap };
    })
    .filter((x) => x.overlap >= minOverlap)
    .sort((a, b) => b.overlap - a.overlap);

  // Nothing relevant means the sources genuinely do not address this claim, so
  // the caller sees an empty list and reports it as unsupported.
  return scored.slice(0, 6).map((x) => x.chunk);
}

// Is this claim stated more or less word for word in one of the sources? Not a
// substitute for entailment, which handles paraphrase; a guard for the case the
// model gets wrong.
function quotedFrom(
  claim: string,
  chunks: { id: string; text: string }[],
): { id: string; text: string } | null {
  const needle = normaliseText(claim).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (needle.length < 24) return null;
  for (const chunk of chunks) {
    const hay = normaliseText(chunk.text).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
    if (hay.includes(needle)) return chunk;
  }
  return null;
}

export async function verifyClaims(response: string, sources: GroundingSource[]): Promise<NliClaim[]> {
  const claims = splitSentences(response).filter((s) => isCheckableClaim(s.text));
  if (claims.length === 0 || sources.length === 0) return [];

  const allChunks = sources.flatMap((s) => chunkSource(s));
  // Claims are independent of each other, and so are the chunks within a claim.
  // Verifying them one at a time turned a 20ms model into a 250ms detector that
  // the fast profiles could not afford, so it was being dropped exactly where it
  // was most needed.
  const results = await Promise.all(claims.map(async (c): Promise<NliClaim> => {
    // Exact support first. The xsmall NLI model is unreliable on near-identical
    // text once the premise carries extra sentences: a claim quoted verbatim
    // from a source scored 0.01 entailment against the document containing it.
    // A direct containment check is both cheaper and more trustworthy than
    // asking the model about a case it demonstrably gets wrong.
    const quoted = quotedFrom(c.text, allChunks);
    if (quoted) {
      return {
        claim: c.text, start: c.start, end: c.end, verdict: "entailed",
        entailment: 1, contradiction: 0,
        bestChunkId: quoted.id, bestChunkText: quoted.text,
      };
    }

    // Filtering only makes sense when there is a corpus to filter. With a
    // handful of passages, every one of them is worth asking about, and
    // dropping the only source available would report a contradiction as
    // merely unsupported.
    const filtered = allChunks.length > 4 ? relevantChunks(c.text, allChunks) : allChunks;
    const chunks = filtered.length > 0 ? filtered : allChunks.slice(0, 6);
    if (allChunks.length > 4 && filtered.length === 0) {
      return {
        claim: c.text, start: c.start, end: c.end, verdict: "unsupported",
        entailment: 0, contradiction: 0,
      };
    }

    // Two passes over the chunks, because support and contradiction are not
    // symmetric. A claim needs only one passage to support it, so the best
    // entailment anywhere counts. But contradiction from an unrelated passage
    // is meaningless: a claim about delivery pricing scores high contradiction
    // against a refund policy simply because the two are about different
    // things. So a contradiction only counts when no passage supports the claim
    // well, which is what "the sources say otherwise" actually means.
    let bestEnt = 0, bestContra = 0;
    let bestId: string | undefined, bestText: string | undefined;
    let contraId: string | undefined, contraText: string | undefined;

    const scored = await Promise.all(
      chunks.map(async (chunk) => ({ chunk, e: await entail(chunk.text, c.text) })),
    );
    for (const { chunk, e } of scored) {
      if (e.entailment > bestEnt) {
        bestEnt = e.entailment;
        bestId = chunk.id;
        bestText = chunk.text;
      }
      if (e.contradiction > bestContra) {
        bestContra = e.contradiction;
        contraId = chunk.id;
        contraText = chunk.text;
      }
    }

    // A policy corpus contains documents that are about the same topic but
    // answer different questions: a refund window and a refund processing time
    // both talk about refunds and days, and the model reads one as
    // contradicting the other. So a contradiction has to be clearly stronger
    // than the best support before it wins, rather than merely crossing a
    // threshold. Below that margin the claim is unsupported: worth a hedge,
    // not worth an escalation.
    const CONTRADICTION_MARGIN = 0.25;
    const verdict: ClaimVerdict =
      bestEnt > 0.5 && bestContra - bestEnt < CONTRADICTION_MARGIN ? "entailed"
      : bestContra > 0.5 && bestContra - bestEnt >= CONTRADICTION_MARGIN ? "contradicted"
      : bestEnt > 0.5 ? "entailed"
      : "unsupported";

    // Point the evidence at whichever passage decided it.
    if (verdict === "contradicted") {
      bestId = contraId;
      bestText = contraText;
    }

    return {
      claim: c.text, start: c.start, end: c.end, verdict,
      entailment: bestEnt, contradiction: bestContra,
      bestChunkId: bestId, bestChunkText: bestText,
    };
  }));
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

    // A contradiction is categorically worse than a gap.
    // Contradicted and unsupported are different failures and must not land on
    // the same rung. A contradiction means the sources say otherwise, which is
    // worth holding. Unsupported usually means the knowledge base is silent,
    // and regenerating cannot fix a gap in the knowledge base: a stronger model
    // asked the same unanswerable question will simply invent a better-worded
    // answer. So an unsupported claim is capped below the pause threshold and
    // gets a hedge instead.
    let score: number;
    if (contradicted.length > 0) {
      score = Math.min(1, 0.75 + Math.max(...contradicted.map((c) => c.contradiction)) * 0.25);
    } else if (unsupported.length > 0) {
      score = Math.min(0.5, 0.25 + (unsupported.length / claims.length) * 0.25);
    } else {
      score = 0.05;
    }

    // NOTE: a clean verdict is still a verdict, and it must be reported.
    // returning null here would leave the crude lexical pre-filter as the only
    // grounding signal in the decision, which is how a fully entailed answer
    // ended up escalated to a human in the golden set.

    const evidence: Evidence[] = [
      ...contradicted.slice(0, 3).map((c): Evidence => ({
        kind: "citation",
        text: `CONTRADICTED (${(c.contradiction * 100).toFixed(0)}%): "${trunc(c.claim, 110)}". Sources say: "${trunc(c.bestChunkText ?? "", 110)}"`,
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
      // "unsupported" is weaker: the sources may simply be incomplete. a clean
      // sweep where every claim is entailed is trustworthy too.
      confidence: contradicted.length > 0 ? 0.85 : unsupported.length === 0 ? 0.8 : 0.6,
      evidence,
      latencyMs,
      tier: 1,
    };
  },
};

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
