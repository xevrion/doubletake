import type { Detector, DetectorInput, Finding, Evidence, GroundingSource } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// hallucination detection without a ground-truth oracle.
//
// the round-2 brief makes the honest point that there is often no reliable
// real-time truth to check against. so we don't claim to detect "false" -- we
// detect UNSUPPORTED: claims that the supplied sources do not back up. that is
// a weaker but checkable property, and it maps to what an enterprise actually
// controls (its own knowledge base).
//
// tier 0 does lexical grounding, which is crude but costs ~1ms and catches the
// blatant cases. tier 1 (judge.ts) escalates the ambiguous ones to a model.

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","these","those",
  "is","are","was","were","be","been","being","to","of","in","on","at","for","with",
  "by","from","as","it","its","you","your","we","our","they","their","i","me","my",
  "will","would","can","could","should","may","might","must","have","has","had","do",
  "does","did","not","no","yes","so","up","out","about","into","over","after","also",
  "please","thanks","hello","hi","sure","there","here","what","when","where","which",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
}

function contentTokens(s: string): string[] {
  return tokenize(s).filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

// split into sentences so we can point at the exact unsupported claim rather
// than saying "this answer is 62% grounded", which no reviewer can act on.
export function splitSentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?\n]+[.!?]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].trim();
    if (t.length > 0) out.push({ text: t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// claim-ish sentences are the ones worth checking. a greeting or a hedge is not
// a factual assertion, and flagging it is exactly the over-flagging the brief
// warns produces alert fatigue.
const FACTUAL_MARKERS = /\b(is|are|was|were|has|have|will|must|can|cost|costs|charge|charges|refund|policy|days?|hours?|percent|%|rs\.?|₹|\$|guarantee|entitled|eligible|require[ds]?|allow(?:s|ed)?|within|up to|at least)\b/i;
const NUMERIC = /\d/;

export function isCheckableClaim(sentence: string): boolean {
  const words = tokenize(sentence);
  if (words.length < 4) return false;
  // questions and explicit hedges aren't assertions of fact.
  if (/\?\s*$/.test(sentence)) return false;
  if (/\b(i think|might be|may vary|please (?:check|confirm|contact)|i'?m not sure|cannot confirm)\b/i.test(sentence)) return false;
  return FACTUAL_MARKERS.test(sentence) || NUMERIC.test(sentence);
}

export interface ClaimCheck {
  claim: string;
  start: number;
  end: number;
  support: number;        // 0-1 lexical overlap with the best-matching source
  bestSourceId?: string;
  unsupportedTerms: string[];
}

// how much of this claim's content appears in any single source?
// numbers are weighted heavily: "refunds within 30 days" vs a source that says
// 14 days is precisely the failure mode that cost Air Canada a tribunal ruling.
export function checkClaim(claim: string, sources: GroundingSource[]): ClaimCheck {
  const claimTokens = contentTokens(claim);
  const claimNums = claim.match(/\d+(?:\.\d+)?/g) ?? [];
  let best = 0;
  let bestId: string | undefined;
  let bestMissing: string[] = [];

  for (const src of sources) {
    const srcTokenSet = new Set(contentTokens(src.text));
    const srcNums = new Set(src.text.match(/\d+(?:\.\d+)?/g) ?? []);

    const missing = claimTokens.filter((t) => !srcTokenSet.has(t));
    const lexical = claimTokens.length === 0 ? 0 : 1 - missing.length / claimTokens.length;

    // a number in the claim that appears nowhere in the source is the single
    // strongest signal of fabrication we can get cheaply.
    const missingNums = claimNums.filter((n) => !srcNums.has(n));
    const numericPenalty = claimNums.length === 0 ? 0 : (missingNums.length / claimNums.length) * 0.5;

    const support = Math.max(0, lexical - numericPenalty);
    if (support > best) {
      best = support;
      bestId = src.id;
      bestMissing = [...missing, ...missingNums.map((n) => `#${n}`)];
    }
  }

  return { claim, start: 0, end: 0, support: best, bestSourceId: bestId, unsupportedTerms: bestMissing.slice(0, 6) };
}

export const groundednessDetector: Detector = {
  name: "groundedness:lexical",
  tier: 0,
  categories: ["hallucination"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const sources = input.sources ?? [];

    // no sources supplied means we cannot verify anything. that is a real state
    // and we report it as low-confidence rather than pretending the answer is
    // fine -- the policy layer decides what to do with an unverifiable claim.
    if (sources.length === 0) {
      const claims = splitSentences(input.response).filter((s) => isCheckableClaim(s.text));
      if (claims.length === 0) return null;
      return {
        detector: "groundedness:lexical",
        categories: ["hallucination"],
        score: 0.42,
        severity: severityOf(0.42),
        confidence: 0.25, // low on purpose: this is "unknown", not "wrong"
        evidence: [{
          kind: "note",
          text: `${claims.length} factual claim(s) made with no grounding sources attached; support could not be verified.`,
          value: claims.length,
        }],
        latencyMs: performance.now() - t0,
        tier: 0,
      };
    }

    const sentences = splitSentences(input.response);
    const checks: ClaimCheck[] = [];
    for (const s of sentences) {
      if (!isCheckableClaim(s.text)) continue;
      const c = checkClaim(s.text, sources);
      checks.push({ ...c, start: s.start, end: s.end });
    }
    const latencyMs = performance.now() - t0;
    if (checks.length === 0) return null;

    // score off the worst claim, not the average: one fabricated refund window
    // in an otherwise perfect answer is still a fabricated refund window.
    const worst = checks.reduce((a, b) => (a.support < b.support ? a : b));
    const weak = checks.filter((c) => c.support < 0.55);
    const score = Math.min(1, Math.max(0, 1 - worst.support) * 0.9 + (weak.length > 1 ? 0.1 : 0));

    const evidence: Evidence[] = weak.slice(0, 5).map((c) => ({
      kind: "citation",
      text: `Unsupported: "${truncate(c.claim, 120)}"${c.unsupportedTerms.length ? ` (not in sources: ${c.unsupportedTerms.join(", ")})` : ""}`,
      start: c.start,
      end: c.end,
      sourceId: c.bestSourceId,
      value: Number(c.support.toFixed(2)),
    }));
    if (evidence.length === 0) {
      evidence.push({ kind: "metric", text: `Weakest claim support ${worst.support.toFixed(2)}`, value: worst.support });
    }

    // lexical overlap is a proxy, not proof. mid-range scores are exactly where
    // it's least reliable, so confidence dips there and the judge takes over.
    const confidence = score > 0.75 || score < 0.25 ? 0.7 : 0.4;

    return {
      detector: "groundedness:lexical",
      categories: ["hallucination"],
      score,
      severity: severityOf(score),
      confidence,
      evidence,
      latencyMs,
      tier: 0,
    };
  },
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
