import { useCallback, useEffect, useState } from "react";
import { api, type Overview as OverviewData, type Profile, type QueueItem, type Correction } from "@/lib/api";
import { Overview } from "@/components/Overview";
import { LiveCheck } from "@/components/LiveCheck";
import { Trust } from "@/components/Trust";
import { Queue, Corrections, Policies } from "@/components/Queue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "live", label: "Live check" },
  { id: "queue", label: "Review queue" },
  { id: "trust", label: "Trust metrics" },
  { id: "corrections", label: "Corrections" },
  { id: "policy", label: "Policy" },
] as const;

export default function App() {
  const [tab, setTab] = useState<string>("overview");
  const [dark, setDark] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [provider, setProvider] = useState("model");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const refresh = useCallback(() => {
    api.overview().then(setOverview).catch(() => {});
    api.queue().then(setQueue).catch(() => {});
    api.corrections().then(setCorrections).catch(() => {});
  }, []);

  useEffect(() => {
    api.profiles().then(setProfiles).catch(() => {});
    api.providers()
      .then((p) => setProvider(p.all.find((x) => x.id === p.active)?.label ?? p.active))
      .catch(() => {});
    refresh();
  }, [refresh]);

  const pending = queue.filter((q) => !q.override).length;

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

          <Tabs value={tab} onValueChange={setTab} className="ml-auto">
            <TabsList className="h-9">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="gap-1.5 text-[13px]">
                  {t.label}
                  {t.id === "queue" && pending > 0 && (
                    <span className="tabular inline-grid size-[17px] place-items-center rounded-full bg-page text-[10px] font-bold text-white">
                      {pending}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Button variant="ghost" size="icon" className="size-8 shrink-0"
                  onClick={() => setDark((d) => !d)} aria-label="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] p-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsContent value="overview" className="mt-0">
            {overview ? <Overview data={overview} /> : <Loading />}
          </TabsContent>
          <TabsContent value="live" className="mt-0">
            <LiveCheck profiles={profiles} providerLabel={provider} onDone={refresh} />
          </TabsContent>
          <TabsContent value="queue" className="mt-0">
            <Queue items={queue} onChange={refresh} />
          </TabsContent>
          <TabsContent value="trust" className="mt-0">
            <Trust />
          </TabsContent>
          <TabsContent value="corrections" className="mt-0">
            <Corrections items={corrections} />
          </TabsContent>
          <TabsContent value="policy" className="mt-0">
            <Policies profiles={profiles} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
    </TooltipProvider>
  );
}

function Loading() {
  return <p className="py-20 text-center text-sm text-muted-foreground">Loading…</p>;
}
