import { useEffect, useState } from "react";
import { api, type KnowledgeDoc } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Why } from "./Explain";

export function Knowledge() {
  const [company, setCompany] = useState("");
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);

  useEffect(() => {
    api.knowledge().then((d) => { setCompany(d.company); setDocs(d.documents); }).catch(() => {});
  }, []);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">Knowledge base</CardTitle>
        <span className="text-[11px] text-muted-foreground">{company || "loading"}</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted-foreground">
          The policy documents an answer is checked against. When the gateway says a claim is
          contradicted, this is what contradicted it.
        </p>
        <Why>
          DoubleTake does not own a knowledge base. A caller passes these in with each request,
          because in a real deployment they come from the enterprise's own retrieval system and
          change far more often than the gateway does. These fictional documents exist so the demo,
          the traffic seeder and the evaluation set all cite one consistent company.
        </Why>

        <div className="grid gap-2 pt-1 sm:grid-cols-2">
          {docs.map((d) => (
            <div key={d.id} className="rounded-lg border px-3.5 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-[13px] font-semibold">{d.title ?? d.id}</h3>
                <code className="font-mono text-[11px] text-muted-foreground">{d.id}</code>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{d.text}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
