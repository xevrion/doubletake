import { cn } from "@/lib/utils";

export function Metric({
  label, value, hint, tone,
}: { label: string; value: string; hint?: string; tone?: "default" | "good" | "warn" }) {
  return (
    <div className="min-w-0 px-3.5 py-3">
      <div className="truncate text-[11px] font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "tabular mt-0.5 text-2xl font-semibold tracking-tight",
          tone === "good" && "text-pass",
          tone === "warn" && "text-pause",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Metrics read as a set, so they share one bordered strip rather than each
 *  getting its own card. */
export function MetricRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg border bg-card sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
      {children}
    </div>
  );
}
