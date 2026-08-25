import type { Action, Finding, RiskCategory, Severity } from "./types.ts";
import type { Profile } from "./profiles.ts";

export interface Decision {
  action: Action;
  // why we did what we did, in the order a human would want to read it.
  rationale: string;
  triggeredBy: TriggeredRule[];
  // the single worst thing we found, for the summary line in the UI.
  topCategory: RiskCategory | null;
  maxScore: number;
  // did we act on incomplete information? this drives the "escalate on unknown"
  // path and gets surfaced to the reviewer rather than hidden.
  uncertain: boolean;
  uncertaintyReason?: string;
}

export interface TriggeredRule {
  category: RiskCategory;
  detector: string;
  score: number;
  threshold: number;
  action: Action;
  rule: string;
}

const ACTION_RANK: Record<Action, number> = { pass: 0, patch: 1, pause: 2, page: 3 };

export function severityOf(score: number): Severity {
  if (score < 0.2) return "none";
  if (score < 0.45) return "low";
  if (score < 0.7) return "medium";
  if (score < 0.88) return "high";
  return "critical";
}

// the core of the whole system: findings + profile -> one action.
// deliberately deterministic and readable. no model decides this; a model that
// grades other models still shouldn't be the one holding the policy.
export function decide(findings: Finding[], profile: Profile): Decision {
  const triggered: TriggeredRule[] = [];
  let action: Action = "pass";
  let maxScore = 0;
  let topCategory: RiskCategory | null = null;

  const escalate = (next: Action) => {
    if (ACTION_RANK[next] > ACTION_RANK[action]) action = next;
  };

  for (const f of findings) {
    for (const category of f.categories) {
      const th = profile.thresholds[category];
      if (!th) continue;

      if (f.score > maxScore) {
        maxScore = f.score;
        topCategory = category;
      }

      // hard blocks ignore the graduated ladder entirely. a profile that lists
      // a category here has decided no score is low enough to let it through.
      if (profile.hardBlock.includes(category) && f.score >= th.patch) {
        triggered.push({
          category, detector: f.detector, score: f.score,
          threshold: th.patch, action: "page",
          rule: `hard-block:${category}`,
        });
        escalate("page");
        continue;
      }

      // graduated ladder, checked most-severe first so the highest rung wins.
      if (f.score >= th.page) {
        triggered.push({ category, detector: f.detector, score: f.score, threshold: th.page, action: "page", rule: `${category}>=page` });
        escalate("page");
      } else if (f.score >= th.pause) {
        triggered.push({ category, detector: f.detector, score: f.score, threshold: th.pause, action: "pause", rule: `${category}>=pause` });
        escalate("pause");
      } else if (f.score >= th.patch) {
        triggered.push({ category, detector: f.detector, score: f.score, threshold: th.patch, action: "patch", rule: `${category}>=patch` });
        escalate("patch");
      }
    }
  }

  // uncertainty handling. the brief calls out that there is often no reliable
  // ground truth, so we treat "the checker isn't sure" as its own signal instead
  // of rounding it down to a pass.
  const lowConfidence = findings.filter((f) => f.confidence < 0.5 && f.score >= 0.3);
  const failed = findings.filter((f) => f.detector.endsWith(":failed"));
  let uncertain = false;
  let uncertaintyReason: string | undefined;

  if (failed.length > 0) {
    uncertain = true;
    uncertaintyReason = `${failed.length} detector(s) failed to complete`;
    escalate(profile.onUncertain);
  } else if (lowConfidence.length > 0) {
    uncertain = true;
    uncertaintyReason = `${lowConfidence.length} detector(s) reported low confidence on a non-trivial score`;
    escalate(profile.onUncertain);
  }

  // agentic profiles: an action the user can't undo deserves a human even when
  // every individual score sits under its threshold. compounding risk, per brief.
  if (profile.agentic && maxScore >= 0.4 && ACTION_RANK[action] < ACTION_RANK["pause"]) {
    triggered.push({
      category: topCategory ?? "hallucination", detector: "policy:agentic-guard",
      score: maxScore, threshold: 0.4, action: "pause",
      rule: "agentic:compounding-risk",
    });
    escalate("pause");
  }

  return {
    action,
    rationale: explain(action, triggered, uncertain, uncertaintyReason),
    triggeredBy: triggered,
    topCategory,
    maxScore,
    uncertain,
    uncertaintyReason,
  };
}

function explain(action: Action, rules: TriggeredRule[], uncertain: boolean, why?: string): string {
  if (action === "pass" && rules.length === 0) {
    return uncertain
      ? `Passed, but flagged as uncertain: ${why}.`
      : "No detector exceeded its threshold for this profile.";
  }
  const top = [...rules].sort((a, b) => b.score - a.score)[0];
  const verb = { pass: "Allowed", patch: "Patched", pause: "Paused for regeneration", page: "Escalated to a human" }[action];
  const base = top
    ? `${verb}: ${top.detector} scored ${top.score.toFixed(2)} on ${top.category}, over the ${top.threshold.toFixed(2)} threshold for this profile.`
    : `${verb}.`;
  return uncertain ? `${base} Additionally flagged uncertain: ${why}.` : base;
}
