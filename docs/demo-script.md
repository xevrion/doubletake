# Demo script

Five minutes, in order. Every step below has been run end to end; nothing here
is aspirational.

## Setup

```bash
bun install
cp .env.example .env          # optional, works offline without it
bun run seed                  # populates the console with a session of traffic
bun run start
```

Open `http://localhost:3000`. Leave the terminal visible: the model warm-up line
proves the detectors are local.

## 1. The overview (30 seconds)

Land on the Overview tab. Point at three numbers:

- **Interactions** and the action mix bar: most traffic passes. An oversight
  layer that flags everything is useless, and the bar shows this one does not.
- **Oversight cost per 1,000 interactions** against **routing saved**: the layer
  currently pays for itself.
- **Latency p95**: the inline path is inside the budget every profile sets.

## 2. A fabricated policy (60 seconds)

Live check tab, scenario 1. The model claims a 30-day refund window and
refundable shipping; the knowledge base says 14 days and non-refundable.

Run it. Three things to point at:

- The ladder lights **Page**, not a generic "blocked" banner.
- The evidence quotes the exact sentence and names what contradicted it.
- The latency reading is single-digit milliseconds against a 250 ms budget.

Then switch the profile to **Regulated decision support** and run the same text.
The action changes and tier-1 NLI now runs. Same gateway, different posture, and
the policy tab shows why in the threshold table.

## 3. Personal data (30 seconds)

Scenario 2. The reply contains a name, a mobile number and a PAN. Show the
redacted output: the sentence still reads, and the audit record keeps the
original for the reviewer while the user never sees it.

Worth saying aloud: the checksum work means an order number that looks like an
Aadhaar is not flagged. Scenario in the golden set, `bun run eval` proves it.

## 4. The reviewer loop (60 seconds)

Review queue tab. Resolve one item as a false positive and give a reason.

Go to Trust metrics. The tuning panel now proposes a specific threshold change
derived from that verdict. Say plainly that it proposes and does not apply: a
guardrail that retunes itself drifts permissive, because overriding a block is
easier than overriding a pass.

## 5. The honest slide (60 seconds)

Stay on Trust metrics. The precision table is the strongest thing in the demo.

Measured precision is 1.000 on the golden set. The table deliberately assumes a
5% false positive rate instead, and shows precision falling to 17% at 1%
prevalence. Explain that this is why the product has four actions rather than a
block switch, and that a vendor quoting balanced-set precision at you is quoting
the wrong number.

## 6. Verification (30 seconds)

Back to the terminal:

```bash
bun run selfcheck
```

Forty-six checks covering the policy engine, every detector, the audit trail and
provider failover, in under three seconds. This is the answer to "how do we know
any of that was real".

## If the network dies

Nothing above needs it. The detectors are local, the seeded traffic is already in
SQLite, and the upstream provider falls back to scripted replies with a visible
"degraded" label. The one thing that changes is the Live check tab's second
button, which calls a real model.
