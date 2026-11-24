import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

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
  const fileSystem = yield* FileSystem.FileSystem;
  const identify = (path: string) =>
    fileSystem.realPath(path).pipe(
      Effect.orElseSucceed(() => path),
      Effect.map(checkoutIdentity),
    );
  const root = yield* gitWorkflow.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => null));
  const cwdId = yield* identify(cwd);
  const rootId = root === null ? null : yield* identify(root);
  const rootPrefix = rootId === null ? null : rootId.endsWith("/") ? rootId : rootId + "/";
  const failure = (detail: string) =>
    new GitCommandError({ operation, command: "git checkout", cwd, detail });
  const cannotVerify = () =>
    failure("Could not verify that this checkout is idle. Try again or use a separate worktree.");
  const snapshot = yield* threadManagement
    .getShellSnapshot({ activityOnly: true })
    .pipe(Effect.mapError(cannotVerify));
  // Archiving a thread does not stop its run.
  const threads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
    (thread) => (thread.activityRunStatus ?? null) !== null,
  );
  const localIds = new Set(
    threads.flatMap((thread) => (thread.worktreePath === null ? [thread.projectId] : [])),
  );
  const linkedThreads = new Map<string, ProjectId>();
  for (const thread of threads) {
    if (thread.worktreePath !== null) linkedThreads.set(thread.worktreePath, thread.projectId);
  }
  const projectList =
    localIds.size === 0
      ? []
      : (yield* projectService.snapshot.pipe(Effect.mapError(cannotVerify))).projects;
  const sameCheckout = (id: string) => id === cwdId || id === rootId;
  const sameRepository = Effect.fnUntraced(function* (path: string) {
    const actual = yield* gitWorkflow.repositoryRoot(path).pipe(Effect.mapError(cannotVerify));
    return actual !== null && sameCheckout(yield* identify(actual));
  });
  const reachesCheckout = Effect.fnUntraced(function* (
    projectId: ProjectId,
    worktreePath: string | null,
  ) {
    const { folders } = yield* workspaceFolders
      .forThread({ projectId, worktreePath })
      .pipe(Effect.mapError(cannotVerify));
    const match = yield* Effect.findFirst(folders, (folder) =>
      folder.isGitRepository ? sameRepository(folder.path) : Effect.succeed(false),
    );
    return Option.isSome(match);
  });
  const matchingProjects = yield* Effect.filter(
    projectList.filter((project) => localIds.has(project.id)),
    (project) =>
      Effect.gen(function* () {
        const id = yield* identify(project.workspaceRoot);
        if (sameCheckout(id)) return true;
        if (
          rootPrefix !== null &&
          id.startsWith(rootPrefix) &&
          (yield* sameRepository(project.workspaceRoot))
        )
          return true;
        return yield* reachesCheckout(project.id, null);
      }),
    { concurrency: 4 },
  );
  const matchingWorktrees = yield* Effect.filter(
    [...linkedThreads],
    ([path, projectId]) =>
      Effect.gen(function* () {
        if (sameCheckout(yield* identify(path))) return true;
        return yield* reachesCheckout(projectId, path);
      }),
    { concurrency: 4 },
  );
  const busy = busyThreadsInCheckout({
    checkoutPaths: matchingWorktrees.map(([path]) => path),
    projectIds: new Set(matchingProjects.map((project) => project.id)),
    threads,
  });
  if (busy.length === 0) return;
  const titles = [...new Map(busy.map((thread) => [thread.id, thread.title])).values()];
  return yield* failure(describeBusyCheckout(titles));
});
