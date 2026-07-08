import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_PROFILE_ID,
  type AppProfile,
  type ClientSettings,
  type ClientSettingsPatch,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { derivePhysicalProjectKey, derivePhysicalProjectKeyFromPath } from "./logicalProject";
import type { ProviderInstanceEntry } from "./providerInstances";
import type { Project, SidebarThreadSummary } from "./types";

export const ALL_PROFILES_PROVIDER_SCOPE = "__all_profiles__";

const DEFAULT_PROFILE: AppProfile = {
  id: DEFAULT_PROFILE_ID,
  name: "Default",
};

function normalizeProfile(profile: AppProfile): AppProfile | null {
  const id = profile.id.trim();
  const name = profile.name.trim();
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    ...(profile.accentColor?.trim() ? { accentColor: profile.accentColor.trim() } : {}),
  };
}

export function getAppProfiles(
  settings: Pick<ClientSettings, "profiles">,
): ReadonlyArray<AppProfile> {
  const byId = new Map<string, AppProfile>();
  byId.set(DEFAULT_PROFILE.id, DEFAULT_PROFILE);
  for (const rawProfile of settings.profiles ?? []) {
    const profile = normalizeProfile(rawProfile);
    if (!profile) {
      continue;
    }
    byId.set(profile.id, profile);
  }
  return [...byId.values()];
}

export function getActiveProfileId(
  settings: Pick<ClientSettings, "activeProfileId" | "profiles">,
): string {
  const profiles = getAppProfiles(settings);
  const activeProfileId = settings.activeProfileId.trim();
  if (profiles.some((profile) => profile.id === activeProfileId)) {
    return activeProfileId;
  }
  return profiles[0]?.id ?? DEFAULT_PROFILE_ID;
}

export function getActiveProfile(
  settings: Pick<ClientSettings, "activeProfileId" | "profiles">,
): AppProfile {
  const activeProfileId = getActiveProfileId(settings);
  return (
    getAppProfiles(settings).find((profile) => profile.id === activeProfileId) ?? DEFAULT_PROFILE
  );
}

export function makeNextProfileName(settings: Pick<ClientSettings, "profiles">): string {
  const existingNames = new Set(getAppProfiles(settings).map((profile) => profile.name));
  for (let index = 2; index < 1000; index += 1) {
    const name = `Profile ${index}`;
    if (!existingNames.has(name)) {
      return name;
    }
  }
  return `Profile ${Date.now().toString(36)}`;
}

export function makeProfileId(name: string, existingIds: ReadonlySet<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile";
  if (!existingIds.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function createProfilePatch(
  settings: Pick<ClientSettings, "profiles">,
  name = makeNextProfileName(settings),
): ClientSettingsPatch {
  const profiles = getAppProfiles(settings);
  const id = makeProfileId(name, new Set(profiles.map((profile) => profile.id)));
  const profile: AppProfile = { id, name: name.trim() || "Profile" };
  return {
    activeProfileId: profile.id,
    profiles: [...profiles, profile],
  };
}

export function projectProfileKey(
  project: Pick<Project, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function projectProfileKeyFromPath(environmentId: string, workspaceRoot: string): string {
  return derivePhysicalProjectKeyFromPath(environmentId, workspaceRoot);
}

function assignedProfileIdForProject(
  settings: Pick<ClientSettings, "projectProfileAssignments">,
  projectKey: string,
): string {
  return settings.projectProfileAssignments?.[projectKey] ?? DEFAULT_PROFILE_ID;
}

export function isProjectVisibleInActiveProfile(
  project: Pick<Project, "environmentId" | "workspaceRoot">,
  settings: Pick<ClientSettings, "activeProfileId" | "profiles" | "projectProfileAssignments">,
): boolean {
  return (
    assignedProfileIdForProject(settings, projectProfileKey(project)) ===
    getActiveProfileId(settings)
  );
}

export function filterProjectsForActiveProfile(
  projects: ReadonlyArray<Project>,
  settings: Pick<ClientSettings, "activeProfileId" | "profiles" | "projectProfileAssignments">,
): ReadonlyArray<Project> {
  return projects.filter((project) => isProjectVisibleInActiveProfile(project, settings));
}

export function filterThreadsForActiveProfile(
  threads: ReadonlyArray<SidebarThreadSummary>,
  projects: ReadonlyArray<Project>,
  settings: Pick<ClientSettings, "activeProfileId" | "profiles" | "projectProfileAssignments">,
): ReadonlyArray<SidebarThreadSummary> {
  const visibleProjectRefs = new Set(
    filterProjectsForActiveProfile(projects, settings).map((project) =>
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    ),
  );
  return threads.filter((thread) =>
    visibleProjectRefs.has(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    ),
  );
}

export function assignProjectKeysToProfilePatch(
  settings: Pick<ClientSettings, "projectProfileAssignments">,
  projectKeys: ReadonlyArray<string>,
  profileId: string,
): ClientSettingsPatch {
  const nextAssignments = { ...settings.projectProfileAssignments };
  for (const projectKey of projectKeys) {
    nextAssignments[projectKey] = profileId;
  }
  return { projectProfileAssignments: nextAssignments };
}

export function assignProjectsToProfilePatch(
  settings: Pick<ClientSettings, "projectProfileAssignments">,
  projects: ReadonlyArray<Pick<Project, "environmentId" | "workspaceRoot">>,
  profileId: string,
): ClientSettingsPatch {
  return assignProjectKeysToProfilePatch(
    settings,
    projects.map((project) => projectProfileKey(project)),
    profileId,
  );
}

export function providerScopeLabel(
  settings: Pick<ClientSettings, "profiles" | "providerInstanceProfileAssignments">,
  instanceId: ProviderInstanceId,
): string {
  const profileId = settings.providerInstanceProfileAssignments?.[instanceId];
  if (!profileId) {
    return "All profiles";
  }
  return getAppProfiles(settings).find((profile) => profile.id === profileId)?.name ?? profileId;
}

export function isProviderInstanceVisibleInActiveProfile(
  entry: Pick<ProviderInstanceEntry, "instanceId">,
  settings: Pick<
    ClientSettings,
    "activeProfileId" | "profiles" | "providerInstanceProfileAssignments"
  >,
): boolean {
  const assignedProfileId = settings.providerInstanceProfileAssignments?.[entry.instanceId];
  return !assignedProfileId || assignedProfileId === getActiveProfileId(settings);
}

export function filterProviderInstancesForActiveProfile(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<
    ClientSettings,
    "activeProfileId" | "profiles" | "providerInstanceProfileAssignments"
  >,
): ReadonlyArray<ProviderInstanceEntry> {
  return entries.filter((entry) => isProviderInstanceVisibleInActiveProfile(entry, settings));
}

export function assignProviderInstanceToProfilePatch(
  settings: Pick<ClientSettings, "providerInstanceProfileAssignments">,
  instanceId: ProviderInstanceId,
  profileId: string | null,
): ClientSettingsPatch {
  const nextAssignments = { ...settings.providerInstanceProfileAssignments };
  if (profileId) {
    nextAssignments[instanceId] = profileId;
  } else {
    delete nextAssignments[instanceId];
  }
  return { providerInstanceProfileAssignments: nextAssignments };
}
