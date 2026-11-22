import type { Element } from "hast";
import { ChevronRightIcon, StarIcon } from "lucide-react";
import { use, useState, type ReactNode } from "react";
import { useClientSettings } from "~/hooks/useSettings";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";
import { hastPlainTextDeep } from "./markdownHast.logic";

function previewText(node: Element): string {
  if (node.tagName === "p" || /^h[1-6]$/.test(node.tagName)) {
    return hastPlainTextDeep(node).replace(/\s+/g, " ").trim();
  }
  if (node.tagName === "li") {
    const paragraph = node.children.find(
      (child) => child.type === "element" && child.tagName === "p",
    );
    const content = node.children.filter(
      (child) => child.type !== "element" || (child.tagName !== "ul" && child.tagName !== "ol"),
    );
    return hastPlainTextDeep(paragraph ?? { children: content })
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const text = previewText(child);
    if (text) return text;
  }
  return "";
}

export function MarkdownInsight(props: {
  readonly node: Element;
  readonly dir?: string | undefined;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const collapsedByDefault = useClientSettings((settings) => settings.assistantInsightsCollapsed);
  const [openOverride, setOpenOverride] = useState<boolean>();
  const open = openOverride ?? !collapsedByDefault;
  const searching = use(MarkdownFindContext);
  const revealRef = findRevealRef(() => setOpenOverride(true));

  return (
    <div
      className="my-1 border-s-2 border-info ps-3"
      role="note"
      dir={props.dir}
      data-markdown-alert="insight"
    >
      <Collapsible open={open} onOpenChange={setOpenOverride}>
        <CollapsibleTrigger
          render={
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-1.5 py-1 text-start text-sm [&:dir(rtl):not([data-panel-open])_svg:last-child]:rotate-180 data-panel-open:[&_svg:last-child]:rotate-90"
              data-thread-find-ignore=""
            />
          }
        >
          <StarIcon className="size-3.5 shrink-0 text-info" aria-hidden />
          <span className="shrink-0 font-medium text-info" data-markdown-alert-label="">
            {props.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {open ? null : previewText(props.node)}
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </CollapsibleTrigger>
        <CollapsiblePanel ref={revealRef} hiddenUntilFound={searching}>
          {props.children}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
