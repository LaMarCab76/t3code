// @effect-diagnostics globalDate:off -- These tests exercise device-local weekday and overnight boundaries.
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, WorkspaceProfile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  activeWorkspaceProfile,
  addWorkspaceProfileProject,
  filterWorkspaceProfileProjects,
  filterWorkspaceProfileThreads,
  resolveSidebarViewMode,
  findWorkspaceProfileScheduleIssue,
  resolveInitialWorkspaceProfileId,
  removeWorkspaceProfile,
  workspaceProfileScheduleIssueMessage,
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

describe("profile startup schedules", () => {
  const work = { ...profile, schedules: [{ days: [1], start: "09:00", end: "17:00" }] };
  const personal = { ...profile, id: "personal", name: "Personal" };
  const settings = {
    workspaceProfiles: [work, personal],
    activeWorkspaceProfileId: "personal",
    defaultWorkspaceProfileId: "personal",
  };
  const monday = (hours: number, minutes = 0) => new Date(2026, 8, 28, hours, minutes);

  it("uses the local weekday and gives schedules priority only within their half-open interval", () => {
    expect(resolveInitialWorkspaceProfileId(settings, monday(8, 59))).toBe("personal");
    expect(resolveInitialWorkspaceProfileId(settings, monday(9))).toBe("work");
    expect(resolveInitialWorkspaceProfileId(settings, monday(16, 59))).toBe("work");
    expect(resolveInitialWorkspaceProfileId(settings, monday(17))).toBe("personal");
    expect(resolveInitialWorkspaceProfileId(settings, new Date(2026, 8, 29, 10))).toBe("personal");
  });

  it("preserves last used for old settings and supports All and missing defaults", () => {
    const old = { workspaceProfiles: [personal], activeWorkspaceProfileId: "personal" };
    expect(resolveInitialWorkspaceProfileId(old, monday(10))).toBe("personal");
    expect(
      resolveInitialWorkspaceProfileId({ ...old, defaultWorkspaceProfileId: null }, monday(10)),
    ).toBeNull();
    expect(
      resolveInitialWorkspaceProfileId(
        { ...old, defaultWorkspaceProfileId: "deleted" },
        monday(10),
      ),
    ).toBeNull();
    expect(
      resolveInitialWorkspaceProfileId({ ...old, activeWorkspaceProfileId: "deleted" }, monday(10)),
    ).toBeNull();
  });

  it("attributes overnight hours to the preceding start day, across the weekly boundary", () => {
    const overnight = { ...work, schedules: [{ days: [6], start: "22:00", end: "06:00" }] };
    const value = { ...settings, workspaceProfiles: [overnight, personal] };
    expect(resolveInitialWorkspaceProfileId(value, new Date(2026, 9, 3, 22))).toBe("work");
    expect(resolveInitialWorkspaceProfileId(value, new Date(2026, 9, 4, 5, 59))).toBe("work");
    expect(resolveInitialWorkspaceProfileId(value, new Date(2026, 9, 4, 6))).toBe("personal");
    expect(resolveInitialWorkspaceProfileId(value, new Date(2026, 9, 4, 23))).toBe("personal");
  });

  it("allows touching schedules and detects overlapping profiles with the conflicting rule", () => {
    const second = { ...personal, schedules: [{ days: [1], start: "17:00", end: "22:00" }] };
    expect(findWorkspaceProfileScheduleIssue([work, second])).toBeNull();
    expect(
      findWorkspaceProfileScheduleIssue([
        work,
        { ...second, schedules: [{ days: [1], start: "16:59", end: "22:00" }] },
      ]),
    ).toMatchObject({
      profileId: "personal",
      reason: "overlap",
      conflictingProfileId: "work",
      conflictingScheduleIndex: 0,
    });
    const overlapping = [
      work,
      { ...second, schedules: [{ days: [1], start: "16:59", end: "22:00" }] },
    ];
    const issue = findWorkspaceProfileScheduleIssue(overlapping);
    expect(issue).not.toBeNull();
    const message = workspaceProfileScheduleIssueMessage(issue!, overlapping);
    expect(message).toContain("Work");
    expect(message).toContain("Personal");
  });

  it("detects overnight conflicts on the next day and after week wrap", () => {
    for (const day of [1, 6]) {
      const overnight = { ...work, schedules: [{ days: [day], start: "22:00", end: "06:00" }] };
      const early = {
        ...personal,
        schedules: [{ days: [(day + 1) % 7], start: "05:00", end: "07:00" }],
      };
      expect(findWorkspaceProfileScheduleIssue([overnight, early])?.reason).toBe("overlap");
    }
  });

  it.each([
    [{ days: [], start: "09:00", end: "17:00" }, "days"],
    [{ days: [7], start: "09:00", end: "17:00" }, "days"],
    [{ days: [1], start: "24:00", end: "17:00" }, "time"],
    [{ days: [1], start: "09:00", end: "09:00" }, "duration"],
  ] as const)("rejects invalid schedule %j", (schedule, reason) => {
    expect(findWorkspaceProfileScheduleIssue([{ ...work, schedules: [schedule] }])?.reason).toBe(
      reason,
    );
  });

  it("removes the profile, its schedules and selected defaults without altering shared projects", () => {
    const patch = removeWorkspaceProfile(
      { ...settings, activeWorkspaceProfileId: "work", defaultWorkspaceProfileId: "work" },
      "work",
    );
    expect(patch).toEqual({
      workspaceProfiles: [personal],
      activeWorkspaceProfileId: null,
      defaultWorkspaceProfileId: null,
    });
    expect(patch.workspaceProfiles[0]?.projects).toBe(personal.projects);
  });
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
