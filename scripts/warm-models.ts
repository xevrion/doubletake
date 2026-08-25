// pre-download and warm every model at boot. the research measured 6-8s cold
// load per model: that has to happen at startup, never on a user's request.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@huggingface/transformers";

env.cacheDir = "./data/models";

const MODELS = [
  { id: "Xenova/nli-deberta-v3-xsmall", label: "NLI groundedness" },
  { id: "Xenova/toxic-bert", label: "toxicity" },
];

for (const m of MODELS) {
  const t0 = performance.now();
  process.stdout.write(`loading ${m.label} (${m.id})... `);
  try {
    const tok = await AutoTokenizer.from_pretrained(m.id);
    const model = await AutoModelForSequenceClassification.from_pretrained(m.id, { dtype: "q8" });
    console.log(`ok in ${((performance.now() - t0) / 1000).toFixed(1)}s | labels:`, JSON.stringify((model as any).config?.id2label ?? {}));
  } catch (e) {
    console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
