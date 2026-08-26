// Reviewer verdicts, so the tuning panel has something to learn from.
//
// Verdicts are assigned by what the record actually contains rather than at
// random: a flag backed by a contradiction is marked correct, a flag on an
// answer whose evidence shows weak lexical support is marked wrong. That gives
// the tuning engine a real signal instead of noise.

import { initAudit, pendingReview, recordOverride } from "../src/store/audit.ts";
import { initRecall, verifyLate } from "../src/gateway/recall.ts";
import { allDocuments } from "../src/store/knowledge.ts";

const REVIEWERS = ["riya@northwind.example", "arjun@northwind.example", "meera@northwind.example"];

function verdictFor(record: Awaited<ReturnType<typeof pendingReview>>["items"][number]) {
  const evidence = record.findings.flatMap((f) => f.evidence.map((e) => e.text)).join(" ");
  const contradicted = /CONTRADICTED/i.test(evidence);
  const pii = record.findings.some((f) => f.detector.startsWith("pii"));
  const injection = record.findings.some((f) => f.detector.startsWith("injection"));
  const bias = record.findings.some((f) => f.categories.includes("bias"));

  // Anything with hard evidence behind it was a good catch.
  if (contradicted || pii || injection || bias) {
    return {
      verdict: "true-positive" as const,
      to: record.finalAction,
      reason: contradicted ? "Confirmed against the policy document."
        : pii ? "Personal data should not have been in a customer reply."
        : injection ? "System prompt leaked, correctly held."
        : "Protected attribute used in an assessment.",
    };
  }

  // A flag with only weak lexical support behind it is the kind reviewers
  // reject, and it is what the threshold tuner needs to see.
  return {
    verdict: "false-positive" as const,
    to: "pass" as const,
    reason: "Answer is consistent with the knowledge base; the wording differs but the substance matches.",
  };
}

async function main() {
  initAudit();
  initRecall();

  const target = Number(process.argv[2] ?? 40);
  const page = pendingReview(target * 2, 0);
  const docs = allDocuments();

  let reviewed = 0, tp = 0, fp = 0, corrections = 0;

  for (const record of page.items) {
    if (record.override) continue;
    if (reviewed >= target) break;

    const { verdict, to, reason } = verdictFor(record);
    recordOverride(record.id, {
      by: REVIEWERS[reviewed % REVIEWERS.length]!,
      at: Date.now(),
      from: record.finalAction,
      to,
      reason,
      verdict,
    });
    reviewed++;
    if (verdict === "true-positive") tp++; else fp++;
  }

  // A few late checks, so the corrections view is not empty either.
  const passed = pendingReview(200, 0).items.filter((r) => r.finalAction === "pass");
  for (const r of passed.slice(0, 6)) {
    const c = await verifyLate(r.id, {
      prompt: r.promptPreview, response: r.responsePreview,
      profileId: r.profileId, sources: docs,
    });
    if (c) corrections++;
  }

  console.log(`reviewed ${reviewed} held responses`);
  console.log(`  ${tp} confirmed as correct catches`);
  console.log(`  ${fp} rejected as false positives`);
  console.log(`  ${corrections} late corrections issued`);
  console.log(`\nthe tuning panel now has verdicts to work from`);
}

main();
