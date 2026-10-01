import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts";
import { workspaceProfileIncludesProject } from "@t3tools/client-runtime/workspace-profiles";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
} from "../../hooks/useSettings";
import { useActiveWorkspaceProfile, useThreadShell, readThreadShell } from "../../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import { finishProfileStartupLanding } from "./WorkspaceProfileStartupGate";

let switchesInFlight = 0;

export function useWorkspaceProfileNavigation() {
  const navigate = useNavigate();
  return async (id: string | null, updateProfile?: (current: ClientSettings) => ClientSettings) => {
    finishProfileStartupLanding();
    switchesInFlight++;
    try {
      const settings = await persistClientSettingsUpdate((current) => ({
        ...(updateProfile ? updateProfile(current) : current),
        activeWorkspaceProfileId: id,
      }));
      if (getClientSettings().activeWorkspaceProfileId !== id) return;
      const profile = settings.workspaceProfiles.find((entry) => entry.id === id) ?? null;
      const ref =
        profile?.lastThread ?? (id === null ? settings.allWorkspaceProfileLastThread : undefined);
      const thread = ref ? readThreadShell(ref) : null;
      if (ref && thread && workspaceProfileIncludesProject(profile, thread)) {
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      } else {
        await navigate({ to: "/" });
      }
    } finally {
      switchesInFlight--;
    }
  };
}

/** Kept in the app shell so deep links are handled even when Settings owns the sidebar. */
export function WorkspaceProfileThreadSync() {
  const active = useActiveWorkspaceProfile();
  const lastAll = useClientSettings((settings) => settings.allWorkspaceProfileLastThread);
  const ref = useParams({ strict: false, select: resolveThreadRouteRef });
  const thread = useThreadShell(ref);
  useEffect(() => {
    if (!thread || switchesInFlight > 0) return;
    if (active && !workspaceProfileIncludesProject(active, thread)) {
      let changed = false;
      void persistClientSettingsUpdate((current) => {
        const currentProfile = current.workspaceProfiles.find(
          (profile) => profile.id === active.id,
        );
        changed =
          current.activeWorkspaceProfileId === active.id &&
          !!currentProfile &&
          !workspaceProfileIncludesProject(currentProfile, thread);
        return changed ? { ...current, activeWorkspaceProfileId: null } : current;
      })
        .then(() => {
          if (changed)
            toastManager.add({
              title: "Switched to All",
              description: "This thread belongs to a project outside the selected profile.",
              type: "info",
            });
        })
        .catch(reportWorkspaceProfileError);
      return;
    }
    const last = active?.lastThread ?? (!active ? lastAll : undefined);
    if (last?.environmentId === thread.environmentId && last.threadId === thread.id) return;
    void persistClientSettingsUpdate((current) => {
      // A queued route effect must not replace a selection made after it was captured.
      if (current.activeWorkspaceProfileId !== (active?.id ?? null)) return current;
      const lastThread = { environmentId: thread.environmentId, threadId: thread.id };
      return active
        ? {
            ...current,
            workspaceProfiles: current.workspaceProfiles.map((profile) =>
              profile.id === active.id ? { ...profile, lastThread } : profile,
            ),
          }
        : { ...current, allWorkspaceProfileLastThread: lastThread };
    }).catch(reportWorkspaceProfileError);
  }, [active, lastAll, thread]);
  return null;
}

export function reportWorkspaceProfileError(cause: unknown) {
  toastManager.add({
    title: "Could not change profile",
    description: cause instanceof Error ? cause.message : "Try again.",
    type: "error",
  });
}
