import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// tier-0 PII detection. deliberately rule-based: it's deterministic, it runs in
// under a millisecond, and for structured identifiers a regex plus a checksum
// beats a model. the india-specific rules matter because every off-the-shelf
// PII library we looked at is US/EU-centric and misses aadhaar and PAN entirely.

interface PiiRule {
  label: string;
  pattern: RegExp;
  weight: number;              // how sensitive is this identifier, 0-1
  validate?: (m: string) => boolean;
}

// Verhoeff checksum -- the algorithm UIDAI uses for the 12th aadhaar digit.
// without this, any 12-digit number (an order id, a timestamp) reads as aadhaar
// and the false-positive rate makes the detector useless.
const D_TABLE = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const P_TABLE = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];

export function verhoeffValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length !== 12) return false;
  // aadhaar never starts with 0 or 1, per UIDAI numbering.
  if (digits[0] === "0" || digits[0] === "1") return false;
  let c = 0;
  const reversed = digits.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = D_TABLE[c]![P_TABLE[i % 8]![reversed[i]!]!]!;
  }
  return c === 0;
}

// Luhn, for card numbers. same reasoning as above: cheap and it kills the
// false positives that a bare \d{16} would generate.
export function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES: PiiRule[] = [
  { label: "aadhaar", weight: 1.0, pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, validate: verhoeffValid },
  // PAN: 5 letters, 4 digits, 1 letter. the 4th char encodes holder type.
  { label: "pan", weight: 0.95, pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { label: "credit_card", weight: 1.0, pattern: /\b(?:\d[ -]?){13,19}\b/g, validate: luhnValid },
  { label: "ifsc", weight: 0.6, pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { label: "upi_id", weight: 0.7, pattern: /\b[\w.\-]{3,}@(?:ok(?:hdfcbank|icici|axis|sbi)|paytm|ybl|upi|apl|ibl)\b/gi },
  { label: "email", weight: 0.5, pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g },
  { label: "phone_in", weight: 0.55, pattern: /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g },
  { label: "passport_in", weight: 0.85, pattern: /\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b/g },
  { label: "gstin", weight: 0.5, pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
  { label: "ssn_us", weight: 0.95, pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { label: "iban", weight: 0.7, pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { label: "api_key", weight: 0.9, pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g },
];

export interface PiiHit {
  label: string;
  match: string;
  start: number;
  end: number;
  weight: number;
}

// context suppression. two failure modes the golden set caught:
//   - a 12-digit order number that happens to satisfy Verhoeff reads as aadhaar
//   - a company's own published support address reads as a personal email leak
// both are false positives, and false positives are what get a guardrail
// switched off. the fix is to look at the words around the match.
const ORDER_CONTEXT = /\b(?:order|invoice|txn|transaction|reference|ref|tracking|awb|ticket|booking|receipt|shipment|consignment)\s*(?:no\.?|number|id|#)?\s*[:#-]?\s*$/i;
const PUBLIC_CONTACT = /\b(?:contact|email|reach|write to|call)\s+(?:us|our team|support|sales|helpdesk)\b|\b(?:support|sales|info|help|contact|noreply|no-reply|admin|hello|care)@/i;

const ORDER_TRAILING = /^\s*(?:ships?|shipped|delivered|dispatched|arriv\w+|is\s+(?:on\s+its\s+way|out\s+for\s+delivery|confirmed|pending))\b/i;

function suppressed(text: string, hit: { label: string; start: number; end: number; match: string }): boolean {
  // look at the ~40 characters immediately before the match
  const before = text.slice(Math.max(0, hit.start - 40), hit.start);
  const after = text.slice(hit.end, hit.end + 40);
  // an aadhaar number is never the subject of a shipping sentence. context on
  // either side is enough to tell an identifier from an order reference.
  if (hit.label === "aadhaar" && (ORDER_CONTEXT.test(before) || ORDER_TRAILING.test(after))) return true;
  if (hit.label === "email") {
    const window = text.slice(Math.max(0, hit.start - 40), hit.end + 5);
    if (PUBLIC_CONTACT.test(window)) return true;
  }
  return false;
}

export function scanPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  for (const rule of RULES) {
    // regexes carry lastIndex state across calls when /g is set, so reset first.
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const raw = m[0];
      if (rule.validate && !rule.validate(raw)) continue;
      const hit = { label: rule.label, match: raw, start: m.index, end: m.index + raw.length, weight: rule.weight };
      if (suppressed(text, hit)) continue;
      hits.push(hit);
    }
  }
  // longest match wins when two rules overlap: a 16-digit card shouldn't also
  // be reported as a phone number hiding inside it.
  return dedupeOverlaps(hits);
}

function dedupeOverlaps(hits: PiiHit[]): PiiHit[] {
  const sorted = [...hits].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const kept: PiiHit[] = [];
  for (const h of sorted) {
    if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// redaction keeps the shape of the value so the sentence still reads naturally
// and a human reviewer can see what kind of thing was removed.
export function redactPii(text: string, hits: PiiHit[]): string {
  let out = "";
  let cursor = 0;
  for (const h of hits) {
    out += text.slice(cursor, h.start) + `[${h.label.toUpperCase()}_REDACTED]`;
    cursor = h.end;
  }
  return out + text.slice(cursor);
}

export const piiDetector: Detector = {
  name: "pii:rules",
  tier: 0,
  categories: ["privacy"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const hits = scanPii(input.response);
    const latencyMs = performance.now() - t0;
    if (hits.length === 0) return null;

    // score from the most sensitive identifier, nudged up when several appear:
    // one email is a lapse, an email plus a card number is a breach.
    const top = Math.max(...hits.map((h) => h.weight));
    const score = Math.min(1, top + Math.min(0.15, (hits.length - 1) * 0.05));

    const evidence: Evidence[] = hits.slice(0, 8).map((h) => ({
      kind: "span",
      text: `${h.label}: ${maskForLog(h.match)}`,
      start: h.start,
      end: h.end,
    }));

    return {
      detector: "pii:rules",
      categories: ["privacy"],
      score,
      severity: severityOf(score),
      // deterministic rules with checksums are about as confident as it gets.
      confidence: 0.95,
      evidence,
      latencyMs,
      tier: 0,
    };
  },
};

// never write the raw identifier into the audit log -- the log itself would
// become the leak. keep enough to recognise it, not enough to use it.
function maskForLog(v: string): string {
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(Math.max(3, v.length - 4)) + v.slice(-2);
}
