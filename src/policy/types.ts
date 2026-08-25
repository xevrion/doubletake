// Shared vocabulary for detectors, policy and the audit log.
//
// Bias, hallucination and privacy overlap in practice: a fabricated detail about
// a named person is both a hallucination and a privacy problem. So a finding
// carries every category it triggers rather than being forced into one.

export type RiskCategory =
  | "hallucination"
  | "privacy"
  | "safety"
  | "bias"
  | "injection"
  | "cost";

export type Action = "pass" | "patch" | "pause" | "page";

// how bad, on a 0-1 scale, with the band names we show humans.
export type Severity = "none" | "low" | "medium" | "high" | "critical";

// what a single detector reports back.
export interface Finding {
  detector: string;
  categories: RiskCategory[];   // overlapping by design, see note above
  score: number;                // 0-1, higher = more risk
  severity: Severity;
  confidence: number;           // 0-1: how much the detector trusts its own score
  evidence: Evidence[];
  latencyMs: number;
  tier: DetectorTier;
}

// Every claim traces back to something concrete, or the audit trail is worthless.
export interface Evidence {
  kind: "span" | "citation" | "metric" | "note";
  text: string;
  start?: number;               // char offset into the response, for span highlights
  end?: number;
  sourceId?: string;            // which grounding doc, if any
  value?: number;
}

// Tier is a latency contract, not a quality ranking: a profile picks what it can afford.
export type DetectorTier = 0 | 1 | 2;

export interface Detector {
  name: string;
  tier: DetectorTier;
  categories: RiskCategory[];
  run(input: DetectorInput): Promise<Finding | null>;
}

export interface DetectorInput {
  prompt: string;
  response: string;
  sources?: GroundingSource[];  // retrieved docs, when the caller supplies them
  history?: Turn[];             // multi-turn context: risk compounds across turns
  profileId: string;
  usage?: TokenUsage;
}

export interface GroundingSource {
  id: string;
  title?: string;
  text: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  model: string;
  costUsd: number;
}
