import { assistantInsightPreview } from "@t3tools/shared/assistantInsights";
import { ChevronRightIcon, StarIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { findRevealRef } from "./markdownFindContext";

export function MarkdownInsight({ markdown, children }: { markdown: string; children: ReactNode }) {
  const collapsedByDefault = useClientSettings((settings) => settings.assistantInsightsCollapsed);
  // Until the user toggles this block, it follows the setting.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? !collapsedByDefault;
  const revealRef = findRevealRef(() => setOpenOverride(true));
  const preview = open ? "" : assistantInsightPreview(markdown);

  return (
    <div className="my-3 rounded-md border border-border/60 bg-muted/30">
      <Collapsible open={open} onOpenChange={setOpenOverride} data-markdown-insight="">
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left text-sm"
          data-thread-find-ignore=""
        >
          <StarIcon className="size-3.5 shrink-0 fill-current text-warning" aria-hidden />
          <span className="shrink-0 font-medium text-foreground">Insight</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>
          <ChevronRightIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
        </CollapsibleTrigger>
        {/* Folded text stays in the DOM so find and citations can reach and reveal it. */}
        <CollapsiblePanel ref={revealRef} hiddenUntilFound>
          <div className="px-3 pb-2.5">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
