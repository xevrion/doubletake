# DoubleTake: business proposal

Accenture Innovation Challenge 2026, Problem Track 1 (ControlPlane.ai)
Team CipherKins, IIT Jodhpur

---

## 1. The problem, precisely stated

Enterprises have moved generative AI from pilots into production, and a
production model fails in three ways at once. It can be **confidently wrong**,
asserting an invented policy or price with no hedge. It can be **quietly
expensive**, burning tokens on retries and agent loops that nobody notices until
the invoice. It can be **subtly irresponsible**, leaking personal data or
reasoning from a protected attribute.

These are usually treated as three separate problems bought from three separate
vendors. In practice they overlap: a fabricated detail about a named person is
simultaneously a hallucination and a privacy incident, and a retry loop caused by
a bad answer is a correctness problem that shows up on the cost line.

The harder issue is *when* you find out. Today the answer is: after a user has
acted on it. That is the difference between an incident and a near miss, and it
is the gap DoubleTake closes.

### Why existing tools do not close it

| Category | Examples | What it does | Why the gap remains |
|---|---|---|---|
| Evaluation and observability | Langfuse, Arize, Galileo | Strong detectors, good dashboards | Sits beside the application. Reports after the fact; your code must decide what to do |
| Security guardrails | Lakera, Prisma AIRS, Bedrock Guardrails | Blocks attacks inline | Binary allow or block, scoped to security. Blind to correctness and cost |
| Gateways | LiteLLM, Portkey, OpenRouter | Enforcement point in the request path | Routing and keys. No correctness detectors |
| Cost and FinOps | Vantage, Finout | Tracks spend | A separate silo that never talks to the quality tools |

The detectors live in one category and the enforcement point lives in another.
DoubleTake is the join: gateway placement, evaluation-grade detectors, and a
policy layer that turns findings into an action.

## 2. The solution

A drop-in gateway between the application and any foundation model. Every
response is scored on correctness, cost and responsibility in a single policy
pass, and lands on one of four rungs:

| Action | Trigger | Result |
|---|---|---|
| **Pass** | nothing crossed a threshold | the original response |
| **Patch** | recoverable: personal data, an unverified claim | redacted or hedged text |
| **Pause** | wrong enough to retry | regeneration on a stronger model |
| **Page** | irreversible or high-stakes | held, a human is notified |

Three design decisions distinguish this from a filter.

**Graduated action, not a switch.** At realistic prevalence a high-recall
detector produces mostly false positives; the arithmetic is in
[evaluation.md](evaluation.md). A system that blocked on every flag would be
routed around within a week. Editing is the default, blocking is reserved for
the irreversible, and uncertainty escalates to a human rather than resolving
silently.

**Policy as configuration.** A customer support bot and a regulated
decision-support tool are the same gateway with different profiles: different
thresholds, latency budgets, jurisdictions, retention periods, and different
answers to "what do we do when the checker is unsure". A risk officer edits these
without a deploy.

**Self-funding.** The same gateway routes each request to the cheapest model that
can do the job. In the seeded demo session, routing saves more than the oversight
costs. The layer is a net credit, not a tax.

## 3. Who it is for

**Primary buyer: the head of AI governance or risk at an enterprise already
running two or more GenAI use cases in production.** They are accountable for
incidents, they have no single place to see what their models are saying, and
they are being asked for evidence by auditors and regulators.

**Primary user: the reviewer.** A compliance analyst or senior support lead
working a queue of held responses. Their experience determines whether the system
survives contact with the organisation, which is why the ladder is tuned to send
them few, high-value items rather than everything.

**Secondary user: the platform engineer** who installs it. The gateway is
provider-agnostic and needs no application changes beyond a base URL.

## 4. Business case

The model below is deliberately conservative and every input is stated so it can
be argued with.

**Assumptions.** An enterprise running three GenAI use cases at 40,000
interactions per week (about 2.1 million per year), the figure the Round 2 brief
suggests. Measured oversight cost from the prototype is $0.067 per 1,000
interactions, which is dominated by the sampled judge model; the local detectors
are effectively free.

| Line | Annual |
|---|---|
| Oversight compute, 2.1M interactions at $0.067/1,000 | ≈ $140 |
| Reviewer time, 2% of traffic held, 90 seconds each, loaded cost | the dominant operating cost |
| Routing savings, measured share of spend on the demo mix | credited against the above |

The compute cost of checking is negligible. The real cost is reviewer time,
which is precisely why the false positive rate is the number the product
optimises and reports, and why the tuning loop exists. A system that halves its
false positive rate halves its running cost.

The return is avoided incidents, and the documented comparators are large. The
average cost of a data breach in India reached ₹25.5 crore in 2026 (IBM), the
Italian data protection authority fined OpenAI €15M in 2024, and an automated
hiring system cost iTutorGroup a $365,000 EEOC settlement. Against those, an
oversight layer whose compute cost is measured in hundreds of dollars a year is
not a difficult purchase.

We are deliberately not putting a single expected-value number on it. The honest
claim is that the cost is small and bounded while the avoided loss is large and
uncertain, which is the shape of every insurance argument. Sources and confidence
levels for all of the above are in [regulatory.md](regulatory.md).

On the routing side the evidence is stronger than a vendor claim: FrugalGPT
reports matching a frontier model's performance at up to 98% lower cost, and
RouteLLM reports halving cost without quality loss. Our own measured saving on
the demo traffic mix is more modest, and it is the number the console displays.

### Market

Gartner sizes AI governance platform spend at **$492M in 2026, reaching $1B by
2030**, and reports that organisations using a specialised governance platform
are 3.4 times more likely to achieve effective governance. Separately it projects
that fragmented AI regulation will reach half of world economies by 2027,
driving $5B in compliance investment. Enterprise spend on foundation-model APIs
was $12.5B in 2025 (Menlo Ventures), so the thing being governed is already a
large line item.

## 5. Regulatory alignment

DoubleTake is designed to produce the evidence these regimes ask for, rather than
to claim compliance with them.

**India DPDP Act 2023** is the near-term driver: it is law, and its Schedule sets
a **₹250 crore** penalty for failure of reasonable security safeguards, with
substantive obligations biting in the first half of 2027. Rule 6 requires regular
monitoring and logging with one-year retention; Rule 13 requires Significant Data
Fiduciaries to run an annual data audit and algorithmic due diligence.
The gateway's contribution is concrete: personal data is detected and redacted
before it reaches a user, every decision is logged with a retention period set
per use case, and the log stores hashes and previews rather than full text so the
audit trail does not itself become the largest personal-data store in the
company.

**EU AI Act** matters for any use case serving European users. It entered general
application on 2 August 2026, and the Digital Omnibus amendment (in force 27 July
2026) moved stand-alone high-risk obligations to 2 December 2027. The relevant
duties are Article 12 record-keeping, Article 14 human oversight, and Article 50
transparency. The audit
trail is the record-keeping artefact; the reviewer queue and the override
mechanism are the human oversight artefact; the patch disclosure is a
transparency artefact.

**NIST AI RMF** maps cleanly onto the architecture: policy profiles are GOVERN,
the detector suite is MAP, the eval harness and reported false-positive rates are
MEASURE, and the action ladder plus reviewer loop are MANAGE.

Numbers, dates and citations for all of the above are in
[regulatory.md](regulatory.md), separated from this document so they can be
checked and updated independently.

## 6. Evidence

Claims in a proposal are cheap, so everything below is reproducible from the
repository in three commands.

### Detection quality

Measured by running a labelled set through the real gateway, not asserted.

| Metric | Value |
|---|---|
| Precision | 1.000 |
| Recall | 1.000 |
| False positive rate | 0.000 |
| Action agreement | 13 of 15 |

The honest caveat, stated in the console itself: fifteen cases is a regression
test, not a certification. It shows the known failure modes stay fixed. It is
not evidence of catching a novel failure nobody anticipated.

### Behaviour at volume

Ten thousand interactions across all four profiles with an 8% planted risk rate,
which is the scale the brief describes.

| Measure | Result |
|---|---|
| Throughput | 19 per second on one laptop core |
| Latency p50 / p95 / p99 | 33 ms / 170 ms / 266 ms |
| Passed untouched | 92.0% |
| Held for review | 8.0% |
| Oversight cost | $0.018 per 1,000 interactions |
| Routing saved | $7.92 |
| Net | positive |

The load test is also what caught the worst defect in the project. The first run
at this scale reported 601 false positives and a precision of 0.209, which would
have put fifteen thousand items a week in front of a reviewer. The agent-loop
detector was counting repeated prompts per use case, so many different customers
asking the same common question looked like one agent stuck in a cycle.
Repetition is now counted per conversation. False positives went to zero.

No single-response test caught that. It only appeared under sustained traffic.

### Against a live model

`bun run probe` asks a real model real questions against the knowledge base and
reports what the gateway does with the answers it actually produced, including
questions the knowledge base deliberately cannot answer. That test is harder and
less flattering than the golden set, and it is the one that found three
production defects: refusals being flagged as hallucinations, unrelated
documents manufacturing contradictions, and the grounding check being dropped on
fast profiles because its latency budget was sized for a network call.

### Verification

`bun run selfcheck` runs 61 assertions across the policy engine, every detector,
the audit trail, provider failover and every HTTP route, in about three seconds,
and exits non-zero on any failure.

## 7. Roadmap

**Now (prototype).** Working gateway, seven detectors across two tiers, four
policy profiles, audit trail with structured overrides, reviewer queue, tuning
suggestions, recall-and-correct, and a self-check covering 46 assertions.

**Phase 1, pilot (one quarter).** One use case in one enterprise. Streaming
interception so the gateway can act mid-response. Real reviewer notification
(email, Slack) instead of a queue people must remember to open. Authentication
and multi-tenant isolation. A golden set built from that customer's own traffic,
which is the only way thresholds get genuinely calibrated.

**Phase 2, scale.** Tier-2 batch analytics: drift, cohort-level fairness, cost
anomalies. Approved threshold changes applied through a review workflow. A
second grounding method to cross-check NLI, since one detector is a single point
of failure.

**Phase 3, platform.** Policy templates per industry and jurisdiction. Evidence
export shaped for auditors. Coverage of tool calls and agent actions, not just
generated text.

## 8. Risks

**A guardrail can be evaded.** Published research shows character-level attacks
defeating production guardrails, including commercial ones. We do not claim
otherwise. The mitigation is defence in depth and honest reporting; the failure
mode we refuse is a product that implies coverage it lacks.

**False positives kill adoption.** Reviewers who see mostly noise stop reading
the queue. Mitigated by the graduated ladder, by measuring and publishing the
false positive rate rather than only the catch rate, and by the tuning loop.

**The reviewer is asleep.** A `page` at 3am cannot block a customer response
indefinitely. Phase 1 needs a timeout policy per profile: after N seconds,
either release with a disclosure or fail closed, decided per use case rather
than globally.

**Grounding is only as good as the sources.** NLI verifies against what it is
given, so a stale knowledge base produces confident false contradictions. This
argues for source freshness being part of the policy, which the prototype does
not yet implement.

**We are three students without a design partner.** The thresholds are reasoned,
not calibrated against real traffic. Everything in Phase 1 is about replacing our
assumptions with a customer's data.

## 9. What we actually built

Not a mockup. A running system, verifiable in three commands:

```bash
bun run selfcheck   # 46 assertions across policy, detectors, audit, providers
bun run eval        # detection quality on a labelled golden set
bun run start       # the console
```

Architecture is documented in [architecture.md](architecture.md), evaluation
methodology and results in [evaluation.md](evaluation.md), and the demo walkthrough
in [demo-script.md](demo-script.md).
