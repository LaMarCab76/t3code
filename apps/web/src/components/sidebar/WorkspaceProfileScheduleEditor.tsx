import { useId } from "react";
import { randomUUID } from "../../lib/utils";
import type { WorkspaceProfileSchedule } from "@t3tools/contracts";
import { WORKSPACE_PROFILE_DAYS } from "@t3tools/client-runtime/workspace-profiles";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function WorkspaceProfileScheduleEditor({
  schedules,
  onChange,
}: {
  schedules: readonly WorkspaceProfileSchedule[];
  onChange: (schedules: readonly WorkspaceProfileSchedule[]) => void;
}) {
  const id = useId();
  const patch = (index: number, value: Partial<WorkspaceProfileSchedule>) =>
    onChange(schedules.map((schedule, i) => (i === index ? { ...schedule, ...value } : schedule)));
  return (
    <div className="grid min-w-0 gap-4">
      <p className="text-sm text-muted-foreground">
        Schedules use this device’s local time and apply only when the app starts. For overnight
        hours, select the day the schedule starts.
      </p>
      {schedules.map((schedule, index) => (
        <fieldset
          key={schedule.id ?? `${schedule.days.join(",")}-${schedule.start}-${schedule.end}`}
          className="min-w-0 rounded-lg border border-border p-3"
        >
          <legend className="px-1 text-sm">Schedule {index + 1}</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {WORKSPACE_PROFILE_DAYS.map(([day, label, short]) => (
              <Label key={day} className="min-w-0 flex-col" aria-label={label}>
                <Checkbox
                  checked={schedule.days.includes(day)}
                  aria-label={label}
                  onCheckedChange={(checked) =>
                    patch(index, {
                      days: checked
                        ? [...schedule.days, day]
                        : schedule.days.filter((value) => value !== day),
                    })
                  }
                />
                <span>{short}</span>
              </Label>
            ))}
          </div>
          <div className="mt-3 grid min-w-0 grid-cols-2 gap-3">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor={`${id}-${index}-start`}>Start time</Label>
              <Input
                nativeInput
                type="time"
                size="compact"
                id={`${id}-${index}-start`}
                value={schedule.start}
                onChange={(event) => patch(index, { start: event.target.value })}
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor={`${id}-${index}-end`}>End time</Label>
              <Input
                nativeInput
                type="time"
                size="compact"
                id={`${id}-${index}-end`}
                value={schedule.end}
                onChange={(event) => patch(index, { end: event.target.value })}
              />
            </div>
          </div>
          {schedule.end < schedule.start ? (
            <p className="mt-2 text-xs text-muted-foreground">Ends the following day.</p>
          ) : null}
          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange(schedules.filter((_, i) => i !== index))}
            >
              Remove schedule
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([
              ...schedules,
              { id: randomUUID(), days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
            ])
          }
        >
          Add schedule
        </Button>
      </div>
    </div>
  );
}
