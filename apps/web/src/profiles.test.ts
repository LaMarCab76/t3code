import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  assignProjectKeysToProfilePatch,
  filterProjectsForActiveProfile,
  filterProviderInstancesForActiveProfile,
  filterThreadsForActiveProfile,
  getActiveProfile,
  projectProfileKey,
} from "./profiles";
import type { Project, SidebarThreadSummary } from "./types";
import type { ProviderInstanceEntry } from "./providerInstances";

const env = EnvironmentId.make("local");

function project(input: { id: string; cwd: string; title?: string }): Project {
  return {
    environmentId: env,
    id: ProjectId.make(input.id),
    title: input.title ?? input.id,
    workspaceRoot: input.cwd,
    defaultModelSelection: null,
    repositoryIdentity: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function thread(input: { id: string; projectId: string }): SidebarThreadSummary {
  return {
    environmentId: env,
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId),
    title: input.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function settings(patch: Partial<ClientSettings> = {}): ClientSettings {
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    ...patch,
  };
}

describe("profiles", () => {
  it("resolves the built-in default profile", () => {
    expect(getActiveProfile(DEFAULT_CLIENT_SETTINGS)).toEqual({
      id: "default",
      name: "Default",
    });
  });

  it("filters projects by active profile assignment", () => {
    const alpha = project({ id: "alpha", cwd: "/repo/alpha" });
    const beta = project({ id: "beta", cwd: "/repo/beta" });
    const profileSettings = settings({
      activeProfileId: "work",
      profiles: [
        { id: "default", name: "Default" },
        { id: "work", name: "Work" },
      ],
      projectProfileAssignments: {
        [projectProfileKey(beta)]: "work",
      },
    });

    expect(filterProjectsForActiveProfile([alpha, beta], profileSettings)).toEqual([beta]);
  });

  it("defaults unassigned projects to the default profile", () => {
    const alpha = project({ id: "alpha", cwd: "/repo/alpha" });
    const profileSettings = settings({
      activeProfileId: "default",
      profiles: [
        { id: "default", name: "Default" },
        { id: "work", name: "Work" },
      ],
    });

    expect(filterProjectsForActiveProfile([alpha], profileSettings)).toEqual([alpha]);
  });

  it("filters threads through their visible project", () => {
    const alpha = project({ id: "alpha", cwd: "/repo/alpha" });
    const beta = project({ id: "beta", cwd: "/repo/beta" });
    const alphaThread = thread({ id: "thread-alpha", projectId: "alpha" });
    const betaThread = thread({ id: "thread-beta", projectId: "beta" });
    const profileSettings = settings({
      activeProfileId: "work",
      profiles: [
        { id: "default", name: "Default" },
        { id: "work", name: "Work" },
      ],
      projectProfileAssignments: {
        [projectProfileKey(beta)]: "work",
      },
    });

    expect(
      filterThreadsForActiveProfile([alphaThread, betaThread], [alpha, beta], profileSettings),
    ).toEqual([betaThread]);
  });

  it("keeps provider instances global until explicitly scoped", () => {
    const codex = { instanceId: ProviderInstanceId.make("codex") } as ProviderInstanceEntry;
    const workCodex = {
      instanceId: ProviderInstanceId.make("codex_work"),
    } as ProviderInstanceEntry;
    const profileSettings = settings({
      activeProfileId: "work",
      profiles: [
        { id: "default", name: "Default" },
        { id: "work", name: "Work" },
      ],
      providerInstanceProfileAssignments: {
        [ProviderInstanceId.make("codex_work")]: "work",
      },
    });

    expect(filterProviderInstancesForActiveProfile([codex, workCodex], profileSettings)).toEqual([
      codex,
      workCodex,
    ]);
  });

  it("builds project assignment patches", () => {
    expect(
      assignProjectKeysToProfilePatch(DEFAULT_CLIENT_SETTINGS, ["local:/repo"], "work"),
    ).toEqual({
      projectProfileAssignments: {
        "local:/repo": "work",
      },
    });
  });
});
