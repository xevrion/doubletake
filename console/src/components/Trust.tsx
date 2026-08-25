import { useEffect, useState } from "react";
import { api, type EvalResults } from "@/lib/api";
import { Metric, MetricRow } from "./Metric";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

/** The golden set is small enough to show a zero false-positive rate.
 *  Projecting from zero would claim perfect precision at any prevalence, which
 *  fifteen cases cannot support, so the table assumes a pessimistic floor. */
const ASSUMED_FPR_FLOOR = 0.05;

export function Trust() {
  const [ev, setEv] = useState<EvalResults | null>(null);
  const [tuning, setTuning] = useState<Awaited<ReturnType<typeof api.tuning>> | null>(null);
  const [econ, setEcon] = useState<{ spendUsd: number; savedUsd: number; netUsd: number; latency: { p50: number; p95: number } } | null>(null);

  useEffect(() => {
    api.evalResults().then(setEv).catch(() => setEv(null));
    api.tuning().then(setTuning).catch(() => setTuning(null));
    api.overview().then((o) => setEcon({ ...o.economics, latency: o.latency })).catch(() => setEcon(null));
  }, []);

  const fpr = Math.max(ev?.fpr ?? 0, ASSUMED_FPR_FLOOR);
  const recall = ev?.recall ?? 1;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm">Detection quality</CardTitle>
          <span className="text-[11px] text-muted-foreground">
            {ev ? `${ev.cases} labelled cases · ${new Date(ev.generatedAt).toLocaleDateString()}` : "golden set"}
          </span>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Measured by running every labelled case through the real gateway, not asserted.
            Regenerate with <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">bun run eval</code>.
          </p>

          {ev && (
            <MetricRow>
              <Metric label="Precision" value={ev.precision.toFixed(3)} hint="flags that were real" />
              <Metric label="Recall" value={ev.recall.toFixed(3)} hint="real issues caught" />
              <Metric label="F1" value={ev.f1.toFixed(3)} hint="harmonic mean" />
              <Metric label="False positives" value={ev.fpr.toFixed(3)} hint="clean answers flagged" />
            </MetricRow>
          )}

          <div>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Precision at realistic prevalence
            </div>
            <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
              A balanced test set flatters any detector. This is what the same recall produces once
              only a small share of live traffic is genuinely risky, assuming a {(fpr * 100).toFixed(0)}% false
              positive rate rather than the {((ev?.fpr ?? 0) * 100).toFixed(0)}% the small golden set shows.
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 text-[10px] uppercase">Risky share</TableHead>
                  <TableHead className="h-8 text-right text-[10px] uppercase">Precision</TableHead>
                  <TableHead className="h-8 text-[10px] uppercase">What a reviewer sees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[0.1, 0.05, 0.01].map((p) => {
                  const ppv = (recall * p) / (recall * p + fpr * (1 - p));
                  return (
                    <TableRow key={p}>
                      <TableCell className="tabular py-1.5 text-[12px]">{(p * 100).toFixed(0)}%</TableCell>
                      <TableCell className="tabular py-1.5 text-right text-[12px] font-semibold">{(ppv * 100).toFixed(1)}%</TableCell>
                      <TableCell className="py-1.5 text-[12px] text-muted-foreground">
                        {Math.round(ppv * 100)} of every 100 flags are real
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
              This is the whole argument for four actions instead of a block switch. A system that
              blocked on every flag would, at realistic prevalence, block mostly correct answers.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Runtime economics</CardTitle></CardHeader>
          <CardContent>
            {econ && (
              <MetricRow>
                <Metric label="Oversight cost" value={`$${econ.spendUsd.toFixed(4)}`} hint="model calls" />
                <Metric label="Routing saved" value={`$${econ.savedUsd.toFixed(4)}`} hint="vs frontier baseline" />
                <Metric label="Net" value={`${econ.netUsd >= 0 ? "+" : "−"}$${Math.abs(econ.netUsd).toFixed(4)}`}
                        tone={econ.netUsd >= 0 ? "good" : "warn"}
                        hint={econ.netUsd >= 0 ? "self-funding" : "net cost"} />
              </MetricRow>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Threshold tuning from reviewer feedback</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!tuning || tuning.reviewedCount === 0 ? (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                No reviewer verdicts yet. Resolve an item in the review queue and the tuning engine
                will propose a threshold change here.
              </p>
            ) : (
              <>
                {tuning.suggestions.map((s) => (
                  <div key={s.category} className="rounded-md border px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[12px] font-semibold">{s.category}</span>
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{s.reviewed} reviewed</Badge>
                      <Badge variant="outline" className="tabular px-1.5 py-0 text-[10px]">FP rate {s.falsePositiveRate}</Badge>
                    </div>
                    <p className="mt-1.5 border-l-2 border-border pl-2.5 text-[12px] leading-relaxed text-muted-foreground">
                      {s.suggestion}
                    </p>
                  </div>
                ))}
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  Suggestions only. A guardrail that retunes itself drifts permissive, because
                  overriding a block is easier than overriding a pass.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
