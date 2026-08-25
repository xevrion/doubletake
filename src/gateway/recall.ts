import type { CheckRequest } from "./pipeline.ts";
import type { Finding } from "../policy/types.ts";
import { getProfile } from "../policy/profiles.ts";
import { decide } from "../policy/decide.ts";
import { nliDetector } from "../detectors/nli.ts";
import { judgeDetector } from "../detectors/judge.ts";
import { getDb, getAudit } from "../store/audit.ts";

// recall and correct.
//
// a customer-facing bot cannot afford a judge model inline, so the deep check
// has to run after the answer has already gone out. that is not a compromise we
// hide -- it is the honest shape of the problem, and the useful question is
// what you do when a late check comes back hot.
//
// the answer is the same one email clients settled on: you retract it. the
// gateway emits a correction event against the original response id, and the
// host application decides how to surface it (edit the message in place, post a
// follow-up, or open a ticket). we record that the correction was issued and
// how long the bad answer was live, because "12 seconds of exposure" is the
// number a risk officer actually wants.

export interface Correction {
  auditId: string;
  issuedAt: number;
  exposureMs: number;      // how long the unchecked answer was in front of a user
  reason: string;
  severity: string;
  findings: Finding[];
  suggestedAction: "patch" | "pause" | "page";
}

type Listener = (c: Correction) => void;
const listeners = new Set<Listener>();

export function onCorrection(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initRecall(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      audit_id TEXT PRIMARY KEY,
      issued_at INTEGER NOT NULL,
      exposure_ms INTEGER NOT NULL,
      reason TEXT NOT NULL,
      severity TEXT NOT NULL,
      suggested_action TEXT NOT NULL,
      findings TEXT NOT NULL
    );
  `);
}

export function recentCorrections(limit = 25): Correction[] {
  const rows = getDb().query(`SELECT * FROM corrections ORDER BY issued_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => ({
    auditId: r.audit_id, issuedAt: r.issued_at, exposureMs: r.exposure_ms,
    reason: r.reason, severity: r.severity, suggestedAction: r.suggested_action,
    findings: JSON.parse(r.findings),
  }));
}

// run the expensive checks the inline path skipped. called after the response
// has already been returned to the caller, so nothing here is on the hot path.
export async function verifyLate(auditId: string, req: CheckRequest): Promise<Correction | null> {
  const record = getAudit(auditId);
  if (!record) return null;

  const profile = getProfile(req.profileId);
  const input = {
    prompt: req.prompt, response: req.response, sources: req.sources,
    history: req.history, profileId: profile.id, usage: req.usage,
  };

  const detector = (req.sources?.length ?? 0) > 0 ? nliDetector : judgeDetector;
  let finding: Finding | null = null;
  try {
    finding = await detector.run(input);
  } catch {
    return null; // a failed late check is not evidence of a problem
  }
  if (!finding) return null;

  // re-run the policy with the late finding added to what we already knew.
  const combined = [...record.findings, finding];
  const late = decide(combined, profile);

  // only worth a correction if the deeper check changed our mind.
  const RANK = { pass: 0, patch: 1, pause: 2, page: 3 } as const;
  if (RANK[late.action] <= RANK[record.action]) return null;

  const correction: Correction = {
    auditId,
    issuedAt: Date.now(),
    exposureMs: Date.now() - record.ts,
    reason: late.rationale,
    severity: finding.severity,
    findings: [finding],
    suggestedAction: late.action === "pass" ? "patch" : late.action,
  };

  getDb().query(`
    INSERT OR REPLACE INTO corrections (audit_id, issued_at, exposure_ms, reason, severity, suggested_action, findings)
    VALUES (?,?,?,?,?,?,?)
  `).run(correction.auditId, correction.issuedAt, correction.exposureMs, correction.reason,
         correction.severity, correction.suggestedAction, JSON.stringify(correction.findings));

  getDb().query(`UPDATE audit SET final_action = ? WHERE id = ?`).run(correction.suggestedAction, auditId);

  for (const fn of listeners) {
    try { fn(correction); } catch { /* a bad listener must not break the loop */ }
  }
  return correction;
}
