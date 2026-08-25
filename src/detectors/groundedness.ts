import type { Detector, DetectorInput, Finding, Evidence, GroundingSource } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// Grounding without a ground-truth oracle. There is rarely a reliable real-time
// source of truth, so this detects UNSUPPORTED rather than false: claims the
// supplied sources do not back. Weaker, but checkable, and it maps to what an
// enterprise actually controls. This tier is the cheap pre-filter; nli.ts is the
// real check.

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","these","those",
  "is","are","was","were","be","been","being","to","of","in","on","at","for","with",
  "by","from","as","it","its","you","your","we","our","they","their","i","me","my",
  "will","would","can","could","should","may","might","must","have","has","had","do",
  "does","did","not","no","yes","so","up","out","about","into","over","after","also",
  "please","thanks","hello","hi","sure","there","here","what","when","where","which",
]);

// Models emit typographic punctuation freely: non-breaking hyphens, smart
// quotes, en dashes. Left alone, "non\u2011refundable" tokenises as two unknown
// words and a correct answer reads as unsupported, so everything is folded to
// ASCII equivalents before comparison.
export function normalise(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212]/g, "-")   // hyphens, dashes, minus
    .replace(/[\u2018\u2019\u201B\u02BC]/g, "'") // single quotes
    .replace(/[\u201C\u201D\u201F]/g, '"')     // double quotes
    .replace(/[\u00A0\u2007\u202F\u2009]/g, " "); // non-breaking and thin spaces
}

function tokenize(s: string): string[] {
  return normalise(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
}

function contentTokens(s: string): string[] {
  return tokenize(s).filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

// Sentence granularity so evidence can quote the exact claim. "62% grounded" is
// not something a reviewer can act on.
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

// A greeting or a hedge is not a factual assertion, and flagging one is how a
// queue fills with noise.
const FACTUAL_MARKERS = /\b(is|are|was|were|has|have|will|must|can|cost|costs|charge|charges|refund|policy|days?|hours?|percent|%|rs\.?|₹|\$|guarantee|entitled|eligible|require[ds]?|allow(?:s|ed)?|within|up to|at least)\b/i;
const NUMERIC = /\d/;

// identifiers echoed back to the user (order numbers, ticket ids, tracking
// codes) are not claims about the world -- they came FROM the user or the
// system, so there is nothing to verify against a knowledge base. treating them
// as unverified facts is how a routine "your order ships tomorrow" got escalated
// to a human in the golden set.
const IDENTIFIER_ECHO = /\b(?:order|invoice|txn|transaction|reference|ref|tracking|awb|ticket|booking|receipt|case|shipment|policy)\s*(?:no\.?|number|id|#)?\s*[:#-]?\s*[A-Z0-9-]{5,}/i;

// a refusal is the model working correctly, not making a claim. flagging
// "I can't share that" as an unverified assertion punishes exactly the
// behaviour we want, and it fires constantly against well-aligned models.
const REFUSAL = /\b(?:i(?:'m| am)?\s*(?:sorry|afraid)|i\s*(?:can(?:'|no)?t|cannot|won'?t|am\s+unable\s+to|don'?t\s+have\s+(?:access|that))|unable\s+to\s+(?:provide|share|assist)|not\s+able\s+to\s+(?:provide|share)|i\s+do\s+not\s+have\s+(?:access|information))\b/i;

export function isRefusal(text: string): boolean {
  return REFUSAL.test(text);
}

export function isCheckableClaim(sentence: string): boolean {
  const words = tokenize(sentence);
  if (words.length < 4) return false;
  // questions and explicit hedges aren't assertions of fact.
  if (/\?\s*$/.test(sentence)) return false;
  if (/\b(i think|might be|may vary|please (?:check|confirm|contact)|i'?m not sure|cannot confirm)\b/i.test(sentence)) return false;
  if (REFUSAL.test(sentence)) return false;

  // strip identifiers before deciding whether any real numeric claim remains.
  const withoutIds = sentence.replace(IDENTIFIER_ECHO, " ");
  if (!FACTUAL_MARKERS.test(withoutIds) && !NUMERIC.test(withoutIds)) return false;

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

// Numbers are weighted heavily: a figure the sources never mention is the
// strongest cheap signal of fabrication available.
export function checkClaim(claim: string, sources: GroundingSource[]): ClaimCheck {
  const claimTokens = contentTokens(claim);
  const claimNums = normalise(claim).match(/\d+(?:\.\d+)?/g) ?? [];
  let best = 0;
  let bestId: string | undefined;
  let bestMissing: string[] = [];

  for (const src of sources) {
    const srcTokenSet = new Set(contentTokens(src.text));
    const srcNums = new Set(normalise(src.text).match(/\d+(?:\.\d+)?/g) ?? []);

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

    // Unverifiable is a real state, reported at low confidence rather than as a
    // pass. The policy layer decides what an unverifiable claim is worth.
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

    // Worst claim, not the average: one fabricated figure still misleads.
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

    // Least reliable in the mid range, so confidence dips there and tier 1 takes over.
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
