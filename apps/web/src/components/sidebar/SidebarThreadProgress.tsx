import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ListChecksIcon, TerminalIcon } from "lucide-react";
import { useGT } from "gt-react";
import type { SidebarThreadSummary } from "../../types";
import { CommandProgressMeter } from "../chat/CommandProgressMeter";
import { useCommandProgress } from "../chat/useCommandProgress";
import { cn } from "~/lib/utils";

export function SidebarThreadProgress({
  id,
  thread,
  live,
}: {
  id: string;
  thread: SidebarThreadSummary;
  live: boolean;
}) {
  const gt = useGT();
  const command = useCommandProgress(
    scopeThreadRef(thread.environmentId, thread.id),
    live && thread.hasRunningCommand === true,
  ).find((item) => item.commandLabel);
  const tasks = thread.taskProgress;
  if (!command && !tasks) return null;
  return (
    <span id={id} className="my-0.5 flex min-w-0 flex-col gap-0.5 text-xs text-secondary-label">
      {command ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <code className="min-w-0 flex-1 truncate">{command.commandLabel}</code>
          <CommandProgressMeter progress={command} compact />
        </span>
      ) : null}
      {tasks ? (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 tabular-nums",
            tasks.completed === tasks.total && "text-success-foreground",
          )}
        >
          <ListChecksIcon aria-hidden className="size-3 shrink-0" />
          {gt("{total, plural, one {{done}/{total} task} other {{done}/{total} tasks}}", {
            done: tasks.completed,
            total: tasks.total,
          })}
        </span>
      ) : null}
    </span>
  );
}
