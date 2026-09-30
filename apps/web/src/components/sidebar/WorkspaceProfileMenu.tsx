import { randomUUID } from "../../lib/utils";
import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { WorkspaceProfile } from "@t3tools/contracts";
import { workspaceProfileIncludesProject } from "@t3tools/client-runtime/workspace-profiles";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  useActiveWorkspaceProfile,
  useAllProjects,
  useThreadShell,
  readThreadShell,
} from "../../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
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
import { toastManager } from "../ui/toast";

let switchingProfile = false;

/** Shared sidebar footer for both layouts, with device-local membership. */
export function WorkspaceProfileMenu() {
  const formId = useId();
  const settings = useClientSettings();
  const update = useUpdateClientSettings();
  const projects = useAllProjects();
  const active = useActiveWorkspaceProfile();
  const navigate = useNavigate();
  const routeRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const thread = useThreadShell(routeRef);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceProfile | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("💼");
  const [color, setColor] = useState("#6366f1");
  const [members, setMembers] = useState<WorkspaceProfile["projects"]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!thread || switchingProfile) return;
    if (!active) {
      if (
        settings.allWorkspaceProfileLastThread?.environmentId !== thread.environmentId ||
        settings.allWorkspaceProfileLastThread?.threadId !== thread.id
      ) {
        void update({
          allWorkspaceProfileLastThread: {
            environmentId: thread.environmentId,
            threadId: thread.id,
          },
        }).catch(() => {});
      }
      return;
    }
    if (!workspaceProfileIncludesProject(active, thread)) {
      void update({ activeWorkspaceProfileId: null })
        .then(() => {
          toastManager.add({
            title: "Switched to All",
            description: "This thread belongs to a project outside the selected profile.",
            type: "info",
          });
        })
        .catch((cause) =>
          toastManager.add({
            title: "Could not change profile",
            description: cause instanceof Error ? cause.message : "Try again.",
            type: "error",
          }),
        );
    } else if (
      active.lastThread?.environmentId !== thread.environmentId ||
      active.lastThread?.threadId !== thread.id
    ) {
      void update({
        workspaceProfiles: settings.workspaceProfiles.map((profile) =>
          profile.id === active.id
            ? {
                ...profile,
                lastThread: { environmentId: thread.environmentId, threadId: thread.id },
              }
            : profile,
        ),
      }).catch(() => {});
    }
  }, [active, thread, settings.workspaceProfiles, settings.allWorkspaceProfileLastThread, update]);

  const selectProfile = async (id: string | null) => {
    switchingProfile = true;
    try {
      await update({ activeWorkspaceProfileId: id });
      const selected = settings.workspaceProfiles.find((profile) => profile.id === id);
      const ref =
        selected?.lastThread ?? (id === null ? settings.allWorkspaceProfileLastThread : undefined);
      const lastThread = ref ? readThreadShell(ref) : null;
      if (ref && lastThread && workspaceProfileIncludesProject(selected ?? null, lastThread)) {
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      } else {
        await navigate({ to: "/" });
      }
    } catch (cause) {
      toastManager.add({
        title: "Could not change profile",
        description: cause instanceof Error ? cause.message : "Try again.",
        type: "error",
      });
    } finally {
      switchingProfile = false;
    }
  };
  const edit = (profile: WorkspaceProfile | null) => {
    setEditing(profile);
    setName(profile?.name ?? "");
    setEmoji(profile?.emoji ?? "💼");
    setColor(profile?.color ?? "#6366f1");
    setMembers(profile?.projects ?? []);
    setError(null);
  };
  const save = async () => {
    if (!name.trim() || !emoji.trim()) {
      setError("Enter a name and an emoji.");
      return;
    }
    const profile: WorkspaceProfile = {
      ...editing,
      id: editing?.id ?? randomUUID(),
      name: name.trim(),
      emoji: emoji.trim(),
      color,
      projects: members,
    };
    try {
      await update({
        workspaceProfiles: editing
          ? settings.workspaceProfiles.map((value) => (value.id === editing.id ? profile : value))
          : [...settings.workspaceProfiles, profile],
      });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save profile.");
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 px-2">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: active?.color ?? "#64748b" }}
          aria-hidden
        >
          {active?.emoji ?? "🌐"}
        </span>
        <select
          aria-label="Workspace profile"
          value={active?.id ?? ""}
          onChange={(event) => {
            void selectProfile(event.target.value || null);
          }}
          className="min-w-0 flex-1 rounded-md bg-transparent py-1 text-sm"
        >
          <option value="">All</option>
          {settings.workspaceProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Manage profiles"
          onClick={() => {
            edit(active);
            setOpen(true);
          }}
        >
          ⚙
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-h-[min(48rem,calc(100dvh-2rem))] max-sm:max-h-[calc(100dvh-3rem)]">
          <DialogHeader className="shrink-0">
            <DialogTitle>Workspace profiles</DialogTitle>
            <DialogDescription>
              Choose which projects appear on this device. A project can belong to several profiles.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => edit(null)}>
                New profile
              </Button>
              {settings.workspaceProfiles.map((profile) => (
                <Button
                  key={profile.id}
                  variant={editing?.id === profile.id ? "secondary" : "ghost"}
                  size="sm"
                  className="min-w-0 max-w-full"
                  title={profile.name}
                  onClick={() => edit(profile)}
                >
                  <span className="shrink-0" aria-hidden>
                    {profile.emoji}
                  </span>
                  <span className="min-w-0 truncate">{profile.name}</span>
                </Button>
              ))}
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-4">
              <div className="grid min-w-0 gap-2">
                <Label htmlFor={`${formId}-name`}>Name</Label>
                <Input
                  id={`${formId}-name`}
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6rem] gap-3">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor={`${formId}-emoji`}>Emoji</Label>
                  <Input
                    id={`${formId}-emoji`}
                    value={emoji}
                    maxLength={32}
                    onChange={(event) => setEmoji(event.target.value)}
                  />
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor={`${formId}-color`}>Background</Label>
                  <Input
                    id={`${formId}-color`}
                    nativeInput
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                  />
                </div>
              </div>
              <fieldset className="min-w-0">
                <legend className="mb-2">
                  <Label render={<span />}>Projects</Label>
                </legend>
                {projects.map((project, index) => {
                  const included = members.some(
                    (member) =>
                      member.environmentId === project.environmentId &&
                      member.projectId === project.id,
                  );
                  const projectId = `${formId}-project-${index}`;
                  return (
                    <Tooltip key={`${project.environmentId}:${project.id}`}>
                      <div className="min-w-0 py-2">
                        <TooltipTrigger render={<Label className="flex min-w-0" />}>
                          <Checkbox
                            checked={included}
                            aria-labelledby={`${projectId}-title`}
                            aria-describedby={`${projectId}-path`}
                            onCheckedChange={(checked) =>
                              setMembers(
                                checked
                                  ? [
                                      ...members,
                                      {
                                        environmentId: project.environmentId,
                                        projectId: project.id,
                                      },
                                    ]
                                  : members.filter(
                                      (member) =>
                                        member.environmentId !== project.environmentId ||
                                        member.projectId !== project.id,
                                    ),
                              )
                            }
                          />
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span id={`${projectId}-title`} className="truncate">
                              {project.title}
                            </span>
                            <span
                              id={`${projectId}-path`}
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
              </fieldset>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter className="shrink-0 sm:justify-between">
            {editing ? (
              <Button
                variant="destructive"
                onClick={() => {
                  void update({
                    workspaceProfiles: settings.workspaceProfiles.filter(
                      (profile) => profile.id !== editing.id,
                    ),
                    ...(active?.id === editing.id ? { activeWorkspaceProfileId: null } : {}),
                  })
                    .then(() => edit(null))
                    .catch((cause) =>
                      setError(
                        cause instanceof Error ? cause.message : "Could not delete profile.",
                      ),
                    );
                }}
              >
                Delete profile
              </Button>
            ) : (
              <span />
            )}
            <Button
              onClick={() => {
                void save();
              }}
            >
              Save profile
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
