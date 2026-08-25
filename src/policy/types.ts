// the vocabulary the whole gateway speaks. keeping this in one place because
// every detector, every policy rule and the audit log all have to agree on
// what a "risk" is -- the round-2 brief points out that bias/hallucination/privacy
// overlap in practice, so a finding carries *all* the categories it triggers
// rather than being forced into one bucket.

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

// every claim the system makes has to be traceable back to something concrete,
// otherwise the audit trail is just vibes.
export interface Evidence {
  kind: "span" | "citation" | "metric" | "note";
  text: string;
  start?: number;               // char offset into the response, for span highlights
  end?: number;
  sourceId?: string;            // which grounding doc, if any
  value?: number;
}

// tier 0 runs inline on everything, tier 1 runs async / sampled, tier 2 is batch.
// this is the latency budget mechanism: a profile picks which tiers it can afford.
export type DetectorTier = 0 | 1 | 2;

export interface Detector {
  name: string;
  tier: DetectorTier;
  categories: RiskCategory[];
  // detectors must never throw into the request path; they return a null finding
  // instead and the gateway records the failure as "unknown", which escalates.
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
