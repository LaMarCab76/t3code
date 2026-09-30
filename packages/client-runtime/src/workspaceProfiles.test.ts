import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, WorkspaceProfile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  activeWorkspaceProfile,
  addWorkspaceProfileProject,
  filterWorkspaceProfileProjects,
  filterWorkspaceProfileThreads,
  resolveSidebarViewMode,
} from "./workspaceProfiles.ts";

const environmentId = EnvironmentId.make("local");
const otherEnvironmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const project = { environmentId, projectId };
const profile = Schema.decodeSync(WorkspaceProfile)({
  id: "work",
  name: "Work",
  emoji: "💼",
  color: "#336699",
  projects: [project],
});

describe("workspace profiles", () => {
  it("filters by environment and project while sharing the original records", () => {
    const projects = [
      { environmentId, id: projectId },
      { environmentId: otherEnvironmentId, id: projectId },
    ];
    const threads = [project, { environmentId: otherEnvironmentId, projectId }];
    expect(filterWorkspaceProfileProjects(projects, profile)).toEqual([projects[0]]);
    expect(filterWorkspaceProfileThreads(threads, profile)).toEqual([threads[0]]);
    expect(filterWorkspaceProfileThreads(threads, null)).toBe(threads);
    expect(filterWorkspaceProfileThreads(threads, profile)[0]).toBe(threads[0]);
  });
  it("allows shared membership, adds new projects once, and falls back to All after deletion", () => {
    const profiles = [profile, { ...profile, id: "personal" }];
    expect(addWorkspaceProfileProject(profiles, "personal", project)[1]).toBe(profiles[1]);
    const next = addWorkspaceProfileProject(profiles, "work", {
      environmentId: otherEnvironmentId,
      projectId,
    });
    expect(next[0]?.projects).toHaveLength(2);
    expect(next[1]).toBe(profiles[1]);
    expect(activeWorkspaceProfile(profiles, "missing")).toBeNull();
  });
  it("preserves the previous sidebar choice until a view is selected", () => {
    expect(resolveSidebarViewMode({})).toBe("status");
    expect(resolveSidebarViewMode({ legacySidebarEnabled: true })).toBe("projects");
    expect(
      resolveSidebarViewMode({ sidebarViewMode: "combined", legacySidebarEnabled: true }),
    ).toBe("combined");
  });
});
