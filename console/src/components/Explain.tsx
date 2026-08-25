import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A short standfirst at the top of each tab. Someone opening this console cold
 *  should be able to read one sentence and know what the screen is for. */
export function TabIntro({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 max-w-[68ch]">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** Terms a reader will not know on first encounter. Defined once here so the
 *  same wording appears everywhere the term does. */
const GLOSSARY: Record<string, string> = {
  grounding:
    "The source documents an answer is supposed to be true to, usually a company's own knowledge base. DoubleTake checks claims against these rather than against the open world, because there is rarely a reliable real-time source of truth.",
  entailed:
    "The sources directly support this claim. Nothing to do.",
  contradicted:
    "The sources say the opposite. This is the serious case: the model asserted something the knowledge base denies.",
  unsupported:
    "The sources neither confirm nor deny this claim. Often means the knowledge base is incomplete rather than that the answer is wrong, which is why it is treated more gently than a contradiction.",
  tier:
    "How expensive a check is. Tier 0 runs on every request in under a millisecond. Tier 1 uses a model and costs tens of milliseconds, so it only runs where the profile can afford it.",
  confidence:
    "How much a detector trusts its own score. A low-confidence finding escalates rather than passing, so the system never resolves an unknown silently in either direction.",
  profile:
    "A use case with its own risk appetite: thresholds, latency budget, jurisdiction and retention period. The same gateway behaves differently for a support bot and a regulated decision tool.",
  prevalence:
    "The share of live traffic that is genuinely risky. It is usually small, which is what makes precision on a balanced test set misleading.",
  precision:
    "Of everything the system flagged, how much was genuinely a problem. Low precision means reviewers waste time on false alarms.",
  recall:
    "Of everything that was genuinely a problem, how much the system caught. Low recall means real issues reach users.",
  fpr: "How often a clean answer gets flagged anyway. This is the number that decides whether people keep the system switched on.",
  hardBlock:
    "A risk category this profile refuses to allow at any score. Used where a single instance is a compliance incident rather than a quality problem.",
  agentic:
    "The model can take actions, not just write text. One bad output becomes several bad actions, so these profiles escalate earlier.",
  exposure:
    "How long an unchecked answer was visible to a user before a late check caught it. The number a risk officer asks for first.",
  routing:
    "Sending each request to the cheapest model that can handle it. The savings pay for the cost of running the checks.",
};

/** A dotted-underlined term that explains itself on hover or focus. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: React.ReactNode }) {
  const text = GLOSSARY[k];
  if (!text) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help border-b border-dotted border-muted-foreground/60 font-medium text-foreground/90 underline-offset-2"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] text-[12px] leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A quiet aside for the reasoning behind a design choice. These carry the
 *  arguments a judge would otherwise have to be told out loud. */
export function Why({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-l-2 border-primary/40 pl-3 text-[12px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
