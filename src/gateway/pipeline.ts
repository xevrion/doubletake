import type { Detector, DetectorInput, Finding, TokenUsage } from "../policy/types.ts";
import { decide, type Decision } from "../policy/decide.ts";
import { getProfile, type Profile } from "../policy/profiles.ts";
import { piiDetector, scanPii, redactPii } from "../detectors/pii.ts";
import { groundednessDetector, isRefusal } from "../detectors/groundedness.ts";
import { injectionDetector } from "../detectors/injection.ts";
import { toxicityDetector } from "../detectors/toxicity.ts";
import { makeCostDetector } from "../detectors/cost.ts";
import { writeAudit, sha256, type AuditRecord } from "../store/audit.ts";
import { verifyLate } from "./recall.ts";
import { judgeDetector } from "../detectors/judge.ts";
import { nliDetector, isNliReady } from "../detectors/nli.ts";
import { toxicityModelDetector, isToxicityReady } from "../detectors/toxicity-model.ts";

// The request path. Tier-0 detectors run concurrently against a shared deadline,
// so inline cost is the slowest detector rather than their sum. Tier 1 runs
// inline only when the profile's budget allows, otherwise it goes async.

const TIER0: Detector[] = [piiDetector, groundednessDetector, injectionDetector, toxicityDetector, makeCostDetector()];

export interface CheckRequest {
  prompt: string;
  response: string;
  profileId: string;
  sources?: { id: string; title?: string; text: string }[];
  history?: { role: "user" | "assistant"; content: string }[];
  usage?: TokenUsage;
  savedUsd?: number;
}

export interface CheckResult {
  id: string;
  action: Decision["action"];
  finalResponse: string;      // patched if we patched it, original otherwise
  originalResponse: string;
  patched: boolean;
  decision: Decision;
  findings: Finding[];
  profile: { id: string; label: string; latencyBudgetMs: number };
  timing: {
    totalMs: number;
    inlineMs: number;
    detectors: { name: string; ms: number; tier: number }[];
    withinBudget: boolean;
    droppedForTime: string[];
  };
  cost: { requestUsd: number; savedUsd: number };
  asyncPending: boolean;
}

// A detector must never throw into the request path or hang. Failures become a
// "failed" finding, which the policy layer reads as uncertainty and escalates.
async function runGuarded(d: Detector, input: DetectorInput, timeoutMs: number): Promise<Finding | null> {
  const started = performance.now();
  try {
    const result = await Promise.race([
      d.run(input),
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), timeoutMs)),
    ]);
    if (result === "timeout") {
      return {
        detector: `${d.name}:failed`, categories: d.categories, score: 0.5,
        severity: "medium", confidence: 0, tier: d.tier,
        evidence: [{ kind: "note", text: `Detector exceeded its ${timeoutMs}ms slice and was dropped.` }],
        latencyMs: performance.now() - started,
      };
    }
    return result;
  } catch (err) {
    return {
      detector: `${d.name}:failed`, categories: d.categories, score: 0.5,
      severity: "medium", confidence: 0, tier: d.tier,
      evidence: [{ kind: "note", text: `Detector error: ${err instanceof Error ? err.message : String(err)}` }],
      latencyMs: performance.now() - started,
    };
  }
}

export async function check(req: CheckRequest): Promise<CheckResult> {
  const t0 = performance.now();
  const profile = getProfile(req.profileId);
  const input: DetectorInput = {
    prompt: req.prompt, response: req.response, sources: req.sources,
    history: req.history, profileId: profile.id, usage: req.usage,
  };

  // Nothing to verify in "I can't help with that", and escalating a model for
  // declining trains operators to ignore the queue.
  const refusal = isRefusal(req.response) && req.response.length < 300;

  // Slice leaves headroom for the decision and the audit write.
  const slice = Math.max(60, profile.latencyBudgetMs - 40);
  const active = refusal
    ? TIER0.filter((d) => !d.categories.includes("hallucination"))
    : TIER0;
  const settled = await Promise.all(active.map((d) => runGuarded(d, input, slice)));
  const findings: Finding[] = settled.filter((f): f is Finding => f !== null);
  const inlineMs = performance.now() - t0;

  const droppedForTime = findings.filter((f) => f.detector.endsWith(":failed")).map((f) => f.detector);

  // Tier 1 runs inline only where the profile buys the latency; otherwise sampled.
  let asyncPending = false;
  let sampledForAsync = false;
  if (profile.maxInlineTier >= 1 && !refusal) {
    const remaining = profile.latencyBudgetMs - (performance.now() - t0);
    if (remaining > 150) {
      // NLI first: it's local, ~60ms, and gives the three-state verdict. the
      // judge model is the fallback for when no sources were supplied at all,
      // since NLI has nothing to compare against in that case.
      // NLI whenever sources exist: local, three-state, and free. The judge is
      // only for requests that arrive with nothing to check against.
      const hasSources = (req.sources?.length ?? 0) > 0;
      const tier1 = hasSources ? nliDetector : judgeDetector;

      // Runs alongside grounding rather than after it; they check different things.
      const [grounding, toxModel] = await Promise.all([
        runGuarded(tier1, input, remaining),
        isToxicityReady() ? runGuarded(toxicityModelDetector, input, remaining) : Promise.resolve(null),
      ]);
      if (grounding) findings.push(grounding);
      if (toxModel) findings.push(toxModel);
    } else {
      asyncPending = true;
    }
  } else if (Math.random() < profile.asyncSampleRate) {
    sampledForAsync = true;
    // fire-and-forget: the user already has their answer. if this comes back
    // hot, the recall path (see server.ts) marks the record and can notify.
    asyncPending = true;
  }

  // The lexical check is a pre-filter, not a verdict. Once NLI has read the
  // sources, keeping the crude score would let the weaker signal outvote it.
  const nliRan = findings.some((f) => f.detector === "groundedness:nli");
  const effective = nliRan
    ? findings.filter((f) => f.detector !== "groundedness:lexical")
    : findings;

  const decision = decide(effective, profile);

  // Redaction is the only safe automatic edit; rewriting a claim would make the
  // checker an author. Runs on any non-pass action because the two risks are
  // independent: an escalated response still has to have its PII removed.
  let finalResponse = req.response;
  let patched = false;
  if (decision.action !== "pass") {
    const hits = scanPii(req.response);
    if (hits.length > 0) {
      finalResponse = redactPii(req.response, hits);
      patched = true;
    }
  }
  if (decision.action === "patch") {
    const hallucinationHit = decision.triggeredBy.some((r) => r.category === "hallucination");
    if (hallucinationHit) {
      finalResponse += "\n\n_[DoubleTake: parts of this answer could not be verified against our sources. Please confirm before acting on it.]_";
      patched = true;
    }
  }
  // Neither ships the raw text; the original stays in the audit record.
  if (decision.action === "pause") {
    finalResponse = "_[DoubleTake paused this response for regeneration on a stronger model. Original retained in audit record " + "]_";
  } else if (decision.action === "page") {
    finalResponse = "_[DoubleTake held this response for human review. A reviewer has been notified; the original is in the audit record.]_";
  }

  const totalMs = performance.now() - t0;
  const id = crypto.randomUUID();

  const record: AuditRecord = {
    id, ts: Date.now(), profileId: profile.id, jurisdiction: profile.jurisdiction.join(","),
    model: req.usage?.model ?? "unknown",
    promptHash: sha256(req.prompt), responseHash: sha256(req.response),
    promptPreview: req.prompt.slice(0, 240), responsePreview: req.response.slice(0, 240),
    action: decision.action, finalAction: decision.action,
    topCategory: decision.topCategory, maxScore: decision.maxScore,
    uncertain: decision.uncertain, rationale: decision.rationale,
    findings: effective, triggeredRules: decision.triggeredBy,
    latencyMs: totalMs, costUsd: req.usage?.costUsd ?? 0, savedUsd: req.savedUsd ?? 0,
    retentionUntil: Date.now() + profile.retentionDays * 86400_000,
  };
  writeAudit(record);

  // The caller already has its answer; a worse late verdict emits a correction.
  if (sampledForAsync) {
    queueMicrotask(() => {
      verifyLate(id, req).catch(() => { /* late checks are best effort */ });
    });
  }

  return {
    id,
    action: decision.action,
    finalResponse,
    originalResponse: req.response,
    patched,
    decision,
    findings: effective,
    profile: { id: profile.id, label: profile.label, latencyBudgetMs: profile.latencyBudgetMs },
    timing: {
      totalMs: Number(totalMs.toFixed(2)),
      inlineMs: Number(inlineMs.toFixed(2)),
      detectors: findings.map((f) => ({ name: f.detector, ms: Number(f.latencyMs.toFixed(2)), tier: f.tier })),
      withinBudget: totalMs <= profile.latencyBudgetMs,
      droppedForTime,
    },
    cost: { requestUsd: req.usage?.costUsd ?? 0, savedUsd: req.savedUsd ?? 0 },
    asyncPending,
  };
}
