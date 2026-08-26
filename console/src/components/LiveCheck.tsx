import { useEffect, useState } from "react";
import { api, type CheckResult, type Profile, type Sample } from "@/lib/api";
import { ActionLadder } from "./ActionLadder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Term, Why } from "./Explain";
import { Shuffle } from "lucide-react";

const KIND_COPY: Record<string, { label: string; hint: string }> = {
  risky: { label: "Genuinely a problem", hint: "should be flagged" },
  clean: { label: "A correct answer", hint: "should pass untouched" },
  hedged: { label: "The model declining", hint: "good behaviour, must not be punished" },
};

const parseSources = (t: string) =>
  t.split("\n").map((l) => l.trim()).filter(Boolean).map((text, i) => ({ id: `kb-${i + 1}`, text }));

export function LiveCheck({
  profiles, providerLabel, onDone,
}: { profiles: Profile[]; providerLabel: string; onDone: () => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [knowledge, setKnowledge] = useState("");
  const [idx, setIdx] = useState(0);
  const [profileId, setProfileId] = useState("support-bot");
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<"check" | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const profile = profiles.find((p) => p.id === profileId);
  const current = samples[idx];

  // The knowledge base loaded here is the same one the gateway checks against,
  // so what a person tries by hand matches what the benchmarks measure.
  useEffect(() => {
    Promise.all([api.samples(), api.knowledge()])
      .then(([list, k]) => {
        setSamples(list);
        const kb = k.documents.map((d) => d.text).join("\n");
        setKnowledge(kb);
        const first = list[0];
        if (first) {
          setProfileId(first.profile);
          setPrompt(first.prompt);
          setResponse(first.response);
          setSources(kb);
        }
      })
      .catch(() => {});
  }, []);

  function pick(i: number) {
    const s = samples[i];
    if (!s) return;
    setIdx(i);
    setProfileId(s.profile);
    setPrompt(s.prompt);
    setResponse(s.response);
    setSources(knowledge);
    setResult(null);
  }

  function shuffle() {
    if (samples.length === 0) return;
    pick(Math.floor(Math.random() * samples.length));
  }

  async function run(mode: "check" | "ask") {
    setBusy(mode);
    setError(null);
    try {
      const body: Record<string, unknown> = { prompt, profileId, sources: parseSources(sources) };
      if (mode === "check") {
        body.response = response;
        body.usage = { promptTokens: 180, completionTokens: 90, model: "gpt-class-mini", costUsd: 0.000081 };
        body.savedUsd = 0.00243;
      }
      const r = mode === "check" ? await api.check(body) : await api.ask(body);
      if (mode === "ask") setResponse(r.originalResponse);
      setResult(r);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            What the user asked, what the model wants to reply, and the{" "}
            <Term k="grounding">grounding sources</Term> that reply should be true to. Edit any of
            it, or pick a scenario below.
          </p>
          <Field label={`Example (${samples.length} available)`}>
            <div className="flex gap-1.5">
              <Select value={String(idx)} onValueChange={(v) => pick(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Loading examples" /></SelectTrigger>
                <SelectContent className="max-h-[320px]">
                  {samples.map((s, i) => (
                    <SelectItem key={`${s.prompt}-${i}`} value={String(i)}>
                      <span className="mr-1.5 text-[10px] uppercase text-muted-foreground">{s.kind}</span>
                      {s.prompt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="shrink-0" onClick={shuffle} title="Random example">
                <Shuffle className="size-3.5" />
              </Button>
            </div>
            {current && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground/80">{KIND_COPY[current.kind]?.label}</span>
                {" · "}{current.why ?? KIND_COPY[current.kind]?.hint}
              </p>
            )}
          </Field>

          <Field label="Use case profile">
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {profiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {profile && (
              <div className="tabular mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>{profile.latencyBudgetMs}ms budget</span>
                <span>tier {profile.maxInlineTier} inline</span>
                <span>{profile.jurisdiction.join("/")}</span>
                <span>unsure: {profile.onUncertain}</span>
              </div>
            )}
          </Field>

          <Field label="User prompt">
            <Textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="resize-none text-[13px]" />
          </Field>
          <Field label="Model response" hint="what the AI wants to send">
            <Textarea rows={4} value={response} onChange={(e) => setResponse(e.target.value)} className="text-[13px]" />
          </Field>
          <Field label="Grounding sources" hint="one per line">
            <Textarea rows={3} value={sources} onChange={(e) => setSources(e.target.value)} className="text-[13px]" />
          </Field>

          <div className="grid gap-2 pt-1">
            <Button onClick={() => run("check")} disabled={busy !== null}>
              {busy === "check" ? "Checking" : "Check this response"}
            </Button>
            <Button variant="outline" onClick={() => run("ask")} disabled={busy !== null}>
              {busy === "ask" ? "Generating" : `Generate with ${providerLabel}, then check`}
            </Button>
          </div>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card className="min-h-[420px]">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">Decision</CardTitle>
          {result?.generation && (
            <span className="tabular text-[11px] text-muted-foreground">
              {result.generation.provider} · {result.generation.model} · {result.generation.wallMs.toFixed(0)}ms
            </span>
          )}
        </CardHeader>
        <CardContent>
          {!result ? (
            <div className="py-14 text-center">
              <p className="text-sm text-muted-foreground">Pick a scenario and run a check.</p>
              <p className="mx-auto mt-2 max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground/80">
                The scenarios are ordered so each one lands on a different action. Run them top to
                bottom to see the whole ladder.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <ActionLadder active={result.action} />
              <p className="text-[13px] leading-relaxed">{result.decision.rationale}</p>
              {result.finalResponse !== result.originalResponse && (
                <Why>
                  The model wrote something different from what the user will see. The original is
                  preserved in the audit record for whoever reviews it.
                </Why>
              )}

              <div className="tabular grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border bg-muted/30 px-3.5 py-3 text-[12px] sm:grid-cols-4">
                <Stat k="Latency" v={`${result.timing.totalMs.toFixed(0)}ms`}
                      s={`${result.timing.withinBudget ? "within" : "over"} ${result.profile.latencyBudgetMs}ms`} />
                <Stat k="Top risk" v={result.decision.topCategory ?? "none"}
                      s={`score ${result.decision.maxScore.toFixed(2)}`} />
                <Stat k="Detectors" v={String(result.findings.length)}
                      s={result.timing.droppedForTime.length ? `${result.timing.droppedForTime.length} dropped` : "all completed"} />
                <Stat k="Certainty" v={result.decision.uncertain ? "unsure" : "confident"}
                      s={result.decision.uncertaintyReason ?? "detectors agreed"} />
              </div>

              <Section title="What the user receives">
                <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-3.5 py-3 font-mono text-[12px] leading-relaxed">
                  {result.finalResponse}
                </pre>
              </Section>

              <Section title="Evidence">
                <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
                  Each detector that fired, with its score, its{" "}
                  <Term k="confidence">confidence</Term>, its <Term k="tier">tier</Term>, and the
                  exact text it objected to.
                </p>
                {result.findings.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No detector produced a finding.</p>
                ) : (
                  <div className="space-y-2">
                    {result.findings.map((f) => (
                      <div key={f.detector} className="rounded-md border px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[12px] font-semibold">{f.detector}</span>
                          {f.categories.map((c) => (
                            <Badge key={c} variant="secondary" className="px-1.5 py-0 text-[10px] font-medium uppercase">{c}</Badge>
                          ))}
                          <Badge variant="outline" className="tabular px-1.5 py-0 text-[10px]">
                            tier {f.tier} · {f.latencyMs.toFixed(0)}ms · conf {f.confidence.toFixed(2)}
                          </Badge>
                          <span className={cn(
                            "tabular ml-auto rounded px-1.5 py-0.5 text-[11px] font-bold",
                            f.score >= 0.7 ? "bg-page-soft text-page"
                              : f.score >= 0.45 ? "bg-pause-soft text-pause"
                              : "bg-muted text-muted-foreground",
                          )}>
                            {f.score.toFixed(2)}
                          </span>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {f.evidence.map((e, i) => (
                            <li key={i} className="border-l-2 border-border pl-2.5 text-[12px] leading-relaxed text-muted-foreground">
                              {e.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] font-medium">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="mt-0.5 truncate font-semibold">{v}</div>
      <div className="truncate text-[11px] text-muted-foreground">{s}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}
