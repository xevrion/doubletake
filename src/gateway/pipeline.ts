import type { Detector, DetectorInput, Finding, TokenUsage } from "../policy/types.ts";
import { decide, type Decision } from "../policy/decide.ts";
import { getProfile, type Profile } from "../policy/profiles.ts";
import { piiDetector, scanPii, redactPii } from "../detectors/pii.ts";
import { groundednessDetector } from "../detectors/groundedness.ts";
import { injectionDetector } from "../detectors/injection.ts";
import { toxicityDetector } from "../detectors/toxicity.ts";
import { makeCostDetector } from "../detectors/cost.ts";
import { writeAudit, sha256, type AuditRecord } from "../store/audit.ts";
import { judgeDetector } from "../detectors/judge.ts";
import { nliDetector, isNliReady } from "../detectors/nli.ts";

// the request path. the whole design goal is that the inline part stays inside
// the profile's latency budget, so:
//   - tier 0 detectors all run CONCURRENTLY, never in sequence
//   - the whole tier-0 batch races a timeout; a slow detector is dropped, not waited on
//   - tier 1 (a judge model) runs inline only if the profile's budget allows it,
//     otherwise it goes async and can recall-and-correct after the fact

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

// run a detector with its own guard rails: it must not throw into the request
// path and it must not hang. a failure becomes a "failed" finding, which the
// policy layer reads as uncertainty and escalates -- never a silent pass.
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

  // tier 0, all at once. the slice each detector gets is the profile budget
  // minus a little headroom for the decision + audit write.
  const slice = Math.max(60, profile.latencyBudgetMs - 40);
  const settled = await Promise.all(TIER0.map((d) => runGuarded(d, input, slice)));
  const findings: Finding[] = settled.filter((f): f is Finding => f !== null);
  const inlineMs = performance.now() - t0;

  const droppedForTime = findings.filter((f) => f.detector.endsWith(":failed")).map((f) => f.detector);

  // tier 1: the judge. it only runs inline when the profile explicitly buys
  // that latency (decision-support, agent-ops). otherwise it is sampled and
  // runs after the response has already gone out.
  let asyncPending = false;
  if (profile.maxInlineTier >= 1) {
    const remaining = profile.latencyBudgetMs - (performance.now() - t0);
    if (remaining > 150) {
      // NLI first: it's local, ~60ms, and gives the three-state verdict. the
      // judge model is the fallback for when no sources were supplied at all,
      // since NLI has nothing to compare against in that case.
      const tier1 = isNliReady() && (req.sources?.length ?? 0) > 0 ? nliDetector : judgeDetector;
      const jf = await runGuarded(tier1, input, remaining);
      if (jf) findings.push(jf);
    } else {
      asyncPending = true;
    }
  } else if (Math.random() < profile.asyncSampleRate) {
    // fire-and-forget: the user already has their answer. if this comes back
    // hot, the recall path (see server.ts) marks the record and can notify.
    asyncPending = true;
  }

  // the lexical grounding check is a sub-millisecond pre-filter, not a verdict.
  // once NLI has actually read the sources, keeping the crude score around would
  // let the weaker signal outvote the stronger one -- which is how g07 (a
  // perfectly grounded loan rationale) ended up escalated to a human.
  const nliRan = findings.some((f) => f.detector === "groundedness:nli");
  const effective = nliRan
    ? findings.filter((f) => f.detector !== "groundedness:lexical")
    : findings;

  const decision = decide(effective, profile);

  // patching: only PII redaction is a safe automatic edit. rewriting a claim
  // would mean the checker is now authoring content, which is a different and
  // much riskier product. everything else gets a disclosure appended.
  //
  // note this runs for any action other than a clean pass: if we're escalating
  // for a fabricated claim, the personal data in the same response still has to
  // come out before anyone sees it. the two risks are independent.
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
  // pause and page never ship the raw text onward; the caller gets a holding
  // message and the original is preserved in the audit record for the reviewer.
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
