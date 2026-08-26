import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Overview as OverviewData, type Profile, type QueueItem, type Correction } from "@/lib/api";
import { Overview } from "@/components/Overview";
import { LiveCheck } from "@/components/LiveCheck";
import { Trust } from "@/components/Trust";
import { Queue, Corrections, Policies } from "@/components/Queue";
import { Knowledge } from "@/components/Knowledge";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "live", label: "Live check" },
  { id: "queue", label: "Review queue" },
  { id: "trust", label: "Trust metrics" },
  { id: "corrections", label: "Corrections" },
  { id: "knowledge", label: "Knowledge" },
  { id: "policy", label: "Policy" },
] as const;

export default function App() {
  const [tab, setTab] = useState<string>("overview");
  const [dark, setDark] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [provider, setProvider] = useState("model");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const PAGE = 25;
  const [queue, setQueue] = useState<{ items: QueueItem[]; total: number; offset: number }>({ items: [], total: 0, offset: 0 });
  const [corrections, setCorrections] = useState<{ items: Correction[]; total: number; offset: number }>({ items: [], total: 0, offset: 0 });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const loadQueue = useCallback((offset = 0) => {
    api.queue(PAGE, offset).then((d) => setQueue({ items: d.items, total: d.total, offset: d.offset })).catch(() => {});
  }, []);

  const loadCorrections = useCallback((offset = 0) => {
    api.corrections(PAGE, offset).then((d) => setCorrections({ items: d.items, total: d.total, offset: d.offset })).catch(() => {});
  }, []);

  // Offsets are read through refs rather than listed as dependencies. As
  // dependencies they rebuilt `refresh` on every page change, which re-ran the
  // mount effect and reset the selected tab on any interaction that refreshed.
  const queueOffset = useRef(0);
  const correctionsOffset = useRef(0);
  queueOffset.current = queue.offset;
  correctionsOffset.current = corrections.offset;

  const refresh = useCallback(() => {
    api.overview().then(setOverview).catch(() => {});
    loadQueue(queueOffset.current);
    loadCorrections(correctionsOffset.current);
  }, [loadQueue, loadCorrections]);

  function select(id: string) {
    setTab(id);
    if (id === "overview") api.overview().then(setOverview).catch(() => {});
    if (id === "queue") loadQueue(queueOffset.current);
    if (id === "corrections") loadCorrections(correctionsOffset.current);
  }

  useEffect(() => {
    api.profiles().then(setProfiles).catch(() => {});
    api.providers()
      .then((p) => setProvider(p.all.find((x) => x.id === p.active)?.label ?? p.active))
      .catch(() => {});
    refresh();
  }, [refresh]);

  // The queue endpoint returns a page; the true pending count comes from the
  // aggregate, or a badge on a large backlog reads as the page size.
  const pending = overview?.pendingReview ?? queue.items.filter((q) => !q.override).length;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-svh">
        <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-5">
            <div className="flex items-baseline gap-2.5">
              <span className="text-[15px] font-semibold tracking-tight">DoubleTake</span>
              <span className="hidden text-[12px] text-muted-foreground sm:inline">
                a second look at every AI answer
              </span>
            </div>

            <nav className="ml-auto flex items-center gap-0.5 rounded-lg bg-muted/60 p-[3px]" aria-label="Sections">
              {TABS.map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => select(t.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors",
                      active
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                    {t.id === "queue" && pending > 0 && (
                      <span className="tabular inline-grid size-[17px] place-items-center rounded-full bg-page text-[10px] font-bold text-white">
                        {pending > 999 ? `${Math.floor(pending / 1000)}k` : pending}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <Button
              variant="ghost" size="icon" className="size-8 shrink-0"
              onClick={() => setDark((d) => !d)} aria-label="Toggle theme"
            >
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </header>

        <main className="mx-auto max-w-[1600px] p-5">
          {tab === "overview" && (overview ? <Overview data={overview} /> : <Loading />)}
          {tab === "live" && (
            <LiveCheck profiles={profiles} providerLabel={provider} onDone={refresh} />
          )}
          {tab === "queue" && (
            <Queue
              items={queue.items} total={queue.total} offset={queue.offset} limit={PAGE}
              onPage={loadQueue} onChange={refresh}
            />
          )}
          {tab === "trust" && <Trust />}
          {tab === "corrections" && (
            <Corrections
              items={corrections.items} total={corrections.total} offset={corrections.offset}
              limit={PAGE} onPage={loadCorrections}
            />
          )}
          {tab === "knowledge" && <Knowledge />}
          {tab === "policy" && <Policies profiles={profiles} />}
        </main>
      </div>
    </TooltipProvider>
  );
}

function Loading() {
  return <p className="py-20 text-center text-sm text-muted-foreground">Loading</p>;
}
