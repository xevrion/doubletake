# Regulatory and market references

Every figure below was checked against a primary source in August 2026.
Confidence is stated per item, and items we could not verify are listed at the
end rather than quietly dropped or replaced with something plausible.

A note on why this file exists separately: numbers in a pitch deck age badly and
get repeated without checking. Keeping them here, with their sources and their
confidence, means anyone can re-verify before quoting.

## EU AI Act

The Digital Omnibus amendment **entered into force on 27 July 2026**. Anything
describing it as a pending proposal is out of date. Proposed 19 November 2025,
political agreement 7 May 2026, Parliament approval 16 June 2026 (423 for, 57
against, 174 abstentions).
Source: European Commission, [regulatory framework page](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai). Confidence: high.

Timeline as amended:

| Date | What applies |
|---|---|
| 2 Feb 2025 | Prohibited practices, AI literacy |
| 2 Aug 2025 | GPAI obligations, governance, penalties |
| **2 Aug 2026** | **General application** |
| 2 Dec 2027 | Stand-alone high-risk systems (biometrics, employment, education, critical infrastructure, migration) |
| 2 Aug 2028 | High-risk embedded in regulated products |

Penalty tiers under Article 99, whichever is higher of the percentage or the
fixed sum. SMEs pay the lower of the two.

| Tier | Applies to |
|---|---|
| 7% of global turnover or €35M | Article 5 prohibited practices only |
| 3% or €15M | Operator obligations, including Article 50 transparency |
| 1% or €7.5M | Supplying false information to authorities |

Source: [Article 99](https://artificialintelligenceact.eu/article/99/). Confidence: high.
Note that Article 50 sits in the 3% tier, not the 7% tier. The 7% figure is
frequently misattributed.

The three articles DoubleTake speaks to directly:

- **Article 12, record-keeping.** High-risk systems must technically allow the
  automatic recording of events over the system's lifetime. The audit trail is
  the artefact.
- **Article 14, human oversight.** Overseers must be able to interpret output and
  to disregard, override or reverse it, and the article names automation bias as
  a risk to design against. The reviewer queue and structured overrides are the
  artefact.
- **Article 50, transparency.** Disclosure of AI interaction and marking of
  synthetic content. The patch disclosure is a partial artefact.

Sources: [Art. 12](https://artificialintelligenceact.eu/article/12/), [Art. 14](https://artificialintelligenceact.eu/article/14/), [Art. 50](https://artificialintelligenceact.eu/article/50/). Confidence: high.

## India DPDP Act 2023

Penalties from the Schedule, per violation with no annual cap:

| Amount | Failure |
|---|---|
| ₹250 crore | Reasonable security safeguards, s.8(5) |
| ₹200 crore | Breach notification s.8(6), children's data s.9 |
| ₹150 crore | Significant Data Fiduciary obligations, s.10 |
| ₹50 crore | Residual |

Source: [DPDP Schedule](https://dpdpa.com/theschedule.html). Confidence: high.
The ₹250 crore figure attaches to **security safeguards**, not to breach
notification. That distinction matters when arguing what a control actually
mitigates.

DPDP Rules 2025 were notified as G.S.R. 843(E) in mid-November 2025, phased over
immediate, twelve-month and eighteen-month tranches. Substantive obligations and
Schedule penalties bite in **the first half of 2027**; sources disagree on the
exact day, so we quote the half-year rather than a date we cannot confirm.
Confidence: medium.

The obligations that make an oversight layer directly useful:

- **Rule 6:** security safeguards including regular monitoring and logging, logs
  retained one year
- **Rule 7:** Board notified immediately, full detail within 72 hours
- **Rule 8:** processing logs retained at least one year
- **Rule 13:** Significant Data Fiduciaries must run a DPIA and data audit every
  twelve months, plus algorithmic due diligence

Confidence: medium (Rules summaries; the gazette itself was not machine-readable).

## Market

**AI governance platform spend: $492M in 2026, reaching $1B by 2030.** The same
Gartner release reports that firms using specialised governance platforms are
3.4 times more likely to achieve effective governance, and that governance
technology can reduce regulatory expense by around 20%. Survey of 360
organisations.
Source: [Gartner, 17 February 2026](https://www.gartner.com/en/newsroom/press-releases/2026-02-17-gartner-global-ai-regulations-fuel-billion-dollar-market-for-ai-governance-platforms). Confidence: high.

**By 2027, fragmented AI regulation reaches 50% of world economies, driving $5B
in compliance investment.**
Source: [Gartner, 21 October 2025](https://www.gartner.com/en/newsroom/press-releases/2025-10-21-gartner-unveils-top-predictions-for-it-organizations-and-users-in-2026-and-beyond). Confidence: high.

**Enterprise foundation-model API spend reached $12.5B in 2025**, part of $37B
total GenAI spend, up 3.2x year on year.
Source: [Menlo Ventures, 9 December 2025](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/). Confidence: high.

## Cost of failure

**Moffatt v. Air Canada, 2024 BCCRT 149**, decided 14 February 2024. Total award
approximately **CAD $812**, of which $650.88 was damages for negligent
misrepresentation. The tribunal rejected the airline's argument that it was not
responsible for its chatbot, holding that it makes no difference whether the
information comes from a static page or a chatbot.
Confidence: high on the citation and the damages figure.

This case is a **liability precedent, not a cost figure**. Quoting $812 as the
cost of an AI failure would understate the point; the significance is that a
company owns what its chatbot says.

**iTutorGroup / EEOC: $365,000 settlement**, 11 September 2023, for an automated
hiring system that rejected applicants by age.
Source: [EEOC](https://www.eeoc.gov/newsroom/itutorgroup-pay-365000-settle-eeoc-discriminatory-hiring-suit). Confidence: high.

**Italian Garante fined OpenAI €15,000,000**, decision of 2 November 2024,
announced 20 December 2024.
Source: [Garante](https://www.garanteprivacy.it/home/docweb/-/docweb-display/docweb/10085432). Confidence: high.

**Average cost of a data breach in India: ₹25.5 crore (INR 255 million)**, a
record high and up 15.9% year on year. The same report finds 26% of malicious
breaches in India were AI-generated, and that shadow AI adds ₹17.9 million per
breach.
Source: [IBM, 3 August 2026](https://in.newsroom.ibm.com/India-Records-its-Highest-Average-Cost-of-a-Data-Breach-2026). Confidence: medium-high.

## Cost reduction through routing

**FrugalGPT** reports matching the performance of the best individual model
"with up to 98% cost reduction".
Source: [arXiv:2305.05176](https://arxiv.org/abs/2305.05176). Confidence: high (verbatim from the abstract).

**RouteLLM** reports reducing costs "by over 2 times in certain cases without
compromising the quality".
Source: [arXiv:2406.18665](https://arxiv.org/abs/2406.18665). Confidence: high.
The 85% figure circulating for this paper is not what the abstract claims.

**Prompt caching** discounts cached input by up to 90% on both major providers.
Sources: [Anthropic](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching). Confidence: high.

## Alert fatigue

This is the evidence base for the graduated ladder, and the strongest citation is
the dose-response one.

**Reminder acceptance fell roughly 30% for each additional reminder shown in the
same encounter.** This is the causal claim: more alerts produce less response,
so a system that flags everything achieves less than one that flags selectively.
Source: Ancker et al., *BMC Medical Informatics and Decision Making*, 10 April 2017, [doi:10.1186/s12911-017-0430-8](https://doi.org/10.1186/s12911-017-0430-8). Confidence: high.

**Override rates of 46.2% to 96.2% across 23 studies** of clinical decision
support alerts.
Source: Poly et al., *JMIR Medical Informatics*, 20 July 2020, [doi:10.2196/15653](https://doi.org/10.2196/15653). Confidence: high.

**88.8% of 12,671 annotated arrhythmia alarms were false positives**, from
2,558,760 alarms across 461 patients in 31 days.
Source: Drew et al., *PLoS One*, 22 October 2014, [doi:10.1371/journal.pone.0110274](https://doi.org/10.1371/journal.pone.0110274). Confidence: high.

**Security operations: 4,484 alerts per day, 83% false positives, around 67%
never addressed.** Vendor-sponsored survey of 2,000 analysts with independent
fieldwork, which is how it should be labelled.
Source: [Vectra AI, 2023](https://www.vectra.ai/resources/2023-state-of-threat-detection). Confidence: high, with the sponsorship caveat.

## Deliberately not cited

Listed so that nobody adds them back later.

**The MIT "95% of GenAI pilots deliver zero ROI" statistic.** Project NANDA is
real and sits in the MIT Media Lab, but its public overview does not mention the
report or the statistic, and the PDF is access-restricted. The wording, sample
and methodology could not be verified, and the claim has attracted public
criticism. The two routing papers above support the cost argument without the
credibility risk.

**A per-enterprise annual LLM spend benchmark.** No clean source exists. Published
distributions are heavily skewed, so any single figure would be a derivation
presented as a citation.

**India analyst hourly cost / cost per reviewed item.** Not verifiable from
accessible sources. Where the business case needs it, it is shown as a
derivation with its inputs, not as a cited fact.

**MeitY AI governance guidelines and RBI FREE-AI committee recommendations.**
Both are frequently summarised second-hand; neither could be confirmed against a
primary source. The "seven sutras" framing in particular could not be verified.

**Rite Aid/FTC, Walters v. OpenAI, Clearview, and the Chevrolet "$1 car"
incident.** Either unverified or, in the last case, a PR event with no documented
financial consequence.
