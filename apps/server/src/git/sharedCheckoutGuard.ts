import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

type CheckoutThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "worktreePath" | "activityRunStatus"
>;

/** Threads with an active run whose working directory is one of `checkoutPaths`. */
export function busyThreadsInCheckout<T extends CheckoutThread>(input: {
  readonly checkoutPaths: ReadonlyArray<string>;
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  const checkoutIds = new Set(input.checkoutPaths.map(checkoutIdentity));
  return input.threads.filter(
    (thread) =>
      (thread.activityRunStatus ?? null) !== null &&
      (thread.worktreePath === null
        ? input.projectIds.has(thread.projectId)
        : checkoutIds.has(checkoutIdentity(thread.worktreePath))),
  );
}

function checkoutIdentity(path: string): string {
  const normalized = normalizeProjectPathForComparison(path);
  return isWindowsAbsolutePath(normalized) ? normalized.replaceAll("\\", "/") : normalized;
}

function describeBusyCheckout(titles: ReadonlyArray<string>): string {
  const quoted = titles.map((title) => `'${title}'`);
  const names =
    quoted.length <= 2
      ? quoted.join(" and ")
      : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
  return `${names} ${quoted.length === 1 ? "is" : "are"} still working in this checkout. Wait for ${quoted.length === 1 ? "it" : "them"} to finish, or use a worktree for a separate branch.`;
}

/** Switching a shared checkout's ref moves every thread working in it, mid-turn included. */
export const assertCheckoutIdle = Effect.fn("sharedCheckoutGuard.assertCheckoutIdle")(function* (
  operation: string,
  cwd: string,
) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
  // `git checkout` from a subdirectory moves the whole checkout; records may hold either spelling.
  const root = yield* gitWorkflow.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => null));
  const checkoutPaths = [...new Set([cwd, ...(root === null ? [] : [root])])];
  const checkoutIds = new Set(checkoutPaths.map(checkoutIdentity));
  const rootId = root === null ? null : checkoutIdentity(root);
  const rootPrefix = rootId === null ? null : rootId.endsWith("/") ? rootId : rootId + "/";
  const projects = yield* projectService.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects),
    Effect.orElseSucceed(() => []),
  );
  // A project rooted inside the checkout shares it, as in a monorepo package, unless it is its
  // own repository nested there.
  const nested = yield* Effect.forEach(
    projects.filter(({ workspaceRoot }) => {
      const id = checkoutIdentity(workspaceRoot);
      return rootPrefix !== null && !checkoutIds.has(id) && id.startsWith(rootPrefix);
    }),
    (project) =>
      gitWorkflow.repositoryRoot(project.workspaceRoot).pipe(
        Effect.map((projectRoot) =>
          projectRoot !== null && checkoutIdentity(projectRoot) === rootId ? [project] : [],
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: "unbounded" },
  );
  const sharingTrackedFolders = yield* Effect.forEach(
    projects.filter(({ workspaceRoot, trackedFolders }) => {
      const id = checkoutIdentity(workspaceRoot);
      return (
        rootId !== null &&
        !checkoutIds.has(id) &&
        (rootId.startsWith(id.endsWith("/") ? id : id + "/") || (trackedFolders?.length ?? 0) > 0)
      );
    }),
    (project) =>
      workspaceFolders.forThread({ projectId: project.id, worktreePath: null }).pipe(
        Effect.flatMap(({ folders }) =>
          Effect.findFirst(folders, (folder) =>
            gitWorkflow.repositoryRoot(folder.path).pipe(
              Effect.map(
                (folderRoot) => folderRoot !== null && checkoutIdentity(folderRoot) === rootId,
              ),
              Effect.orElseSucceed(() => false),
            ),
          ),
        ),
        Effect.map((match) => (match._tag === "Some" ? [project] : [])),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 4 },
  );
  const projectIds = new Set(
    [
      ...projects.filter(({ workspaceRoot }) => checkoutIds.has(checkoutIdentity(workspaceRoot))),
      ...nested.flat(),
      ...sharingTrackedFolders.flat(),
    ].map(({ id }) => id),
  );
  // Archiving does not stop a run. Keep successful lookups so a busy thread can still be named.
  const snapshots = yield* Effect.forEach(
    [
      ...checkoutPaths.map((worktreePath) => threadManagement.getShellSnapshot({ worktreePath })),
      ...[...projectIds].map((projectId) => threadManagement.getShellSnapshot({ projectId })),
    ],
    (snapshot) => snapshot.pipe(Effect.orElseSucceed(() => null)),
    { concurrency: "unbounded" },
  );
  const busy = busyThreadsInCheckout({
    checkoutPaths,
    projectIds,
    threads: snapshots.flatMap((snapshot) =>
      snapshot ? [...snapshot.threads, ...snapshot.archivedThreads] : [],
    ),
  });
  const titles = [...new Map(busy.map((thread) => [thread.id, thread.title])).values()];
  if (titles.length === 0 && !snapshots.includes(null)) return;
  return yield* new GitCommandError({
    operation,
    command: "git checkout",
    cwd,
    detail:
      titles.length > 0
        ? describeBusyCheckout(titles)
        : "Could not verify that this checkout is idle. Try again or use a separate worktree.",
  });
});
