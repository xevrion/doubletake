# Architecture

## The shape of the problem

An enterprise running generative AI in production has a gap that neither of the
two obvious tool categories fills.

Evaluation and observability platforms have good detectors, but they sit beside
the application: they tell you what happened after the fact, and your own code
has to decide whether to act. LLM gateways sit in the request path and can
enforce a decision, but they carry no correctness detectors, only security
filters. So the detection lives in one place and the enforcement point lives in
another, and nobody joins them.

DoubleTake is that join. It sits where the gateway sits, carries the detectors
the eval platforms carry, and holds a policy layer that turns findings into one
of four actions.

## Request path

```
                       ┌──────────────────────────────────────────┐
   user prompt  ─────► │            application                   │
                       └────────────────────┬─────────────────────┘
                                            │
                       ┌────────────────────▼─────────────────────┐
                       │        DoubleTake gateway                │
                       │                                          │
                       │  1. call upstream model (any provider)   │
                       │  2. tier 0 detectors, all in parallel    │
                       │  3. tier 1 if the profile can afford it  │
                       │  4. policy decides: pass/patch/pause/page│
                       │  5. write audit record                   │
                       │  6. queue a late check if sampled        │
                       └────────────────────┬─────────────────────┘
                                            │
   response     ◄───────────────────────────┘
                       (original, patched, or a holding message)
```

Steps 2 and 3 are where the latency budget is spent, and the ordering is
deliberate. Every tier-0 detector runs concurrently against a shared deadline
derived from the profile, so the inline cost is the slowest single detector
rather than their sum. A detector that exceeds its slice is dropped and recorded
as a failure, which the policy layer reads as uncertainty.

## Detector tiers

Tiers are a latency contract, not a quality ranking.

**Tier 0** runs on every request, inline, in under a millisecond each. These are
deterministic: regex with checksums for personal data, pattern families for
prompt injection, a lexicon for overt safety problems, arithmetic for cost. They
are cheap enough that no profile has to opt out of them.

**Tier 1** runs when the profile's budget allows, or asynchronously when it does
not. These are model-based: NLI entailment for grounding, a transformer
classifier for toxicity, and a judge model when no grounding sources exist. They
cost tens of milliseconds locally, or a network round trip for the judge.

**Tier 2** is batch work: drift, cohort-level fairness, cost anomalies. The
design accommodates it; the prototype does not implement it.

## Why NLI rather than an LLM judge

The grounding check uses `Xenova/nli-deberta-v3-xsmall` locally rather than
asking a large model whether an answer is true. Three reasons.

It returns three states rather than a score. A claim is entailed by the sources,
contradicted by them, or unsupported. Those are different problems: a
contradiction means the model asserted something the knowledge base denies,
while unsupported often means the knowledge base is simply incomplete. They
deserve different actions, and a single "hallucination: 0.7" throws that away.

It is honest about what it can know. NLI verifies against supplied sources, so
what it detects is unsupported claims, not false ones. There is often no
real-time ground truth to check against, and a system that claimed otherwise
would be overselling in exactly the way this product exists to catch.

It costs nothing per call and runs offline. An oversight layer that costs as
much as the model it oversees has no business case.

The judge model is still there, as the fallback for requests that arrive with no
grounding sources at all. It returns strict JSON, never prose, because a
free-text opinion cannot be thresholded or audited.

## Policy profiles

A profile is the governance object. It carries thresholds per risk category, a
latency budget, the jurisdictions it operates under, a retention period, and
what to do when a checker is unsure. Profiles are configuration: in a real
deployment a risk officer edits them without a redeploy.

The four in the prototype span the range the brief describes.

| Profile | Budget | Inline tier | If unsure | Hard block | Retention |
|---|---|---|---|---|---|
| `support-bot` | 250 ms | 0 | patch | none | 180 d |
| `internal-copilot` | 400 ms | 0 | pass | none | 90 d |
| `decision-support` | 2500 ms | 1 | page | bias | 2555 d |
| `agent-ops` | 1500 ms | 1 | pause | injection | 365 d |

The `decision-support` retention is seven years because that is the horizon EU
AI Act record-keeping implies for a high-risk system. The `agent-ops` profile
sets `agentic: true`, which adds a rule: when the model can take actions, a
moderate score escalates to `pause` even if no individual threshold was crossed,
because one bad output becomes several bad actions.

## The decision function

`decide(findings, profile)` is deterministic and about a hundred lines. No model
participates in it. A system that grades other models should not hand the policy
itself to a model.

It walks each finding against the profile's thresholds, escalating monotonically:
the highest rung any rule reaches wins. Hard-blocked categories bypass the ladder
entirely. Then two uncertainty rules fire:

- if any detector failed or timed out, escalate to the profile's `onUncertain`
- if a detector reported low confidence on a non-trivial score, do the same

The second rule is the important one. An unsure checker escalates rather than
passing, so the failure mode is a reviewer's time rather than a user acting on a
bad answer.

## Patching

Only two edits are safe to make automatically.

Personal data is redacted in place, preserving the sentence so it still reads.
This happens on any action other than a clean pass, because if we are escalating
for a fabricated claim, the personal data in the same response still has to come
out before anyone sees it.

An unverified claim gets a disclosure appended. The checker does not rewrite the
claim, because a layer that authors replacement content is a different and much
riskier product than one that annotates.

`pause` and `page` never ship the original text. The caller receives a holding
message and the original is preserved in the audit record for the reviewer.

## Recall and correct

A customer-facing profile cannot afford a judge model inline, so its deep check
runs after the answer has already gone out. When that late check disagrees with
the inline decision, the gateway emits a correction against the original
response id and records how long the unchecked answer was live.

The host application decides how to surface it: edit the message in place, post
a follow-up, or open a ticket. The exposure window is recorded because "the
wrong answer was visible for 12 seconds" is the number a risk officer asks for.

## Audit trail

Every decision is written to SQLite with its findings, the rules that fired,
latency, and cost. Prompts and responses are stored as a hash plus a truncated
preview, because an audit log that captured everything verbatim would become the
largest personal-data store in the company.

Reviewer overrides are captured as structured verdicts (true positive, false
positive, false negative, unclear) rather than free text, because those verdicts
are the only ground truth the system ever receives. `/api/tuning` reads them back
and proposes threshold changes. It does not apply them: a guardrail that retunes
itself without a human in the loop is a new risk, not a feature.

## What is not built

Stated plainly, because the gap between a prototype and a product is where
proposals usually mislead.

Tier 2 batch analytics, streaming response interception (the prototype checks
complete responses), a real reviewer notification path beyond the queue,
multi-tenant isolation, and any form of authentication. The tuning engine
proposes threshold changes but does not apply them. The golden set is 15 cases,
enough to catch regressions and nowhere near enough to certify anything.
