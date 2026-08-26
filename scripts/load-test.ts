// Volume matters for the economics. At fifty interactions every figure rounds
// to noise; the Round 2 brief describes tens of thousands per week, and the
// numbers only become legible at that scale.
//
// Traffic here is generated rather than replayed from a model, because ten
// thousand live calls would take an hour and burn a free tier. The response
// texts are real ones a model produced during probing, recombined with a
// realistic risk mix.

import { warmNli } from "../src/detectors/nli.ts";
import { warmToxicity } from "../src/detectors/toxicity-model.ts";
import { check } from "../src/gateway/pipeline.ts";
import { initAudit, getDb } from "../src/store/audit.ts";
import { initRecall } from "../src/gateway/recall.ts";
import { allDocuments } from "../src/store/knowledge.ts";
import { estimateCost, routeModel, resetBudgets } from "../src/detectors/cost.ts";

const DOCS = allDocuments();

// Traffic is drawn from data/traffic-corpus.json, which carries clean answers,
// hedged answers (a model correctly declining), and responses that are wrong in
// the specific ways that actually occur. Each entry records why it is a problem,
// so a run can report how the gateway did rather than only what it did.
interface Sample {
  prompt: string;
  response: string;
  risky: boolean;
  profile: string;
  capability: number;
  why?: string;
}

interface Corpus {
  clean: Omit<Sample, "risky">[];
  hedged: Omit<Sample, "risky">[];
  risky: Omit<Sample, "risky">[];
}

const corpus = JSON.parse(await Bun.file("data/traffic-corpus.json").text()) as Corpus;
const CLEAN: Sample[] = [...corpus.clean, ...corpus.hedged].map((x) => ({ ...x, risky: false }));
const RISKY: Sample[] = corpus.risky.map((x) => ({ ...x, risky: true }));

// Real traffic is not the same sentence repeated. Light surface variation
// (a greeting, a sign-off, a filler clause) keeps the corpus honest without
// changing what any answer actually claims.
const OPENERS = ["", "Thanks for getting in touch. ", "Happy to help. ", "Sure. ", "Of course. "];
const CLOSERS = ["", " Let me know if that helps.", " Anything else I can do?", " Hope that clears it up."];

function vary(text: string, i: number): string {
  return OPENERS[i % OPENERS.length]! + text + CLOSERS[(i * 7) % CLOSERS.length]!;
}

const RISK_RATE = 0.08;

function pick<T>(xs: T[], i: number): T {
  return xs[i % xs.length]!;
}

async function main() {
  const target = Number(process.argv[2] ?? 2000);
  const fresh = process.argv.includes("--fresh");

  initAudit();
  initRecall();
  if (fresh) {
    getDb().exec("DELETE FROM audit; DELETE FROM corrections;");
    console.log("cleared previous traffic");
  }
  resetBudgets();

  console.log("warming models...");
  await Promise.all([warmNli(), warmToxicity()]);
  console.log(`generating ${target.toLocaleString()} interactions\n`);

  const t0 = performance.now();
  const counts: Record<string, number> = { pass: 0, patch: 0, pause: 0, page: 0 };
  let truePos = 0, falsePos = 0, trueNeg = 0, falseNeg = 0;
  let spend = 0, saved = 0;
  const latencies: number[] = [];

  for (let i = 0; i < target; i++) {
    const risky = (i * 9301 + 49297) % 10000 < RISK_RATE * 10000;
    const base = risky ? pick(RISKY, i) : pick(CLEAN, i);
    const sample: Sample = { ...base, response: vary(base.response, i) };

    // Routing: pick the cheapest model that clears the task, and credit the
    // difference against a frontier baseline.
    const routed = routeModel(sample.capability);
    const promptTokens = 140 + (i % 60);
    const completionTokens = Math.ceil(sample.response.length / 4);
    const costUsd = estimateCost(routed.model, promptTokens, completionTokens);
    const savedUsd = Math.max(0, estimateCost("claude-class-frontier", promptTokens, completionTokens) - costUsd);

    const r = await check({
      prompt: sample.prompt, response: sample.response, profileId: sample.profile,
      sources: DOCS,
      // Roughly six turns per conversation, which is what a support session
      // looks like and gives the loop detector realistic input.
      sessionId: `conv-${Math.floor(i / 6)}`,
      usage: { promptTokens, completionTokens, model: routed.model, costUsd },
      savedUsd,
    });

    counts[r.action] = (counts[r.action] ?? 0) + 1;
    spend += costUsd;
    saved += savedUsd;
    latencies.push(r.timing.totalMs);

    const flagged = r.action !== "pass";
    if (risky && flagged) truePos++;
    else if (!risky && flagged) falsePos++;
    else if (!risky && !flagged) trueNeg++;
    else falseNeg++;

    if ((i + 1) % 500 === 0) {
      const rate = (i + 1) / ((performance.now() - t0) / 1000);
      process.stdout.write(`  ${(i + 1).toLocaleString()} done, ${rate.toFixed(0)}/sec\n`);
    }
  }

  const elapsed = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (q: number) => latencies[Math.floor(latencies.length * q)] ?? 0;

  const precision = truePos + falsePos === 0 ? 0 : truePos / (truePos + falsePos);
  const recall = truePos + falseNeg === 0 ? 0 : truePos / (truePos + falseNeg);
  const fpr = falsePos + trueNeg === 0 ? 0 : falsePos / (falsePos + trueNeg);

  const line = "=".repeat(74);
  console.log(`\n${line}`);
  console.log(`${target.toLocaleString()} interactions in ${elapsed.toFixed(1)}s (${(target / elapsed).toFixed(0)}/sec)`);
  console.log(line);

  console.log(`\nActions`);
  for (const a of ["pass", "patch", "pause", "page"]) {
    const n = counts[a] ?? 0;
    console.log(`  ${a.padEnd(6)} ${String(n).padStart(6)}  ${((n / target) * 100).toFixed(1).padStart(5)}%  ${"#".repeat(Math.round((n / target) * 40))}`);
  }

  console.log(`\nDetection, against a ${(RISK_RATE * 100).toFixed(0)}% planted risk rate`);
  console.log(`  true positives  ${String(truePos).padStart(6)}     false positives ${String(falsePos).padStart(6)}`);
  console.log(`  false negatives ${String(falseNeg).padStart(6)}     true negatives  ${String(trueNeg).padStart(6)}`);
  console.log(`  precision ${precision.toFixed(3)}   recall ${recall.toFixed(3)}   false positive rate ${fpr.toFixed(3)}`);

  console.log(`\nLatency`);
  console.log(`  p50 ${pct(0.5).toFixed(1)}ms   p95 ${pct(0.95).toFixed(1)}ms   p99 ${pct(0.99).toFixed(1)}ms   max ${(latencies.at(-1) ?? 0).toFixed(0)}ms`);

  console.log(`\nEconomics over ${target.toLocaleString()} interactions`);
  console.log(`  model spend        $${spend.toFixed(2)}`);
  console.log(`  routing saved      $${saved.toFixed(2)}`);
  console.log(`  net                $${(saved - spend).toFixed(2)}`);
  console.log(`  cost per 1,000     $${((spend / target) * 1000).toFixed(3)}`);

  // Project to the scale the brief describes, which is where a reader can
  // actually judge whether the numbers matter.
  const perWeek = 40_000;
  const weeks = perWeek / target;
  console.log(`\nProjected to ${perWeek.toLocaleString()} interactions per week`);
  console.log(`  weekly spend       $${(spend * weeks).toFixed(2)}`);
  console.log(`  weekly saved       $${(saved * weeks).toFixed(2)}`);
  console.log(`  annual net         $${((saved - spend) * weeks * 52).toFixed(0)}`);
  console.log(`  held for review    ${Math.round(((counts.pause ?? 0) + (counts.page ?? 0)) / target * perWeek).toLocaleString()} per week`);
  console.log("");
}

main();
