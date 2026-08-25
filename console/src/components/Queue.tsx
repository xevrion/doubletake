import { useState } from "react";
import { api, type QueueItem, type Correction, type Profile } from "@/lib/api";
import { ActionBadge } from "./ActionLadder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Term, Why } from "./Explain";

export function Queue({ items, onChange }: { items: QueueItem[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function resolve(item: QueueItem, verdict: "true-positive" | "false-positive") {
    const reason = window.prompt(
      verdict === "false-positive"
        ? "Why was this flag wrong? This feeds threshold tuning."
        : "Note for the audit record (optional):",
    );
    if (reason === null) return;
    setBusy(item.id);
    try {
      await api.override(item.id, {
        to: verdict === "false-positive" ? "pass" : item.action,
        verdict, reason, by: "reviewer@demo",
      });
      onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">Held for human review</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">
          Responses the gateway held back rather than sending. A person decides whether each one was
          genuinely a problem.
        </p>
        <Why>
          These verdicts are the only ground truth the system ever receives. Nothing else can tell
          it whether a flag was right, which is why the buttons ask for a reason and why the answers
          feed straight into threshold tuning on the Trust metrics tab.
        </Why>

        {items.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-muted-foreground">Nothing held for review.</p>
        ) : (
          items.map((i) => (
            <div key={i.id} className={`rounded-lg border px-3.5 py-3 ${i.override ? "bg-muted/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <ActionBadge action={i.action} />
                <span className="tabular text-[11px] text-muted-foreground">
                  {i.profileId} · {i.topCategory ?? "—"} {i.maxScore.toFixed(2)} · {new Date(i.ts).toLocaleTimeString()}
                </span>
              </div>
              <dl className="mt-2 space-y-1 text-[12px] leading-relaxed">
                <div className="flex gap-2">
                  <dt className="shrink-0 font-medium text-muted-foreground">Asked</dt>
                  <dd className="min-w-0">{i.promptPreview}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0 font-medium text-muted-foreground">Held</dt>
                  <dd className="min-w-0">{i.responsePreview}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{i.rationale}</p>

              {i.override ? (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  <Badge variant="secondary" className="mr-1.5 px-1.5 py-0 text-[10px]">{i.override.verdict}</Badge>
                  resolved to {i.override.to} by {i.override.by}
                  {i.override.reason && <> · &ldquo;{i.override.reason}&rdquo;</>}
                </p>
              ) : (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy === i.id}
                          onClick={() => resolve(i, "false-positive")}>
                    Wrong flag
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy === i.id}
                          onClick={() => resolve(i, "true-positive")}>
                    Correctly caught
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function Corrections({ items }: { items: Correction[] }) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">Recall and correct</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">
          A fast <Term k="profile">profile</Term> cannot afford a deep check inline, so some checks
          run after the answer has already gone out. When one of them disagrees with the inline
          decision, the gateway issues a correction against that response, the way an email client
          retracts a sent message.
        </p>
        <Why>
          Each entry records its <Term k="exposure">exposure window</Term>: how long the unchecked
          answer was visible before the correction fired. That is the number a risk officer asks for
          first, so the system measures it rather than hiding it.
        </Why>
        {items.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-muted-foreground">
            No corrections issued. Deep checks have agreed with every inline decision so far.
          </p>
        ) : (
          items.map((c) => (
            <div key={c.auditId} className="rounded-lg border px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <ActionBadge action={c.suggestedAction} />
                <span className="tabular text-[11px] text-muted-foreground">
                  exposed for {c.exposureMs.toFixed(0)}ms · {new Date(c.issuedAt).toLocaleTimeString()}
                </span>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed">{c.reason}</p>
              <ul className="mt-2 space-y-1">
                {c.findings.flatMap((f) => f.evidence.slice(0, 2)).map((e, i) => (
                  <li key={i} className="border-l-2 border-border pl-2.5 text-[12px] leading-relaxed text-muted-foreground">
                    {e.text}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function Policies({ profiles }: { profiles: Profile[] }) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">Policy profiles</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">
          One gateway, four risk postures. The same response gets a different action depending on
          which use case produced it, which jurisdiction it falls under, and how much latency that
          use case can afford.
        </p>
        <Why>
          These are configuration rather than code, so a risk officer can change a threshold without
          a deploy. To see it work, run a scenario on Live check, switch the profile, and run the
          identical text again.
        </Why>
        {profiles.map((p) => (
          <div key={p.id} className="rounded-lg border px-3.5 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-[13px] font-semibold">{p.label}</h3>
              <code className="font-mono text-[11px] text-muted-foreground">{p.id}</code>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{p.description}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="tabular px-1.5 py-0 text-[10px]">{p.latencyBudgetMs}ms</Badge>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">tier &le;{p.maxInlineTier}</Badge>
              <Badge variant="outline" className="tabular px-1.5 py-0 text-[10px]">{(p.asyncSampleRate * 100).toFixed(0)}% sampled</Badge>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{p.jurisdiction.join("/")}</Badge>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">unsure &rarr; {p.onUncertain}</Badge>
              <Badge variant="outline" className="tabular px-1.5 py-0 text-[10px]">{p.retentionDays}d retention</Badge>
              {p.agentic && (
                <Badge className="bg-pause-soft px-1.5 py-0 text-[10px] text-pause hover:bg-pause-soft">
                  <Term k="agentic">agentic</Term>
                </Badge>
              )}
              {p.hardBlock.length > 0 && (
                <Badge className="bg-page-soft px-1.5 py-0 text-[10px] text-page hover:bg-page-soft">
                  hard block: {p.hardBlock.join(", ")}
                </Badge>
              )}
            </div>
            <div className="tabular mt-3 grid grid-cols-4 gap-x-3 gap-y-1 text-[11px]">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Risk</span>
              <span className="text-right text-[10px] uppercase tracking-wide text-muted-foreground">Patch</span>
              <span className="text-right text-[10px] uppercase tracking-wide text-muted-foreground">Pause</span>
              <span className="text-right text-[10px] uppercase tracking-wide text-muted-foreground">Page</span>
              {Object.entries(p.thresholds).map(([k, v]) => (
                <div key={k} className="contents">
                  <span>{k}</span>
                  <span className="text-right text-muted-foreground">{v.patch.toFixed(2)}</span>
                  <span className="text-right text-muted-foreground">{v.pause.toFixed(2)}</span>
                  <span className="text-right text-muted-foreground">{v.page.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
