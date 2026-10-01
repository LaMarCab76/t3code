import { useId, useState } from "react";
import type {
  WorkspaceProfile,
  WorkspaceProfileSchedule,
  ClientSettings,
} from "@t3tools/contracts";
import {
  findWorkspaceProfileScheduleIssue,
  workspaceProfileScheduleIssueMessage,
} from "@t3tools/client-runtime/workspace-profiles";
import { randomUUID } from "../../lib/utils";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { useAllProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceProfileAvatarPicker } from "./WorkspaceProfileAvatarPicker";
import { WorkspaceProfileScheduleEditor } from "./WorkspaceProfileScheduleEditor";
import { useWorkspaceProfileNavigation } from "./useWorkspaceProfileNavigation";

/** Mount a new instance per edit so cancelling never persists an unfinished draft. */
export function WorkspaceProfileDialog({
  profile,
  onClose,
}: {
  profile: WorkspaceProfile | null;
  onClose: () => void;
}) {
  const formId = useId();
  const settings = useClientSettings();
  const projects = useAllProjects();
  const selectProfile = useWorkspaceProfileNavigation();
  const [id] = useState(() => profile?.id ?? randomUUID());
  const [step, setStep] = useState(1);
  const [name, setName] = useState(profile?.name ?? "");
  const [emoji, setEmoji] = useState(profile?.emoji ?? "💼");
  const [color, setColor] = useState(profile?.color ?? "#6366f1");
  const [members, setMembers] = useState<WorkspaceProfile["projects"]>(profile?.projects ?? []);
  const [schedules, setSchedules] = useState<readonly WorkspaceProfileSchedule[]>(() =>
    (profile?.schedules ?? []).map((schedule) => ({
      ...schedule,
      id: schedule.id ?? randomUUID(),
    })),
  );
  const [isDefault, setIsDefault] = useState(settings.defaultWorkspaceProfileId === id);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = name.trim().length > 0 && name.trim().length <= 60 && emoji.trim().length > 0;
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updateDraft = (current: ClientSettings): ClientSettings => {
        const previous = current.workspaceProfiles.find((entry) => entry.id === id);
        const draft: WorkspaceProfile = {
          ...previous,
          id,
          name: name.trim(),
          emoji: emoji.trim(),
          color,
          projects: members,
          schedules,
        };
        const profiles = previous
          ? current.workspaceProfiles.map((entry) => (entry.id === id ? draft : entry))
          : [...current.workspaceProfiles, draft];
        const issue = findWorkspaceProfileScheduleIssue(profiles);
        if (issue) throw new Error(workspaceProfileScheduleIssueMessage(issue, profiles));
        return {
          ...current,
          workspaceProfiles: profiles,
          ...(isDefault
            ? { defaultWorkspaceProfileId: id }
            : current.defaultWorkspaceProfileId === id
              ? { defaultWorkspaceProfileId: null }
              : {}),
        };
      };
      if (profile) await persistClientSettingsUpdate(updateDraft);
      else await selectProfile(id, updateDraft);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save profile.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-h-[min(48rem,calc(100dvh-2rem))] max-sm:max-h-[calc(100dvh-3rem)]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{profile ? "Edit profile" : "Create profile"}</DialogTitle>
          <DialogDescription>
            Step {step} of 2 · {step === 1 ? "Profile details" : "Projects"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {step === 1 ? (
            <div className="grid min-w-0 gap-6">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <Input
                  autoFocus
                  id={`${formId}-name`}
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && valid) {
                      event.preventDefault();
                      setStep(2);
                    }
                  }}
                />
              </div>
              <div className="flex justify-center py-4">
                <WorkspaceProfileAvatarPicker
                  emoji={emoji}
                  color={color}
                  onEmojiChange={setEmoji}
                  onColorChange={setColor}
                />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                Choose an emoji and background color for your profile.
              </p>
            </div>
          ) : (
            <div className="grid min-w-0 gap-5">
              <fieldset className="min-w-0">
                <legend className="mb-2 text-sm font-medium">Projects</legend>
                <p className="mb-3 text-sm text-muted-foreground">
                  Choose projects to show in this profile. A project can belong to several profiles.
                </p>
                {!projects.length ? (
                  <p className="text-sm text-muted-foreground">
                    No projects available. You can add projects to this profile later.
                  </p>
                ) : null}
                {projects.map((project, index) => {
                  const included = members.some(
                    (member) =>
                      member.environmentId === project.environmentId &&
                      member.projectId === project.id,
                  );
                  return (
                    <Tooltip key={`${project.environmentId}:${project.id}`}>
                      <div className="min-w-0 py-2">
                        <TooltipTrigger render={<Label className="flex min-w-0" />}>
                          <Checkbox
                            checked={included}
                            aria-labelledby={`${formId}-${index}-title`}
                            aria-describedby={`${formId}-${index}-path`}
                            onCheckedChange={(checked) =>
                              setMembers((current) =>
                                checked
                                  ? [
                                      ...current,
                                      {
                                        environmentId: project.environmentId,
                                        projectId: project.id,
                                      },
                                    ]
                                  : current.filter(
                                      (member) =>
                                        member.environmentId !== project.environmentId ||
                                        member.projectId !== project.id,
                                    ),
                              )
                            }
                          />
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span id={`${formId}-${index}-title`} className="truncate">
                              {project.title}
                            </span>
                            <span
                              id={`${formId}-${index}-path`}
                              className="truncate text-xs text-muted-foreground"
                            >
                              {project.workspaceRoot}
                            </span>
                          </span>
                        </TooltipTrigger>
                      </div>
                      <TooltipPopup variant="code">{project.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                  );
                })}
                {members.some(
                  (member) =>
                    !projects.some(
                      (project) =>
                        project.environmentId === member.environmentId &&
                        project.id === member.projectId,
                    ),
                ) ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Projects from disconnected environments are kept in this profile.
                  </p>
                ) : null}
              </fieldset>
              <details className="min-w-0">
                <summary className="cursor-pointer text-sm font-medium">
                  Startup preferences
                </summary>
                <div className="mt-4 grid min-w-0 gap-4">
                  <Label>
                    <Checkbox checked={isDefault} onCheckedChange={setIsDefault} />
                    Use as default profile
                  </Label>
                  <WorkspaceProfileScheduleEditor schedules={schedules} onChange={setSchedules} />
                </div>
              </details>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter className="shrink-0 sm:justify-between">
          <div>
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
          </div>
          <div className="flex gap-2">
            {step === 2 ? (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
              >
                Back
              </Button>
            ) : null}
            <Button
              disabled={!valid || saving}
              onClick={() => {
                if (step === 1) setStep(2);
                else void save();
              }}
            >
              {saving
                ? "Saving…"
                : step === 1
                  ? "Next"
                  : profile
                    ? "Save changes"
                    : "Create profile"}
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
