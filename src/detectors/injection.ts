import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// Prompt injection and instruction leaks. Two different problems: a prompt trying
// to hijack the model, and a response showing signs that one succeeded. The second
// matters more here, because it means something already got through.

interface Pattern {
  label: string;
  re: RegExp;
  weight: number;
  side: "prompt" | "response" | "both";
}

const PATTERNS: Pattern[] = [
  { label: "instruction-override", weight: 0.85, side: "prompt",
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:your\s+|the\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|rules?|prompts?|guidelines?|training)\b/i },
  { label: "role-hijack", weight: 0.8, side: "prompt",
    re: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you|act\s+as\s+(?:if\s+you\s+are\s+)?a?n?\s*(?:unrestricted|unfiltered|jailbroken|DAN|developer\s+mode))\b/i },
  { label: "system-prompt-probe", weight: 0.75, side: "prompt",
    re: /\b(?:(?:what|show|reveal|print|repeat|output)\s+(?:is|are|me)?\s*(?:your\s+)?(?:system\s+prompt|initial\s+instructions?|original\s+prompt|hidden\s+rules?))\b/i },
  { label: "delimiter-injection", weight: 0.6, side: "prompt",
    re: /(?:\[\/?(?:INST|SYS|SYSTEM)\]|<\|(?:im_start|im_end|system|endoftext)\|>|###\s*(?:System|Instruction)\s*:)/i },
  { label: "encoded-payload", weight: 0.55, side: "prompt",
    re: /\b(?:base64|rot13|hex\s*decode)\b[\s\S]{0,40}[A-Za-z0-9+/]{40,}={0,2}/i },

  { label: "system-prompt-leak", weight: 0.9, side: "response",
    re: /\b(?:my\s+system\s+prompt\s+(?:is|says)|i\s+(?:was|am)\s+instructed\s+to|my\s+(?:initial|original)\s+instructions?\s+(?:are|were|say))\b/i },
  { label: "guardrail-bypass-admission", weight: 0.85, side: "response",
    re: /\b(?:as\s+(?:an\s+)?(?:unrestricted|jailbroken|DAN)|ignoring\s+my\s+(?:usual\s+)?(?:guidelines|restrictions|safety))\b/i },
  { label: "credential-echo", weight: 0.8, side: "response",
    re: /\b(?:api[_\s-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i },
];

export const injectionDetector: Detector = {
  name: "injection:patterns",
  tier: 0,
  categories: ["injection", "safety"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const evidence: Evidence[] = [];
    let score = 0;

    // An injection planted three turns ago still shapes this answer.
    const priorUser = (input.history ?? []).filter((t) => t.role === "user").slice(-3).map((t) => t.content).join("\n");
    const promptText = `${priorUser}\n${input.prompt}`;

    for (const p of PATTERNS) {
      const target = p.side === "response" ? input.response : p.side === "prompt" ? promptText : `${promptText}\n${input.response}`;
      const m = p.re.exec(target);
      if (!m) continue;
      const w = p.side === "response" ? p.weight : p.weight * 0.85;
      score = Math.max(score, w);
      evidence.push({
        kind: "span",
        text: `${p.label} (${p.side}): "${m[0].slice(0, 80)}"`,
        ...(p.side === "response" ? { start: m.index, end: m.index + m[0].length } : {}),
      });
    }

    const latencyMs = performance.now() - t0;
    if (evidence.length === 0) return null;

    if (evidence.length > 1) score = Math.min(1, score + 0.08);

    const responseSide = evidence.some((e) => e.text.includes("(response)"));
    return {
      detector: "injection:patterns",
      categories: responseSide ? ["injection", "safety"] : ["injection"],
      score,
      severity: severityOf(score),
      // Known shapes only; novel phrasings slip past. Defence in depth, not a solve.
      confidence: responseSide ? 0.8 : 0.6,
      evidence: evidence.slice(0, 6),
      latencyMs,
      tier: 0,
    };
  },
};
