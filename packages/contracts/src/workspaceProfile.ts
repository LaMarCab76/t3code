import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScopedProjectRef, ScopedThreadRef } from "./environment.ts";

/** Device-local presentation filters; membership never changes a project. */
export const WorkspaceProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
  projects: Schema.Array(ScopedProjectRef),
  lastThread: Schema.optionalKey(ScopedThreadRef),
});
export type WorkspaceProfile = typeof WorkspaceProfile.Type;

export const SidebarViewMode = Schema.Literals(["status", "projects", "combined"]);
export type SidebarViewMode = typeof SidebarViewMode.Type;
