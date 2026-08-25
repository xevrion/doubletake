import { ACTIONS, ACTION_COPY, type Overview as OverviewData } from "@/lib/api";
import { ActionBadge } from "./ActionLadder";
import { Metric, MetricRow } from "./Metric";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HowItWorks } from "./HowItWorks";
import { Term, Why } from "./Explain";

const FILL: Record<string, string> = {
  pass: "bg-pass", patch: "bg-patch", pause: "bg-pause", page: "bg-page",
};

export function Overview({ data }: { data: OverviewData }) {
  const total = Math.max(1, data.interactions);
  const e = data.economics;
  const cats = Object.entries(data.byCategory).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...cats.map(([, v]) => v));

  return (
    <div className="space-y-4">
      <HowItWorks />

      <MetricRow>
        <Metric label="Interactions" value={String(data.interactions)} hint="checked this session" />
        <Metric label="Held for review" value={String(data.pendingReview)}
                hint={data.reviewed ? `${data.reviewed} resolved` : "awaiting a reviewer"} />
        <Metric label="Corrections" value={String(data.corrections)} hint="late checks that changed the call" />
        <Metric label="Oversight cost" value={`$${e.perThousandUsd.toFixed(3)}`} hint="per 1,000 interactions" />
        <Metric label="Routing saved" value={`$${e.savedUsd.toFixed(4)}`}
                tone={e.netUsd >= 0 ? "good" : undefined}
                hint={e.netUsd >= 0 ? "more than checking cost" : "below oversight cost"} />
        <Metric label="Latency p95" value={`${data.latency.p95.toFixed(0)}ms`}
                hint={`p50 ${data.latency.p50.toFixed(0)} · p99 ${data.latency.p99.toFixed(0)}`} />
      </MetricRow>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Where traffic lands</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div>
              <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
                Most traffic should pass. A layer that flagged everything would be ignored within a
                week, so this bar is the first thing to look at.
              </p>
              <div className="flex h-7 overflow-hidden rounded-md border">
                {ACTIONS.map((a) => {
                  const v = data.byAction[a] ?? 0;
                  if (!v) return null;
                  return <div key={a} className={FILL[a]} style={{ width: `${(v / total) * 100}%` }} title={`${a}: ${v}`} />;
                })}
              </div>
              <div className="tabular mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                {ACTIONS.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <span className={`size-2 rounded-[2px] ${FILL[a]}`} />
                    {ACTION_COPY[a].label} {data.byAction[a] ?? 0}
                  </span>
                ))}
              </div>
            </div>

            <Block title="By risk category">
              {cats.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">Nothing flagged yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {cats.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[96px_1fr_28px] items-center gap-2.5 text-[12px]">
                      <span className="truncate">{k}</span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-muted-foreground/60" style={{ width: `${(v / catMax) * 100}%` }} />
                      </span>
                      <span className="tabular text-right text-muted-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </Block>

            <Block title="By use case">
              <p className="mb-2 text-[12px] leading-relaxed text-muted-foreground">
                Each <Term k="profile">use case profile</Term> carries its own thresholds, so the
                flag rate differs by design rather than by accident.
              </p>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 text-[10px] uppercase">Use case</TableHead>
                    <TableHead className="h-8 text-right text-[10px] uppercase">Checked</TableHead>
                    <TableHead className="h-8 text-right text-[10px] uppercase">Flagged</TableHead>
                    <TableHead className="h-8 text-right text-[10px] uppercase">Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(data.byProfile).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="py-1.5 text-[12px]">{k}</TableCell>
                      <TableCell className="tabular py-1.5 text-right text-[12px]">{v.total}</TableCell>
                      <TableCell className="tabular py-1.5 text-right text-[12px]">{v.flagged}</TableCell>
                      <TableCell className="tabular py-1.5 text-right text-[12px]">
                        {((v.flagged / Math.max(1, v.total)) * 100).toFixed(0)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Block>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">Recent decisions</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
              The last dozen responses the gateway saw, newest first, with the action it chose and
              how long the check took.
            </p>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 w-16 text-[10px] uppercase">Action</TableHead>
                  <TableHead className="h-8 text-[10px] uppercase">Prompt</TableHead>
                  <TableHead className="h-8 w-14 text-right text-[10px] uppercase">Score</TableHead>
                  <TableHead className="h-8 w-12 text-right text-[10px] uppercase">ms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="py-1.5"><ActionBadge action={r.action} /></TableCell>
                    <TableCell className="max-w-0 truncate py-1.5 text-[12px]">{r.prompt}</TableCell>
                    <TableCell className="tabular py-1.5 text-right text-[12px] text-muted-foreground">
                      {r.topCategory ? r.maxScore.toFixed(2) : "n/a"}
                    </TableCell>
                    <TableCell className="tabular py-1.5 text-right text-[12px] text-muted-foreground">
                      {r.latencyMs.toFixed(0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}
