# DoubleTake

A gateway that gives every AI answer a second look before the user acts on it.

Enterprises now run generative AI in production across customer support, internal
copilots and decision-support tools. Each of those can be confidently wrong,
quietly expensive, or subtly irresponsible, and today most teams find out only
after a user has already acted on the answer. DoubleTake sits between the model
and the user, scores every response on all three axes at once, and takes a
graduated action instead of a binary allow-or-block.

Built for the Accenture Innovation Challenge 2026, problem track 1 (ControlPlane.ai).

## The four actions

Every response lands on one rung of a ladder, chosen by severity and reversibility:

| Action | When | What the user gets |
|---|---|---|
| **Pass** | nothing crossed a threshold | the original response |
| **Patch** | recoverable: personal data, an unverified claim | redacted or hedged text |
| **Pause** | wrong enough to be worth another attempt | regeneration on a stronger model |
| **Page** | irreversible or high-stakes | a holding message, and a human is notified |

Blocking is reserved for the last rung, and the reason is arithmetic. Even a
detector with perfect recall produces mostly false alarms once the share of
genuinely risky traffic is small: at a 5% false-positive rate and 1% prevalence,
fewer than one flag in five is real. A system that blocked on all of them would
be routed around within a week. `bun run eval` prints that table, and
[evaluation.md](docs/evaluation.md) works through it.

## What is actually running

No model is trained or fine-tuned here. Everything is inference-only or
deterministic, which is why it runs on a laptop with no GPU.

| Check | How | Tier | Typical |
|---|---|---|---|
| Personal data | regex plus Verhoeff and Luhn checksums, India-aware (Aadhaar, PAN, UPI, IFSC, GSTIN) | 0 | <1 ms |
| Groundedness (fast) | lexical claim-vs-source overlap, used as a pre-filter | 0 | <1 ms |
| Groundedness (real) | NLI entailment, `Xenova/nli-deberta-v3-xsmall` int8, local | 1 | ~20 ms/claim |
| Prompt injection | pattern families, prompt side and response side | 0 | <1 ms |
| Safety and bias | lexicon plus protected-attribute reasoning detection | 0 | <1 ms |
| Cost | token metering, per-key budgets, agent-loop detection | 0 | <1 ms |
| Judge (fallback) | a small model returning a strict JSON verdict | 1 | ~1 s |

The NLI check is the interesting one. It returns three states rather than a
score: a claim is **entailed** by the sources, **contradicted** by them, or
simply **unsupported**. Those are three different problems and they deserve
three different actions, which is exactly what the ladder gives them.

## Layout

```
src/          the gateway: detectors, policy engine, audit store, HTTP API
console/      the React console (Vite, Tailwind, shadcn/ui)
web/          the console's build output, served by the API
scripts/      self check, evaluation harness, traffic seeder
docs/         architecture, evaluation, business proposal, regulatory sources
data/eval/    the labelled golden set
```

## Verifying it

Three commands, no configuration required. The first two are how we check our own
claims, and they are the fastest way for someone else to check them too.

```bash
bun run selfcheck   # 46 assertions: policy, every detector, audit trail, failover
bun run eval        # detection quality against the labelled golden set
bun run seed        # populate the console with a session of realistic traffic
```

`selfcheck` runs in about three seconds once models are cached and exits non-zero
on any failure. It covers the things a reader would otherwise have to take on
trust: that the Verhoeff checksum rejects invalid Aadhaar numbers, that a failed
detector escalates rather than silently passing, that raw identifiers never reach
the audit log, that a held response never ships its original text, and that the
provider failover chain always terminates offline.

## Running it

```bash
bun install
cp .env.example .env      # optional: every default works offline
bun run start             # builds the console, then serves on :3000
```

First start builds the React console and downloads about 200 MB of model
weights, which takes roughly a minute. Both are cached afterwards, so subsequent
starts are immediate.

To work on the console with hot reload, run the API and the Vite dev server
side by side:

```bash
bun run dev           # API on :3000
bun run dev:console   # console on :5173, proxying /api to :3000
```

```bash
bun run eval              # detection quality against the golden set
```

### Models

With no configuration DoubleTake uses a scripted upstream so the demo works with
no network at all. To put a real model behind it, set `UPSTREAM_PROVIDER` in
`.env` to any of `groq`, `gemini`, `cerebras`, `openrouter` or `ollama` and
supply that provider's key. All five have a free tier; Ollama needs no key and
no network. `.env.example` lists the current rate limits for each.

The oversight models are separate from the upstream one by design, so the layer
does not depend on which vendor the enterprise happens to use.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/check` | score a response you already have |
| `POST /api/ask` | generate with the upstream model, then check it |
| `GET /api/profiles` | the policy profiles and their thresholds |
| `GET /api/queue` | responses held for human review |
| `POST /api/audit/:id/override` | record a reviewer verdict |
| `GET /api/tuning` | threshold changes suggested by reviewer feedback |
| `GET /api/economics` | spend, routing savings and latency |
| `GET /api/audit` | the audit trail |

## Policy profiles

The same gateway behaves differently per use case, which is the point. A
customer support bot has 250 ms and cannot afford a judge model inline; a
regulated decision-support tool has 2.5 seconds and hard-blocks any
protected-attribute reasoning. Profiles carry their own thresholds, jurisdiction,
retention period, and what to do when a checker is unsure.

| Profile | Budget | Uncertain → | Notes |
|---|---|---|---|
| `support-bot` | 250 ms | patch | public-facing, high volume |
| `internal-copilot` | 400 ms | pass | staff can sanity-check output |
| `decision-support` | 2500 ms | page | hard-blocks bias, 7-year retention |
| `agent-ops` | 1500 ms | pause | tool-using, risk compounds across turns |

## Audit and feedback

Every decision is written to SQLite with its findings, the rules that fired, the
latency, and the cost. Reviewer overrides are captured as structured verdicts
rather than free text, because those verdicts are the only ground truth the
system ever gets. `/api/tuning` reads them back and proposes threshold changes;
it does not apply them silently.

## Documentation

| Document | Contents |
|---|---|
| [architecture.md](docs/architecture.md) | Request path, detector tiers, why NLI over a judge model, what is not built |
| [evaluation.md](docs/evaluation.md) | Methodology, current results, the base-rate problem, per-detector notes |
| [business-proposal.md](docs/business-proposal.md) | Problem framing, market, business case, roadmap, risks |
| [regulatory.md](docs/regulatory.md) | Every external figure with its source, date and confidence level |
| [demo-script.md](docs/demo-script.md) | Five-minute walkthrough |

## Limitations

Worth stating plainly, since a guardrail that oversells itself is the problem it
claims to solve.

Pattern-based injection detection catches known shapes and misses novel
phrasings; published work shows character-level evasion defeating production
guardrails, so this is defence in depth, not a solved problem. The bias check is
a screen for protected-attribute reasoning in the output, not a measurement of
model bias. NLI grounding can only verify against the sources it is given, so it
detects unsupported claims rather than false ones. The golden set is 15 cases,
which is enough to catch regressions and nowhere near enough to certify
anything.
