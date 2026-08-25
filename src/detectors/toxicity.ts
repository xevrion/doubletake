import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";

// Tier-0 safety and bias screen. A lexicon cannot measure bias in the sense the
// literature means; it can catch overtly unsafe content and protected-attribute
// reasoning, which is what the regulated-decision profile needs.

const UNSAFE = [
  { label: "self-harm", weight: 0.95, re: /\b(?:how\s+to\s+(?:kill|hurt|harm)\s+(?:yourself|myself)|end\s+your\s+own\s+life|methods?\s+of\s+suicide)\b/i },
  { label: "violence-instruction", weight: 0.9, re: /\b(?:how\s+to\s+(?:make|build|construct)\s+(?:a\s+)?(?:bomb|explosive|weapon)|untraceable\s+poison)\b/i },
  { label: "harassment", weight: 0.75, re: /\b(?:you'?re\s+(?:worthless|pathetic|an?\s+idiot)|nobody\s+(?:likes|wants)\s+you|kill\s+yourself)\b/i },
  { label: "illicit-howto", weight: 0.7, re: /\b(?:how\s+to\s+(?:launder\s+money|evade\s+taxes|hack\s+into|steal\s+(?:credentials|identity)))\b/i },
];

// Grounds drawn from GDPR art.9 special categories and Constitution of India art.15.
const PROTECTED = /\b(?:race|racial|caste|religion|religious|muslim|hindu|christian|sikh|dalit|gender|sex|male|female|women|men|pregnan\w*|disab\w+|age[ds]?|ageing|aging|older|younger|elderly|young|senior\s+citizens?|ethnic\w*|nationality|immigrant|migrant|foreign|sexual\s+orientation|gay|lesbian|transgender|marital\s+status|caste)\b/i;

// A protected attribute only matters here when it sits inside a decision.
const DECISION_CONTEXT = /\b(?:because|since|due\s+to|owing\s+to|given\s+(?:that|their|his|her)|therefore|so\s+(?:we|i|you)\s+should|not\s+(?:eligible|suitable|a\s+good\s+fit)|reject|decline|deny|approve|higher\s+risk|lower\s+risk|less\s+likely|more\s+likely|typically|tend\s+to|usually\s+are)\b/i;

const GENERALISATION = /\b(?:all|most|every|typical(?:ly)?|general(?:ly)?|these\s+people|those\s+people|they\s+(?:all|usually|tend)|are\s+(?:less|more)\b)/i;

// "less adaptable", "more reliable": stereotype shape without a decision verb.
const COMPARATIVE_JUDGEMENT = /\b(?:less|more|worse|better|poorly|highly)\s+(?:adaptable|productive|reliable|competent|capable|suitable|trainable|motivated|committed|aggressive|emotional)\b/i;

export const toxicityDetector: Detector = {
  name: "safety:lexicon",
  tier: 0,
  categories: ["safety", "bias"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const text = input.response;
    const evidence: Evidence[] = [];
    const categories = new Set<"safety" | "bias">();
    let score = 0;

    for (const rule of UNSAFE) {
      const m = rule.re.exec(text);
      if (!m) continue;
      score = Math.max(score, rule.weight);
      categories.add("safety");
      evidence.push({ kind: "span", text: `${rule.label}: "${m[0].slice(0, 80)}"`, start: m.index, end: m.index + m[0].length });
    }

    // Sentence by sentence, so a protected word in one clause cannot taint another.
    for (const sent of text.split(/(?<=[.!?])\s+/)) {
      const prot = PROTECTED.exec(sent);
      if (!prot) continue;
      const inDecision = DECISION_CONTEXT.test(sent);
      const generalises = GENERALISATION.test(sent);
      const judges = COMPARATIVE_JUDGEMENT.test(sent);
      if (!inDecision && !generalises && !judges) continue;

      // Both signals together is a stereotype driving a decision.
      const w = inDecision && (generalises || judges) ? 0.88 : inDecision ? 0.72 : judges ? 0.62 : 0.55;
      score = Math.max(score, w);
      categories.add("bias");
      const idx = text.indexOf(sent);
      evidence.push({
        kind: "span",
        text: `protected-attribute reasoning ("${prot[0]}"): "${sent.trim().slice(0, 110)}"`,
        ...(idx >= 0 ? { start: idx, end: idx + sent.length } : {}),
      });
    }

    const latencyMs = performance.now() - t0;
    if (evidence.length === 0) return null;

    return {
      detector: "safety:lexicon",
      categories: [...categories],
      score,
      severity: severityOf(score),
      // Precise on listed phrasings, blind to everything else.
      confidence: categories.has("bias") && !categories.has("safety") ? 0.45 : 0.7,
      evidence: evidence.slice(0, 6),
      latencyMs,
      tier: 0,
    };
  },
};
