import type { Action, Finding, RiskCategory } from "../policy/types.ts";
import type { Decision } from "../policy/decide.ts";
import type { Profile } from "../policy/profiles.ts";

// the audit trail. EU AI Act art. 12 wants automatically generated logs over the
// system's lifetime; art. 14 wants evidence that human oversight was possible and
// exercised. so every record has to answer, on its own: what came in, what the
// checkers said, what we did, who overrode it, and when.
//
// stored in sqlite via bun's built-in driver -- no external db to install, and
// the file is a real artifact a judge can open.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export interface AuditRecord {
  id: string;
  ts: number;
  profileId: string;
  jurisdiction: string;
  model: string;
  // we store a hash of the prompt/response by default and the text only when
  // the profile allows it. the audit log must not become the biggest PII spill
  // in the company.
  promptHash: string;
  responseHash: string;
  promptPreview: string;
  responsePreview: string;
  action: Action;
  finalAction: Action;        // after any human override
  topCategory: RiskCategory | null;
  maxScore: number;
  uncertain: boolean;
  rationale: string;
  findings: Finding[];
  triggeredRules: Decision["triggeredBy"];
  latencyMs: number;
  costUsd: number;
  savedUsd: number;
  // feedback loop: what a human said about our decision, and why.
  override?: Override;
  retentionUntil: number;
}

export interface Override {
  by: string;
  at: number;
  from: Action;
  to: Action;
  reason: string;
  // the label a reviewer gives us is the training signal for threshold tuning.
  verdict: "true-positive" | "false-positive" | "false-negative" | "unclear";
}

let db: Database;

export function initAudit(path = "data/audit.db"): Database {
  mkdirSync("data", { recursive: true });
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      profile_id TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      prompt_preview TEXT NOT NULL,
      response_preview TEXT NOT NULL,
      action TEXT NOT NULL,
      final_action TEXT NOT NULL,
      top_category TEXT,
      max_score REAL NOT NULL,
      uncertain INTEGER NOT NULL,
      rationale TEXT NOT NULL,
      findings TEXT NOT NULL,
      triggered_rules TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      cost_usd REAL NOT NULL,
      saved_usd REAL NOT NULL,
      override_json TEXT,
      retention_until INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit(profile_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action);
  `);
  return db;
}

export function getDb(): Database {
  if (!db) initAudit();
  return db;
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 32);
}

export function writeAudit(r: AuditRecord): void {
  getDb().query(`
    INSERT INTO audit (id, ts, profile_id, jurisdiction, model, prompt_hash, response_hash,
      prompt_preview, response_preview, action, final_action, top_category, max_score,
      uncertain, rationale, findings, triggered_rules, latency_ms, cost_usd, saved_usd,
      override_json, retention_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    r.id, r.ts, r.profileId, r.jurisdiction, r.model, r.promptHash, r.responseHash,
    r.promptPreview, r.responsePreview, r.action, r.finalAction, r.topCategory, r.maxScore,
    r.uncertain ? 1 : 0, r.rationale, JSON.stringify(r.findings), JSON.stringify(r.triggeredRules),
    r.latencyMs, r.costUsd, r.savedUsd, r.override ? JSON.stringify(r.override) : null, r.retentionUntil,
  );
}

export function recordOverride(id: string, o: Override): boolean {
  const res = getDb().query(`UPDATE audit SET override_json = ?, final_action = ? WHERE id = ?`)
    .run(JSON.stringify(o), o.to, id);
  return res.changes > 0;
}

function rowToRecord(row: any): AuditRecord {
  return {
    id: row.id, ts: row.ts, profileId: row.profile_id, jurisdiction: row.jurisdiction,
    model: row.model, promptHash: row.prompt_hash, responseHash: row.response_hash,
    promptPreview: row.prompt_preview, responsePreview: row.response_preview,
    action: row.action, finalAction: row.final_action, topCategory: row.top_category,
    maxScore: row.max_score, uncertain: !!row.uncertain, rationale: row.rationale,
    findings: JSON.parse(row.findings), triggeredRules: JSON.parse(row.triggered_rules),
    latencyMs: row.latency_ms, costUsd: row.cost_usd, savedUsd: row.saved_usd,
    override: row.override_json ? JSON.parse(row.override_json) : undefined,
    retentionUntil: row.retention_until,
  };
}

export function recentAudits(limit = 50, profileId?: string): AuditRecord[] {
  const q = profileId
    ? getDb().query(`SELECT * FROM audit WHERE profile_id = ? ORDER BY ts DESC LIMIT ?`).all(profileId, limit)
    : getDb().query(`SELECT * FROM audit ORDER BY ts DESC LIMIT ?`).all(limit);
  return (q as any[]).map(rowToRecord);
}

export function getAudit(id: string): AuditRecord | null {
  const row = getDb().query(`SELECT * FROM audit WHERE id = ?`).get(id);
  return row ? rowToRecord(row) : null;
}

// retention enforcement, per profile. GDPR/DPDP storage limitation is a real
// obligation and "we kept everything forever" is the wrong answer in an audit.
export function purgeExpired(now = Date.now()): number {
  return getDb().query(`DELETE FROM audit WHERE retention_until < ?`).run(now).changes;
}
