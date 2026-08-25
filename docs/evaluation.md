# Evaluation

## What we measure and why

A guardrail that reports only its catches is marking its own homework. The
harder and more useful number is how often it flags something that turned out to
be fine, because that is what determines whether anyone keeps it switched on.

`bun run eval` runs every case in `data/eval/golden.jsonl` through the real
gateway and prints a confusion matrix, per-case results, and the projection
below.

## Current results

Fifteen labelled cases spanning all four profiles and all five risk categories.

| Metric | Value |
|---|---|
| Precision | 1.000 |
| Recall | 1.000 |
| F1 | 1.000 |
| False positive rate | 0.000 |
| Exact action agreement | 11/15 |
| Latency p50 | 0.7 ms |
| Latency p95 | 565 ms |

Two honest caveats about that table.

Fifteen cases is a regression test, not a certification. Perfect scores here
mean the known failure modes stay fixed, and nothing more. A real deployment
would need a golden set two orders of magnitude larger, refreshed from
production traffic, and red-teamed by someone trying to break it.

Exact action agreement is 11/15 rather than 15/15. The four gaps are cases where
the gateway flags correctly but picks an adjacent rung: it pauses where we
expected a page, or pages where we expected a pause. That is a materially smaller
problem than missing the case, and we report it separately rather than folding
it into the headline number.

## The base rate problem

Precision measured on a balanced test set is not the precision an operator sees.
A golden set is roughly half risky by construction; live traffic is not.

With recall `r`, false positive rate `f`, and a prevalence `p` of genuinely
risky responses, the share of flags that are real is:

```
PPV = (r · p) / (r · p + f · (1 − p))
```

At the measured recall, assuming a deliberately pessimistic 5% false positive
rate rather than the 0% the small golden set shows:

| Risky share of traffic | Precision | What a reviewer experiences |
|---|---|---|
| 10% | 69% | roughly 7 in 10 flags are real |
| 5% | 51% | about half are real |
| 1% | 17% | more than 8 in 10 are noise |

This is the entire argument for the graduated ladder. A system that blocked on
every flag would, at realistic prevalence, block mostly correct answers, and it
would be turned off or routed around within a week. So blocking is reserved for
the irreversible cases, editing is the default, and the uncertain cases go to a
human rather than being resolved silently in either direction.

The same arithmetic is why the tuning engine exists. Reviewer verdicts are the
only signal that tells us where the thresholds actually sit relative to the
traffic a given deployment sees.

## How thresholds would be tuned in production

The prototype records every override with a structured verdict and surfaces a
suggestion at `/api/tuning`. The intended loop:

1. Collect reviewer verdicts on flagged cases for a fixed window.
2. For each category, compute the observed false positive rate and the highest
   score a reviewer rejected.
3. Propose a new threshold above that score, or below it if reviewers reported
   misses.
4. A human approves the change. The system never moves its own thresholds.

Step 4 is not squeamishness. A guardrail that retunes itself in response to
override pressure will drift toward permissiveness, because overriding a block
is faster than overriding a pass.

## Detector-level notes

**Personal data.** Checksums do the heavy lifting. A bare twelve-digit regex
matches any order number; the Verhoeff check rejects about 90% of those, which is
the theoretical maximum for a single check digit. Luhn does the same job for card
numbers. Two context rules suppress the remaining false positives: an identifier
preceded by "order" or followed by "ships" is not an Aadhaar number, and a
published `support@` address is not a personal data leak.

**Grounding.** The lexical check is a sub-millisecond pre-filter and is
superseded entirely when NLI runs, because letting a crude signal outvote a
better one is how a fully entailed answer ended up escalated during development.
Refusals are excluded from claim checking: "I can't share that" is the model
behaving correctly, and flagging it trains operators to ignore the queue.

**Injection.** Pattern families catch known shapes. Published work shows
character-level evasion defeating production guardrails, so this is defence in
depth rather than a solved problem, and the prototype says so rather than
implying coverage it does not have.

**Safety and bias.** Two detectors run and the higher score wins, because they
miss in different directions. The lexicon catches listed phrasings and
protected-attribute reasoning; the transformer catches paraphrased abuse the
lexicon has never seen. During testing the model missed "people like you should
not be allowed to speak here" while the lexicon caught the structure, which is
the case for keeping both.

The bias check is a screen for protected-attribute reasoning appearing in output,
not a measurement of model bias. Those are different claims and conflating them
would be dishonest.
