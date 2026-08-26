import type { Action, Finding, RiskCategory } from "../policy/types.ts";
import type { Decision } from "../policy/decide.ts";
import type { Profile } from "../policy/profiles.ts";

// The audit trail. EU AI Act art. 12 wants automatic logs over a system's
// lifetime and art. 14 wants evidence that human oversight was exercised, so
// every record answers on its own: what came in, what the checkers said, what we
// did, who overrode it, and when.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export interface AuditRecord {
  id: string;
  ts: number;
  profileId: string;
  jurisdiction: string;
  model: string;
  // Hash plus a truncated preview. A verbatim log would become the largest
  // personal-data store in the company.
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
  override?: Override;
  retentionUntil: number;
}

export interface Override {
  by: string;
  at: number;
  from: Action;
  to: Action;
  reason: string;
  // The reviewer's label is the only ground truth the system receives.
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

// Aggregates computed in SQL. Loading every row into memory to count it worked
// at fifty interactions and silently under-reported at ten thousand, because
// the dashboard was summing whatever slice it happened to fetch.
export interface AuditStats {
  total: number;
  byAction: Record<string, number>;
  byProfile: Record<string, { total: number; flagged: number }>;
  byCategory: Record<string, number>;
  pendingReview: number;
  reviewed: number;
  uncertain: number;
  spendUsd: number;
  savedUsd: number;
  latency: { p50: number; p95: number; p99: number };
}

function percentile(q: number): number {
  const row = getDb().query(
    `SELECT latency_ms FROM audit ORDER BY latency_ms LIMIT 1 OFFSET
       (SELECT CAST(COUNT(*) * ? AS INTEGER) FROM audit)`,
  ).get(q) as { latency_ms: number } | undefined;
  return row?.latency_ms ?? 0;
}

export function auditStats(): AuditStats {
  const db = getDb();
  const total = (db.query(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;

  const byAction: Record<string, number> = {};
  for (const r of db.query(`SELECT final_action AS a, COUNT(*) AS n FROM audit GROUP BY final_action`).all() as any[]) {
    byAction[r.a] = r.n;
  }

  const byProfile: Record<string, { total: number; flagged: number }> = {};
  for (const r of db.query(`
    SELECT profile_id AS p, COUNT(*) AS total,
           SUM(CASE WHEN final_action != 'pass' THEN 1 ELSE 0 END) AS flagged
    FROM audit GROUP BY profile_id`).all() as any[]) {
    byProfile[r.p] = { total: r.total, flagged: r.flagged ?? 0 };
  }

  const byCategory: Record<string, number> = {};
  for (const r of db.query(`
    SELECT top_category AS c, COUNT(*) AS n FROM audit
    WHERE final_action != 'pass' AND top_category IS NOT NULL
    GROUP BY top_category`).all() as any[]) {
    byCategory[r.c] = r.n;
  }

  const agg = db.query(`
    SELECT
      SUM(cost_usd) AS spend,
      SUM(saved_usd) AS saved,
      SUM(CASE WHEN uncertain = 1 THEN 1 ELSE 0 END) AS uncertain,
      SUM(CASE WHEN override_json IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN final_action IN ('pause','page') AND override_json IS NULL THEN 1 ELSE 0 END) AS pending
    FROM audit`).get() as any;

  return {
    total, byAction, byProfile, byCategory,
    pendingReview: agg.pending ?? 0,
    reviewed: agg.reviewed ?? 0,
    uncertain: agg.uncertain ?? 0,
    spendUsd: agg.spend ?? 0,
    savedUsd: agg.saved ?? 0,
    latency: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  };
}

// Paged queries. A queue holding several hundred items cannot be rendered in
// one list, and fetching them all to slice client-side wastes the work anyway.
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export function pendingReview(limit = 25, offset = 0, profileId?: string): Page<AuditRecord> {
  const db = getDb();
  const where = profileId
    ? `WHERE final_action IN ('pause','page') AND profile_id = ?`
    : `WHERE final_action IN ('pause','page')`;
  const args = profileId ? [profileId] : [];

  const total = (db.query(`SELECT COUNT(*) AS n FROM audit ${where}`).get(...args) as { n: number }).n;
  const rows = db.query(
    `SELECT * FROM audit ${where} ORDER BY override_json IS NOT NULL, ts DESC LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as any[];

  return { items: rows.map(rowToRecord), total, offset, limit };
}

export function auditPage(limit = 50, offset = 0, profileId?: string): Page<AuditRecord> {
  const db = getDb();
  const where = profileId ? `WHERE profile_id = ?` : ``;
  const args = profileId ? [profileId] : [];
  const total = (db.query(`SELECT COUNT(*) AS n FROM audit ${where}`).get(...args) as { n: number }).n;
  const rows = db.query(`SELECT * FROM audit ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as any[];
  return { items: rows.map(rowToRecord), total, offset, limit };
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

// Per-profile retention. "We kept everything" is the wrong answer in an audit.
export function purgeExpired(now = Date.now()): number {
  return getDb().query(`DELETE FROM audit WHERE retention_until < ?`).run(now).changes;
}
