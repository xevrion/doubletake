import type { Action, RiskCategory, DetectorTier } from "./types.ts";

// A profile is the governance object: same gateway, different behaviour per use
// case, geography and risk appetite. Config rather than code, so a risk officer
// can edit thresholds without a deploy.

export interface Threshold {
  // score at or above this -> take the action. checked highest-first.
  patch: number;
  pause: number;
  page: number;
}

export interface Profile {
  id: string;
  label: string;
  description: string;
  jurisdiction: Jurisdiction[];
  // Decides which detectors can run inline.
  latencyBudgetMs: number;
  maxInlineTier: DetectorTier;
  // Sampling rate for the expensive async checks. A high-volume bot cannot afford
  // a judge model on every reply.
  asyncSampleRate: number;
  thresholds: Record<RiskCategory, Threshold>;
  // some categories are non-negotiable regardless of score.
  hardBlock: RiskCategory[];
  // Never silently pass an unknown.
  onUncertain: Action;
  // Agentic profiles are stricter: one bad output becomes several bad actions.
  agentic: boolean;
  retentionDays: number;
}

export type Jurisdiction = "EU" | "IN" | "US" | "UK" | "GLOBAL";

const t = (patch: number, pause: number, page: number): Threshold => ({ patch, pause, page });

// Fills gaps so a new detector category cannot silently break an existing profile.
function withDefaults(partial: Partial<Record<RiskCategory, Threshold>>): Record<RiskCategory, Threshold> {
  const base: Record<RiskCategory, Threshold> = {
    hallucination: t(0.45, 0.7, 0.9),
    privacy: t(0.3, 0.6, 0.85),
    safety: t(0.4, 0.65, 0.85),
    bias: t(0.5, 0.75, 0.92),
    injection: t(0.5, 0.7, 0.88),
    cost: t(0.7, 0.85, 0.97),
  };
  return { ...base, ...partial };
}

export const PROFILES: Record<string, Profile> = {
  "support-bot": {
    id: "support-bot",
    label: "Customer support assistant",
    description:
      "Public-facing chat. Tight latency budget, high volume, and anything it says is legally binding on the company (see Moffatt v. Air Canada, 2024).",
    jurisdiction: ["IN", "EU"],
    latencyBudgetMs: 250,
    maxInlineTier: 0,
    asyncSampleRate: 0.25,
    thresholds: withDefaults({
      // Moffatt v. Air Canada is exactly this failure mode.
      hallucination: t(0.35, 0.6, 0.8),
      privacy: t(0.25, 0.5, 0.75),
    }),
    hardBlock: [],
    onUncertain: "patch",
    agentic: false,
    retentionDays: 180,
  },

  "internal-copilot": {
    id: "internal-copilot",
    label: "Internal knowledge assistant",
    description:
      "Employee-facing. Users are trained and can sanity-check output, so the bar is lower -- but internal data is loosely governed, so leakage still matters.",
    jurisdiction: ["IN"],
    latencyBudgetMs: 400,
    maxInlineTier: 0,
    asyncSampleRate: 0.1,
    thresholds: withDefaults({
      hallucination: t(0.6, 0.8, 0.95),
      privacy: t(0.4, 0.65, 0.88),
      bias: t(0.65, 0.85, 0.96),
    }),
    hardBlock: [],
    onUncertain: "pass",
    agentic: false,
    retentionDays: 90,
  },

  "decision-support": {
    id: "decision-support",
    label: "Regulated decision support",
    description:
      "Output informs a decision about a person (credit, claims, eligibility). EU AI Act high-risk territory: human oversight and record-keeping are obligations, not features.",
    jurisdiction: ["EU", "IN"],
    latencyBudgetMs: 2500,
    maxInlineTier: 1,
    asyncSampleRate: 1.0,
    thresholds: withDefaults({
      hallucination: t(0.2, 0.4, 0.6),
      privacy: t(0.15, 0.35, 0.6),
      bias: t(0.25, 0.45, 0.65),
      safety: t(0.25, 0.45, 0.7),
    }),
    hardBlock: ["bias"],
    onUncertain: "page",
    agentic: false,
    retentionDays: 2555, // ~7 years, EU AI Act art. 12 record-keeping
  },

  "agent-ops": {
    id: "agent-ops",
    label: "Autonomous agent (tool-using)",
    description:
      "The model calls tools and takes actions. Risk compounds across turns, so irreversible actions need a human in the loop regardless of score.",
    jurisdiction: ["GLOBAL"],
    latencyBudgetMs: 1500,
    maxInlineTier: 1,
    asyncSampleRate: 1.0,
    thresholds: withDefaults({
      hallucination: t(0.3, 0.5, 0.7),
      injection: t(0.3, 0.5, 0.7),
      cost: t(0.5, 0.7, 0.85), // runaway loops are a cost incident, not a nuisance
    }),
    hardBlock: ["injection"],
    onUncertain: "pause",
    agentic: true,
    retentionDays: 365,
  },
};

export function getProfile(id: string): Profile {
  const p = PROFILES[id];
  // An unknown profile is a misconfiguration; fail safe rather than loose.
  return p ?? PROFILES["decision-support"]!;
}

export function listProfiles(): Profile[] {
  return Object.values(PROFILES);
}
