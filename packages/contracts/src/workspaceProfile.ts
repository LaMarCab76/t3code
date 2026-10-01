import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScopedProjectRef, ScopedThreadRef } from "./environment.ts";

export const WorkspaceProfileSchedule = Schema.Struct({
  id: Schema.optionalKey(TrimmedNonEmptyString),
  days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
  start: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  end: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
});
export type WorkspaceProfileSchedule = typeof WorkspaceProfileSchedule.Type;

/** Device-local presentation filters; membership never changes a project. */
export const WorkspaceProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
  projects: Schema.Array(ScopedProjectRef),
  lastThread: Schema.optionalKey(ScopedThreadRef),
  schedules: Schema.optionalKey(Schema.Array(WorkspaceProfileSchedule)),
});
export type WorkspaceProfile = typeof WorkspaceProfile.Type;

export const SidebarViewMode = Schema.Literals(["status", "projects", "combined"]);
export type SidebarViewMode = typeof SidebarViewMode.Type;
