// Types mirror what the gateway returns. Kept narrow on purpose: the console
// only reads what it displays, so a backend field it ignores cannot break it.

export type Action = "pass" | "patch" | "pause" | "page";

export interface Evidence { kind: string; text: string; value?: number }

export interface Finding {
  detector: string;
  categories: string[];
  score: number;
  severity: string;
  confidence: number;
  evidence: Evidence[];
  latencyMs: number;
  tier: number;
}

export interface CheckResult {
  id: string;
  action: Action;
  finalResponse: string;
  originalResponse: string;
  patched: boolean;
  decision: {
    action: Action;
    rationale: string;
    topCategory: string | null;
    maxScore: number;
    uncertain: boolean;
    uncertaintyReason?: string;
    triggeredBy: { category: string; detector: string; score: number; threshold: number; rule: string }[];
  };
  findings: Finding[];
  profile: { id: string; label: string; latencyBudgetMs: number };
  timing: { totalMs: number; inlineMs: number; withinBudget: boolean; droppedForTime: string[] };
  cost: { requestUsd: number; savedUsd: number };
  generation?: { provider: string; model: string; wallMs: number; degraded: string | null };
}

export interface Profile {
  id: string;
  label: string;
  description: string;
  jurisdiction: string[];
  latencyBudgetMs: number;
  maxInlineTier: number;
  asyncSampleRate: number;
  thresholds: Record<string, { patch: number; pause: number; page: number }>;
  hardBlock: string[];
  onUncertain: Action;
  agentic: boolean;
  retentionDays: number;
}

export interface Overview {
  interactions: number;
  byAction: Record<string, number>;
  byProfile: Record<string, { total: number; flagged: number }>;
  byCategory: Record<string, number>;
  pendingReview: number;
  reviewed: number;
  corrections: number;
  economics: { spendUsd: number; savedUsd: number; netUsd: number; perThousandUsd: number };
  latency: { p50: number; p95: number; p99: number };
  recent: { id: string; ts: number; profileId: string; action: Action; topCategory: string | null; maxScore: number; latencyMs: number; prompt: string; reviewed: boolean }[];
}

export interface QueueItem {
  id: string; ts: number; profileId: string; action: Action;
  topCategory: string | null; maxScore: number; rationale: string;
  promptPreview: string; responsePreview: string;
  override?: { by: string; verdict: string; to: Action; reason: string };
}

export interface Correction {
  auditId: string; issuedAt: number; exposureMs: number;
  reason: string; severity: string; suggestedAction: Action; findings: Finding[];
}

export interface EvalResults {
  generatedAt: string; cases: number;
  precision: number; recall: number; f1: number; fpr: number;
  exactAgreement: number; latencyP50: number; latencyP95: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Sample {
  prompt: string;
  response: string;
  profile: string;
  capability: number;
  kind: "clean" | "hedged" | "risky";
  why?: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface KnowledgeDoc { id: string; title?: string; text: string }

export const api = {
  samples: () => json<{ samples: Sample[] }>("/api/samples").then((d) => d.samples),
  knowledge: () => json<{ company: string; documents: KnowledgeDoc[] }>("/api/knowledge"),
  profiles: () => json<{ profiles: Profile[] }>("/api/profiles").then((d) => d.profiles),
  providers: () => json<{ active: string; all: { id: string; label: string; model: string; ready: boolean; note: string }[] }>("/api/providers"),
  overview: () => json<Overview>("/api/overview"),
  queue: (limit = 25, offset = 0) =>
    json<Paged<QueueItem>>(`/api/queue?limit=${limit}&offset=${offset}`),
  corrections: (limit = 25, offset = 0) =>
    json<Paged<Correction>>(`/api/corrections?limit=${limit}&offset=${offset}`),
  tuning: () => json<{ reviewedCount: number; suggestions: { category: string; reviewed: number; falsePositives: number; falsePositiveRate: number; suggestion: string }[] }>("/api/tuning"),
  evalResults: () => json<EvalResults>("/eval-results.json?t=" + Date.now()),

  check: (body: unknown) =>
    json<CheckResult>("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  ask: (body: unknown) =>
    json<CheckResult>("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  override: (id: string, body: unknown) =>
    json<unknown>(`/api/audit/${id}/override`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
};

export const ACTIONS: Action[] = ["pass", "patch", "pause", "page"];

export const ACTION_COPY: Record<Action, { label: string; hint: string }> = {
  pass:  { label: "Pass",  hint: "ship as written" },
  patch: { label: "Patch", hint: "redact or hedge" },
  pause: { label: "Pause", hint: "regenerate" },
  page:  { label: "Page",  hint: "human review" },
};
