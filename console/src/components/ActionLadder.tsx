import { ACTIONS, ACTION_COPY, type Action } from "@/lib/api";
import { cn } from "@/lib/utils";

const TONE: Record<Action, string> = {
  pass: "bg-pass border-pass text-white",
  patch: "bg-patch border-patch text-white",
  pause: "bg-pause border-pause text-white",
  page: "bg-page border-page text-white",
};

/** The decision, as one row. This is the thing a judge should read from across
 *  a room, so it gets more space than anything else on the page. */
export function ActionLadder({ active, size = "lg" }: { active: Action | null; size?: "lg" | "sm" }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {ACTIONS.map((a) => {
        const on = a === active;
        return (
          <div
            key={a}
            className={cn(
              "rounded-md border text-center transition-colors",
              size === "lg" ? "px-2 py-3" : "px-2 py-1.5",
              on ? TONE[a] : "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            <div className={cn("font-semibold leading-none", size === "lg" ? "text-sm" : "text-xs")}>
              {ACTION_COPY[a].label}
            </div>
            {size === "lg" && (
              <div className={cn("mt-1 text-[11px] leading-none", on ? "text-white/80" : "text-muted-foreground/70")}>
                {ACTION_COPY[a].hint}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ActionBadge({ action }: { action: Action }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white",
        TONE[action],
      )}
    >
      {action}
    </span>
  );
}
