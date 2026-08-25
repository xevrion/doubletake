import { ACTIONS, ACTION_COPY, type Action } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

const TONE: Record<Action, string> = {
  pass: "border-pass/40 bg-pass-soft", patch: "border-patch/40 bg-patch-soft",
  pause: "border-pause/40 bg-pause-soft", page: "border-page/40 bg-page-soft",
};
const INK: Record<Action, string> = {
  pass: "text-pass", patch: "text-patch", pause: "text-pause", page: "text-page",
};

const WHEN: Record<Action, string> = {
  pass: "Nothing crossed a threshold. The answer goes out exactly as the model wrote it.",
  patch: "Recoverable. Personal data is redacted, or an unverified claim gets a disclosure attached.",
  pause: "Wrong enough to be worth another attempt, so the request is regenerated on a stronger model.",
  page: "Irreversible or high stakes. The answer is held, a reviewer is notified, and the original is kept for them.",
};

export function HowItWorks() {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="max-w-[72ch]">
          <h2 className="text-[15px] font-semibold tracking-tight">
            A second look at every AI answer, before the user acts on it
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            An AI in production can be confidently wrong, quietly expensive, or leak personal data,
            and most teams find out only after someone has acted on the answer. DoubleTake sits
            between the application and the model, reads every response before it ships, and decides
            what to do with it.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-muted-foreground">
          <Step n="1" label="user asks" />
          <Arrow />
          <Step n="2" label="model answers" />
          <Arrow />
          <Step n="3" label="DoubleTake checks" strong />
          <Arrow />
          <Step n="4" label="user reads, or does not" />
        </div>

        <div className="mt-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Every response lands on one of four actions
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ACTIONS.map((a) => (
              <div key={a} className={cn("rounded-lg border px-3 py-2.5", TONE[a])}>
                <div className={cn("text-[13px] font-semibold", INK[a])}>{ACTION_COPY[a].label}</div>
                <p className="mt-1 text-[12px] leading-relaxed text-foreground/75">{WHEN[a]}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 max-w-[72ch] text-[12px] leading-relaxed text-muted-foreground">
            Most guardrails offer only allow or block. Four actions exist because blocking everything
            suspicious would, at realistic rates, block mostly correct answers. The Trust metrics tab
            works through that arithmetic.
          </p>
        </div>

        <Accordion type="single" collapsible className="mt-4 border-t pt-1">
          <AccordionItem value="detail" className="border-0">
            <AccordionTrigger className="py-2 text-[12px] font-medium hover:no-underline">
              How the checking works
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <div className="grid max-w-[76ch] gap-3 text-[12px] leading-relaxed text-muted-foreground sm:grid-cols-2">
                <Para title="Fast checks on everything">
                  Personal data, prompt injection, unsafe content and cost run on every request in
                  under a millisecond. These are deterministic rules, not models: for structured
                  identifiers like an Aadhaar or a card number, a checksum beats a classifier.
                </Para>
                <Para title="Deeper checks where they fit">
                  A local language model reads each factual claim against the supplied sources and
                  returns one of three verdicts: entailed, unsupported, or contradicted. Those are
                  different problems and they get different actions.
                </Para>
                <Para title="Different rules per use case">
                  A customer support bot has 250ms and tolerates a hedge. A regulated decision tool
                  has 2.5 seconds and refuses any protected-attribute reasoning outright. Same
                  gateway, different profile.
                </Para>
                <Para title="Nothing is decided silently">
                  Every decision is written to an audit trail with the evidence behind it. When a
                  checker is unsure, it escalates to a human rather than guessing in either
                  direction.
                </Para>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function Step({ n, label, strong }: { n: string; label: string; strong?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
      strong ? "border-primary/50 bg-primary/10 font-medium text-foreground" : "bg-muted/40",
    )}>
      <span className="tabular text-[10px] text-muted-foreground">{n}</span>
      {label}
    </span>
  );
}

function Arrow() {
  return <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />;
}

function Para({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-foreground">{title}</div>
      <p className="mt-0.5">{children}</p>
    </div>
  );
}
