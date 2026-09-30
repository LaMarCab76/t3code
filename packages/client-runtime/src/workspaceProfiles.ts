import type { ScopedProjectRef, SidebarViewMode, WorkspaceProfile } from "@t3tools/contracts";

export function activeWorkspaceProfile(
  profiles: readonly WorkspaceProfile[],
  activeId: string | null | undefined,
): WorkspaceProfile | null {
  return profiles.find((profile) => profile.id === activeId) ?? null;
}

export function workspaceProfileIncludesProject(
  profile: WorkspaceProfile | null,
  project: ScopedProjectRef,
): boolean {
  return (
    profile === null ||
    profile.projects.some(
      (member) =>
        member.environmentId === project.environmentId && member.projectId === project.projectId,
    )
  );
}

export function filterWorkspaceProfileProjects<
  T extends { environmentId: ScopedProjectRef["environmentId"]; id: ScopedProjectRef["projectId"] },
>(projects: readonly T[], profile: WorkspaceProfile | null): readonly T[] {
  return profile === null
    ? projects
    : projects.filter((project) =>
        workspaceProfileIncludesProject(profile, {
          environmentId: project.environmentId,
          projectId: project.id,
        }),
      );
}

export function filterWorkspaceProfileThreads<T extends ScopedProjectRef>(
  threads: readonly T[],
  profile: WorkspaceProfile | null,
): readonly T[] {
  return profile === null
    ? threads
    : threads.filter((thread) => workspaceProfileIncludesProject(profile, thread));
}

export function addWorkspaceProfileProject(
  profiles: readonly WorkspaceProfile[],
  activeId: string | null | undefined,
  project: ScopedProjectRef,
): readonly WorkspaceProfile[] {
  return profiles.map((profile) =>
    profile.id !== activeId ||
    profile.projects.some(
      (member) =>
        member.environmentId === project.environmentId && member.projectId === project.projectId,
    )
      ? profile
      : { ...profile, projects: [...profile.projects, project] },
  );
}

export function resolveSidebarViewMode(settings: {
  sidebarViewMode?: SidebarViewMode | undefined;
  legacySidebarEnabled?: boolean | undefined;
}): SidebarViewMode {
  return settings.sidebarViewMode ?? (settings.legacySidebarEnabled ? "projects" : "status");
}

/** Keeps per-project history contiguous without changing order inside each project. */
export function groupWorkspaceHistory<T>(
  items: readonly T[],
  projectKey: (item: T) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = projectKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].flat();
}
