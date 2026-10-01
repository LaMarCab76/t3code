// @effect-diagnostics globalDate:off -- Device-local schedules use wall-clock calendar time and Intl labels outside an Effect runtime.
import type {
  ScopedProjectRef,
  SidebarViewMode,
  WorkspaceProfile,
  WorkspaceProfileSchedule,
} from "@t3tools/contracts";

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

export const WORKSPACE_PROFILE_DAYS = [
  [1, "Monday", "Mon"],
  [2, "Tuesday", "Tue"],
  [3, "Wednesday", "Wed"],
  [4, "Thursday", "Thu"],
  [5, "Friday", "Fri"],
  [6, "Saturday", "Sat"],
  [0, "Sunday", "Sun"],
] as const;

function timeMinutes(time: string): number | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function scheduleSegments(schedule: WorkspaceProfileSchedule) {
  const start = timeMinutes(schedule.start);
  const end = timeMinutes(schedule.end);
  if (start === null || end === null || start === end) return [];
  return [...new Set(schedule.days)].flatMap((day) => {
    if (!Number.isInteger(day) || day < 0 || day > 6) return [];
    const from = day * MINUTES_PER_DAY + start;
    const to = day * MINUTES_PER_DAY + end + (end < start ? MINUTES_PER_DAY : 0);
    return to > MINUTES_PER_WEEK
      ? [
          { from, to: MINUTES_PER_WEEK },
          { from: 0, to: to - MINUTES_PER_WEEK },
        ]
      : [{ from, to }];
  });
}

export interface WorkspaceProfileScheduleIssue {
  readonly profileId: string;
  readonly scheduleIndex: number;
  readonly reason: "days" | "time" | "duration" | "overlap";
  readonly conflictingProfileId?: string;
  readonly conflictingScheduleIndex?: number;
}

/** Normalizes overnight intervals into a weekly clock, including Saturday to Sunday. */
export function findWorkspaceProfileScheduleIssue(
  profiles: readonly WorkspaceProfile[],
): WorkspaceProfileScheduleIssue | null {
  const intervals: Array<{ from: number; to: number; profileId: string; scheduleIndex: number }> =
    [];
  for (const profile of profiles) {
    for (const [scheduleIndex, schedule] of (profile.schedules ?? []).entries()) {
      const issue = { profileId: profile.id, scheduleIndex };
      if (
        !schedule.days.length ||
        schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      )
        return { ...issue, reason: "days" };
      if (timeMinutes(schedule.start) === null || timeMinutes(schedule.end) === null)
        return { ...issue, reason: "time" };
      if (schedule.start === schedule.end) return { ...issue, reason: "duration" };
      for (const interval of scheduleSegments(schedule)) {
        const conflict = intervals.find(
          (other) => interval.from < other.to && other.from < interval.to,
        );
        if (conflict)
          return {
            ...issue,
            reason: "overlap",
            conflictingProfileId: conflict.profileId,
            conflictingScheduleIndex: conflict.scheduleIndex,
          };
        intervals.push({ ...interval, ...issue });
      }
    }
  }
  return null;
}

/** Called at client initialization only; the active selection owns the rest of the session. */
export function resolveInitialWorkspaceProfileId(
  settings: {
    workspaceProfiles?: readonly WorkspaceProfile[];
    activeWorkspaceProfileId?: string | null;
    defaultWorkspaceProfileId?: string | null;
  },
  now: Date,
): string | null {
  const profiles = settings.workspaceProfiles ?? [];
  const minute = now.getDay() * MINUTES_PER_DAY + now.getHours() * 60 + now.getMinutes();
  const scheduled = profiles.find((profile) =>
    (profile.schedules ?? []).some((schedule) =>
      scheduleSegments(schedule).some(({ from, to }) => minute >= from && minute < to),
    ),
  );
  if (scheduled) return scheduled.id;
  const id =
    settings.defaultWorkspaceProfileId === undefined
      ? settings.activeWorkspaceProfileId
      : settings.defaultWorkspaceProfileId;
  return activeWorkspaceProfile(profiles, id)?.id ?? null;
}

export function removeWorkspaceProfile(
  settings: {
    workspaceProfiles?: readonly WorkspaceProfile[];
    activeWorkspaceProfileId?: string | null;
    defaultWorkspaceProfileId?: string | null;
  },
  id: string,
) {
  return {
    workspaceProfiles: (settings.workspaceProfiles ?? []).filter((profile) => profile.id !== id),
    ...(settings.activeWorkspaceProfileId === id ? { activeWorkspaceProfileId: null } : {}),
    ...(settings.defaultWorkspaceProfileId === id ? { defaultWorkspaceProfileId: null } : {}),
  };
}

export function formatWorkspaceProfileSchedule(schedule: WorkspaceProfileSchedule): string {
  const days = WORKSPACE_PROFILE_DAYS.filter(([day]) => schedule.days.includes(day))
    .map(([, , name]) => name)
    .join(", ");
  const format = (time: string) => {
    const minutes = timeMinutes(time);
    return minutes === null
      ? time
      : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
          new Date(2000, 0, 2, Math.floor(minutes / 60), minutes % 60),
        );
  };
  return `${days} · ${format(schedule.start)} – ${format(schedule.end)}${schedule.end < schedule.start ? " (next day)" : ""}`;
}

export function workspaceProfileScheduleIssueMessage(
  issue: WorkspaceProfileScheduleIssue,
  profiles: readonly WorkspaceProfile[],
) {
  if (issue.reason === "days") return "Choose at least one day for each schedule.";
  if (issue.reason === "time") return "Enter a valid start and end time for each schedule.";
  if (issue.reason === "duration") return "Start and end times must be different.";
  const conflict = profiles.find((profile) => profile.id === issue.conflictingProfileId);
  const schedule = conflict?.schedules?.[issue.conflictingScheduleIndex ?? -1];
  const owner = profiles.find((profile) => profile.id === issue.profileId);
  const ownSchedule = owner?.schedules?.[issue.scheduleIndex];
  return `${owner?.name ?? "This profile"}${ownSchedule ? ` (${formatWorkspaceProfileSchedule(ownSchedule)})` : ""} overlaps with ${conflict?.name ?? "another profile"}${schedule ? ` (${formatWorkspaceProfileSchedule(schedule)})` : ""}. Change the days or times.`;
}

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

export const WORKSPACE_PROFILE_EMOJIS = [
  ["💼", "Briefcase"],
  ["🏠", "Home"],
  ["👤", "Person"],
  ["👥", "People"],
  ["🧑‍💻", "Developer"],
  ["🎯", "Target"],
  ["🚀", "Rocket"],
  ["⭐", "Star"],
  ["💡", "Idea"],
  ["🧠", "Brain"],
  ["📚", "Books"],
  ["📝", "Notes"],
  ["📊", "Chart"],
  ["📁", "Folder"],
  ["🗂️", "Files"],
  ["🛠️", "Tools"],
  ["⚙️", "Settings"],
  ["💻", "Laptop"],
  ["⌨️", "Keyboard"],
  ["📱", "Phone"],
  ["🎨", "Art"],
  ["📷", "Camera"],
  ["🎬", "Film"],
  ["🎵", "Music"],
  ["🎮", "Games"],
  ["🧩", "Puzzle"],
  ["🔬", "Science"],
  ["🔒", "Lock"],
  ["🔑", "Key"],
  ["🧭", "Compass"],
  ["🌐", "Globe"],
  ["🌎", "Earth"],
  ["☀️", "Sun"],
  ["🌙", "Moon"],
  ["⚡", "Lightning"],
  ["🔥", "Fire"],
  ["🌈", "Rainbow"],
  ["☁️", "Cloud"],
  ["🌊", "Wave"],
  ["🏔️", "Mountain"],
  ["🌳", "Tree"],
  ["🌱", "Seedling"],
  ["🌵", "Cactus"],
  ["🌸", "Flower"],
  ["🐱", "Cat"],
  ["🐶", "Dog"],
  ["🦊", "Fox"],
  ["🐻", "Bear"],
  ["🐼", "Panda"],
  ["🦁", "Lion"],
  ["🦉", "Owl"],
  ["🦋", "Butterfly"],
  ["🐝", "Bee"],
  ["🐙", "Octopus"],
  ["🐢", "Turtle"],
  ["🦄", "Unicorn"],
  ["☕", "Coffee"],
  ["🍕", "Pizza"],
  ["🍎", "Apple"],
  ["⚽", "Football"],
  ["🏀", "Basketball"],
  ["🏆", "Trophy"],
  ["🎒", "Backpack"],
  ["✈️", "Airplane"],
] as const;

export const WORKSPACE_PROFILE_COLORS = [
  ["#64748b", "Slate"],
  ["#6b7280", "Gray"],
  ["#ef4444", "Red"],
  ["#f97316", "Orange"],
  ["#f59e0b", "Amber"],
  ["#eab308", "Yellow"],
  ["#84cc16", "Lime"],
  ["#22c55e", "Green"],
  ["#10b981", "Emerald"],
  ["#14b8a6", "Teal"],
  ["#06b6d4", "Cyan"],
  ["#3b82f6", "Blue"],
  ["#6366f1", "Indigo"],
  ["#8b5cf6", "Violet"],
  ["#d946ef", "Fuchsia"],
  ["#ec4899", "Pink"],
] as const;
