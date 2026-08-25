import type { Detector, DetectorInput, Finding, Evidence } from "../policy/types.ts";
import { severityOf } from "../policy/decide.ts";
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@huggingface/transformers";

// model-based toxicity, as the tier-1 upgrade to the lexicon in toxicity.ts.
//
// the lexicon is precise and instant but only knows the phrasings written into
// it. this catches the paraphrase: "people like you shouldn't be allowed to
// speak" contains no slur and no listed pattern, and a lexicon will never see
// it. running both and taking the higher score is deliberate -- they fail in
// different directions.

env.cacheDir = "./data/models";

const MODEL_ID = "Xenova/toxic-bert";

// toxic-bert is multi-label: each head fires independently, so a message can be
// an insult without being a threat. we keep the per-label scores because
// "which kind of harm" is what a reviewer actually needs to triage.
const LABEL_WEIGHT: Record<string, number> = {
  toxic: 0.7,
  severe_toxic: 1.0,
  obscene: 0.6,
  threat: 1.0,
  insult: 0.75,
  identity_hate: 1.0,
};

type Tox = { tokenizer: any; model: any; labels: Record<string, string> };
let toxPromise: Promise<Tox> | null = null;

export function warmToxicity(): Promise<Tox> {
  if (!toxPromise) {
    toxPromise = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8" });
      return { tokenizer, model, labels: (model as any).config?.id2label ?? {} };
    })();
  }
  return toxPromise;
}

export function isToxicityReady(): boolean {
  return toxPromise !== null;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface ToxScores {
  [label: string]: number;
}

export async function scoreToxicity(text: string): Promise<ToxScores> {
  const { tokenizer, model, labels } = await warmToxicity();
  const inputs = await tokenizer(text, { truncation: true, max_length: 512 });
  const out = await model(inputs);
  const logits = out.logits.tolist()[0] as number[];
  // multi-label, so each logit gets its own sigmoid rather than a shared softmax.
  const scores: ToxScores = {};
  logits.forEach((l, i) => {
    scores[labels[String(i)] ?? `label_${i}`] = sigmoid(l);
  });
  return scores;
}

export const toxicityModelDetector: Detector = {
  name: "safety:model",
  tier: 1,
  categories: ["safety", "bias"],
  async run(input: DetectorInput): Promise<Finding | null> {
    const t0 = performance.now();
    const scores = await scoreToxicity(input.response);
    const latencyMs = performance.now() - t0;

    // weight each head by how serious that category is, then take the worst.
    let score = 0;
    const fired: [string, number][] = [];
    for (const [label, raw] of Object.entries(scores)) {
      if (raw < 0.5) continue;
      fired.push([label, raw]);
      score = Math.max(score, raw * (LABEL_WEIGHT[label] ?? 0.6));
    }
    if (fired.length === 0) return null;

    fired.sort((a, b) => b[1] - a[1]);
    const categories: ("safety" | "bias")[] = fired.some(([l]) => l === "identity_hate")
      ? ["safety", "bias"]
      : ["safety"];

    const evidence: Evidence[] = [
      { kind: "metric", text: `toxic-bert: ${fired.map(([l, v]) => `${l} ${v.toFixed(2)}`).join(", ")}`, value: fired[0]![1] },
    ];

    return {
      detector: "safety:model",
      categories,
      score,
      severity: severityOf(score),
      // a trained classifier on its home task is a solid signal, but it was
      // trained on forum comments and is weaker on enterprise prose.
      confidence: 0.75,
      evidence,
      latencyMs,
      tier: 1,
    };
  },
};
