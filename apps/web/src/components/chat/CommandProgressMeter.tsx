import { cn } from "~/lib/utils";
import { useGT } from "gt-react";
import { formatCommandProgress, type OrchestrationV2CommandProgress } from "@t3tools/contracts";

export function CommandProgressMeter({
  progress,
  compact = false,
}: {
  progress: OrchestrationV2CommandProgress;
  compact?: boolean;
}) {
  const gt = useGT();
  return (
    <span
      role="progressbar"
      aria-label={gt("Command progress")}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.completed}
      className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground"
    >
      <span
        className={cn(
          "h-[3px] overflow-hidden rounded-full bg-foreground/10",
          compact ? "w-10" : "w-12 sm:w-24",
        )}
      >
        <span
          className="block h-full origin-left rounded-full bg-success transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${progress.completed / progress.total})` }}
        />
      </span>
      {formatCommandProgress(progress)}
    </span>
  );
}
