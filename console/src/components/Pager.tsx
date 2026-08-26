import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Shown only when there is more than one page, so a short list stays clean. */
export function Pager({
  total, offset, limit, onChange,
}: { total: number; offset: number; limit: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  const from = offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between gap-3 border-t pt-3">
      <span className="tabular text-[12px] text-muted-foreground">
        {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline" size="sm" className="h-7 px-2"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="tabular min-w-[5.5rem] text-center text-[12px] text-muted-foreground">
          page {page} of {pages}
        </span>
        <Button
          variant="outline" size="sm" className="h-7 px-2"
          disabled={to >= total}
          onClick={() => onChange(offset + limit)}
          aria-label="Next page"
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
