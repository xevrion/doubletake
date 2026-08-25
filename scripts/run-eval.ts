// the "skeptical stakeholder" harness. the round-2 brief asks how you'd define,
// measure and report false positive/negative rates -- so we measure them on a
// labelled set and print the confusion matrix rather than asserting quality.
//
// the honest framing this produces: at realistic prevalence, a detector with
// great recall still has poor precision. that base-rate problem is exactly why
// the product ladder exists instead of a block/allow switch.

import { warmNli } from "../src/detectors/nli.ts";
import { check } from "../src/gateway/pipeline.ts";
import { initAudit } from "../src/store/audit.ts";
import type { Action } from "../src/policy/types.ts";

interface GoldenCase {
  id: string;
  profileId: string;
  prompt: string;
  response: string;
  sources: { id: string; text: string }[];
  label: "clean" | "hallucination" | "privacy" | "bias" | "injection";
  expectAction: Action;
  note: string;
}

const RANK: Record<Action, number> = { pass: 0, patch: 1, pause: 2, page: 3 };

async function main() {
  initAudit("data/eval.db");
  await warmNli();

  const raw = await Bun.file("data/eval/golden.jsonl").text();
  const cases: GoldenCase[] = raw.trim().split("\n").map((l) => JSON.parse(l));

  let tp = 0, fp = 0, tn = 0, fn = 0;
  let exact = 0;
  const rows: string[] = [];
  const latencies: number[] = [];

  for (const c of cases) {
    const r = await check({ prompt: c.prompt, response: c.response, profileId: c.profileId, sources: c.sources });
    latencies.push(r.timing.totalMs);

    // "flagged" = we did anything other than let it through untouched.
    const flagged = r.action !== "pass";
    const shouldFlag = c.expectAction !== "pass";

    if (flagged && shouldFlag) tp++;
    else if (flagged && !shouldFlag) fp++;
    else if (!flagged && !shouldFlag) tn++;
    else fn++;

    const exactMatch = r.action === c.expectAction;
    if (exactMatch) exact++;

    const mark = flagged === shouldFlag ? (exactMatch ? "ok " : "~  ") : "MISS";
    rows.push(
      `${mark} ${c.id} ${c.label.padEnd(14)} expect=${c.expectAction.padEnd(5)} got=${r.action.padEnd(5)} ` +
      `${r.timing.totalMs.toFixed(0).padStart(4)}ms  ${c.note.slice(0, 52)}`
    );
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log("\nDoubleTake evaluation — golden set\n" + "=".repeat(78));
  for (const r of rows) console.log(r);
  console.log("=".repeat(78));
  console.log(`\nDetection (flag vs no-flag)`);
  console.log(`  TP ${tp}   FP ${fp}   TN ${tn}   FN ${fn}`);
  console.log(`  precision ${precision.toFixed(3)}   recall ${recall.toFixed(3)}   F1 ${f1.toFixed(3)}   FPR ${fpr.toFixed(3)}`);
  console.log(`\nAction agreement (did we pick the RIGHT rung, not just any rung)`);
  console.log(`  exact ${exact}/${cases.length} = ${((exact / cases.length) * 100).toFixed(0)}%`);
  console.log(`\nLatency   p50 ${p50.toFixed(1)}ms   p95 ${p95.toFixed(1)}ms`);

  // the base-rate reality check. a golden set is deliberately balanced; real
  // traffic is not, and quoting precision from a balanced set to a stakeholder
  // would be exactly the kind of overclaiming this product exists to stop.
  console.log(`\nProjected precision at realistic prevalence (same recall/FPR):`);
  for (const prev of [0.10, 0.05, 0.01]) {
    const ppv = (recall * prev) / (recall * prev + fpr * (1 - prev) || 1);
    console.log(`  prevalence ${(prev * 100).toFixed(0).padStart(2)}%  ->  PPV ${(ppv * 100).toFixed(1)}%  ` +
      `(of every 100 flags, ~${Math.round(ppv * 100)} are real)`);
  }
  // write the headline numbers where the dashboard can read them, so the UI can
  // never drift from the last measured run.
  await Bun.write("web/eval-results.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    cases: cases.length,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3)),
    fpr: Number(fpr.toFixed(3)),
    exactAgreement: exact,
    latencyP50: Number(p50.toFixed(1)),
    latencyP95: Number(p95.toFixed(1)),
  }, null, 2) + "\n");

  console.log(`\nThis is the alert-fatigue argument in one table: high recall at low`);
  console.log(`prevalence means most flags are false. That is why DoubleTake patches`);
  console.log(`and hedges by default and reserves blocking for the irreversible cases.\n`);
}

main();
