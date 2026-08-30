# Demo recording script

Target length 4:30, hard cap 5:00. Every step below has been run end to end
against the live app; nothing here is aspirational.

Two things to decide before you start. Record the screen with your voice over it
rather than a talking head, because the console is the evidence and it needs the
pixels. And read the script rather than improvising: it is written to be spoken,
and improvising is how a four minute video becomes seven.

---

## Before you hit record

Run these once and leave the terminal open in a second workspace. You will switch
to it twice.

```bash
cd ~/Coding/doubletake
bun run start          # wait for "listening on http://localhost:3000"
```

Then in the browser:

1. Open `http://localhost:3000`
2. Set the window to about 1600 wide so the six metric cells sit on one row
3. Land on **Overview** and scroll to the top
4. Zoom the page to 110% (Ctrl and +) so text is readable in a compressed video

Check the Overview reads roughly: **3,000+ interactions, 470+ held for review,
51 corrections, $0.02 per 1,000, p95 under 150ms.** If it is empty, run
`bun run load 3000 --fresh` and then `bun run seed-reviews 45`.

Close every other tab. A stray notification in a submitted video is avoidable.

---

## 0:00 to 0:25 — The problem

**Screen:** Overview tab, top of page.

> Air Canada's chatbot invented a refund policy that did not exist. A customer
> acted on it, and a tribunal held the airline responsible for what its own
> chatbot said.
>
> That is the shape of the problem. An AI in production can be confidently
> wrong, quietly expensive, or leak personal data, and today most teams find out
> only after a user has already acted on the answer.
>
> This is DoubleTake. It sits between the application and the model, reads every
> response before it ships, and decides what to do with it.

**Do:** nothing. Let the header and the four action cards sit on screen while you
talk. They say the same thing you are saying.

---

## 0:25 to 0:55 — The four actions

**Screen:** still Overview. Move the cursor across the four coloured cards as you
name them.

> Most guardrails offer two outcomes: allow, or block. DoubleTake has four.
>
> Pass, when nothing crossed a threshold. Patch, when the problem is
> recoverable, so personal data gets redacted or an unverified claim gets a
> disclosure. Pause, when the answer is wrong enough to be worth another
> attempt. And Page, when the stakes are irreversible: the answer is held and a
> human is notified.
>
> Four exist because blocking everything suspicious would, at realistic rates,
> block mostly correct answers. I will show you that arithmetic in a minute.

**Do:** scroll down slowly to the metric row and the traffic bar.

> Three thousand interactions in this session. Ninety two percent passed
> untouched, which is the number to look at first. A layer that flagged
> everything would be switched off within a week.

---

## 0:55 to 2:10 — The ladder, live

**Screen:** click **Live check**.

> Here is the gateway working. On the left, what a user asked, what the model
> wants to reply, and the knowledge base that reply should be true to. Forty
> three examples, drawn from the same corpus the benchmarks use.

**Do:** the dropdown is already on example 1, *What is your refund window?*
tagged **risky**. Click **Check this response**.

> The model claims a thirty day refund window and refundable shipping. The
> knowledge base says fourteen days, non-refundable.
>
> Page. Held for a human. And look at the evidence: it quotes the exact sentence
> and names what contradicted it. Six milliseconds, against a six hundred
> millisecond budget.

**Do:** open the dropdown, pick item **15**, *What is your refund window?* tagged
**clean**. Click **Check this response**.

> Same question, a correct answer this time. Pass, untouched. That matters more
> than the catch: a checker that cannot tell these apart is useless.

**Do:** open the dropdown, pick item **5**, *Who is handling my case?* Click
**Check this response**.

> Personal data. A staff phone number and a PAN card in a customer reply.

**Do:** point at the "What the user receives" block.

> The user gets the sentence with the identifiers redacted. The original stays
> in the audit record for whoever reviews it.

**Do:** open the dropdown, pick item **8**, *Assess this loan applicant*. The
profile switches to Regulated decision support automatically. Click **Check this
response**.

> A protected attribute driving a lending decision. This profile hard-blocks
> that category: no score is low enough to let it through.

---

## 2:10 to 2:40 — One gateway, four postures

**Screen:** click **Policy**.

> The same response gets a different action depending on which use case produced
> it. A support bot has six hundred milliseconds and tolerates a hedge. A
> regulated decision tool has two and a half seconds and refuses
> protected-attribute reasoning outright.
>
> Thresholds, latency budget, jurisdiction, retention period. These are
> configuration, not code, so a risk officer changes one without a deploy.

**Do:** scroll through the four profiles so the threshold grids are visible.

---

## 2:40 to 3:20 — The human loop

**Screen:** click **Review queue**.

> Four hundred and seventy three responses held for a person. A reviewer decides
> whether each was genuinely a problem.

**Do:** click **Wrong flag** on the first item. Type a short reason, something
like *the policy was updated last week and the knowledge base is stale*. Click
**Submit**.

> That verdict is the only ground truth this system ever receives. Nothing else
> can tell it whether a flag was right.

**Do:** click **Trust metrics**, scroll to the tuning panel on the right.

> And it lands here, as a proposed threshold change. Proposed, not applied. A
> guardrail that retunes itself drifts permissive over time, because overriding
> a block is easier than overriding a pass.

---

## 3:20 to 4:05 — The honest number

**Screen:** stay on **Trust metrics**, top left card.

> This is the part I would want to see if I were evaluating this.
>
> On a labelled set, precision and recall are both one point zero. That sounds
> like bragging, so read the table underneath it.

**Do:** point at the precision-at-prevalence table.

> Those scores come from a test set that is half risky by construction. Real
> traffic is not. Once only one percent of responses are genuinely bad, even a
> near-perfect detector produces mostly false alarms, because there are so many
> more good answers available to get wrong.
>
> At one percent prevalence, more than eight in ten flags are noise. A system
> that blocked on all of them would be blocking mostly correct answers.
>
> That is the whole argument for four actions instead of a block switch. And it
> is why the false positive rate is the number this product optimises and
> reports, rather than the catch rate.

**Do:** move to the economics card.

> Oversight costs two cents per thousand interactions, because the detectors run
> locally. Cost-aware routing saved more than that. The layer pays for itself.

---

## 4:05 to 4:30 — What is actually running, and the close

**Screen:** switch to the terminal.

**Do:** run `bun run selfcheck`.

> Sixty one assertions across the policy engine, every detector, the audit
> trail, provider failover and every HTTP route. Three seconds.
>
> No model was trained for this. The grounding check is an eighty four megabyte
> NLI model running locally on CPU in about twenty milliseconds, and the
> personal data check is regex with real checksums, because for an Aadhaar
> number a checksum beats a classifier.

**Do:** switch back to the browser, Overview tab.

> Everything you have seen is in a public repository with the evaluation
> harness, the load test, and documentation that states plainly what is not
> built yet.
>
> DoubleTake. A second look at every AI answer, before the user acts on it.

---

## If something goes wrong on camera

**The live model call fails.** Do not use the *Generate with Groq* button in the
recording. The scripted path above uses *Check this response*, which is entirely
local and cannot fail on conference wifi.

**A page looks empty.** Reload once. If the queue is empty, you ran the load test
with `--fresh` after seeding reviews; run `bun run seed-reviews 45` again.

**You fluff a line.** Stop, pause three seconds in silence, and say the line
again from the start of that paragraph. Cut the gap afterwards; a clean cut is
invisible and a stumble is not.

---

## After recording

```bash
ffmpeg -i recording.mkv -c:v libx264 -crf 26 -preset slow \
  -vf scale=1600:-2 -r 30 -c:a aac -b:a 128k demo.mp4
```

Play it back before uploading. Check the audio is audible, the text is readable
at full screen, and the length is under five minutes.
