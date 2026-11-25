import { PullRequestOperationError } from "@t3tools/contracts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { canonicalRepositoryPath, parseGitRemoteRepository } from "@t3tools/shared/git";
import type { ProviderChangeRequestDetail } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { TaskFolderStore } from "../workspace/TaskFolderStore.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import type { SupportedProject } from "./PullRequestService.ts";

type ChangeRequest = Pick<
  ProviderChangeRequestDetail,
  "headBranch" | "baseBranch" | "headSha" | "headRepositoryNameWithOwner" | "state"
>;

export interface Target {
  readonly branch: string;
  readonly sha: string;
  readonly remote: string;
  readonly url: string;
}

const fail = (detail: string) =>
  new PullRequestOperationError({ operation: "mergeAndDeleteBranch", detail });

const fullCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function projectLocator(project: SupportedProject, request: ChangeRequest) {
  const identity = project.project.repositoryIdentity;
  if (
    !identity?.locator ||
    sourceControlDefinitions.canonicalRepositoryKey(identity.canonicalKey) !== project.remote ||
    request.state !== "open" ||
    request.headBranch === request.baseBranch ||
    request.headRepositoryNameWithOwner === null ||
    !request.headSha ||
    !fullCommit.test(request.headSha)
  ) {
    return null;
  }
  return identity.locator;
}

export const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver;
  const tasks = yield* TaskFolderStore;
  const threads = yield* ProjectionStoreV2;
  const isManagedWorktree = yield* makeIsManagedWorktreePath;

  const execute = (cwd: string, args: readonly string[]) =>
    git.execute({
      operation: "mergeAndDeleteBranch",
      cwd,
      args,
      timeoutMs: 30_000,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });

  const remoteState = Effect.fn("PostMergeBranchCleanup.remoteState")(function* (
    cwd: string,
    url: string,
    ref: string,
  ) {
    const { stdout } = yield* execute(cwd, ["ls-remote", "--symref", "--", url, "HEAD", ref]);
    const entries = stdout
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"));
    return {
      defaultRef: entries
        .find(([value, name]) => name === "HEAD" && value?.startsWith("ref: refs/heads/"))?.[0]
        ?.slice(5),
      sha: entries.find(([, name]) => name === ref)?.[0]?.toLowerCase(),
    };
  });

  const prepare = Effect.fn("PostMergeBranchCleanup.prepare")(function* (
    project: SupportedProject,
    request: ChangeRequest,
  ) {
    const locator = projectLocator(project, request);
    if (locator === null || !request.headSha) {
      return yield* fail("This change request does not identify a source branch on this project.");
    }
    const cwd = project.project.workspaceRoot;
    const branch = request.headBranch;
    const ref = "refs/heads/" + branch;
    const sha = request.headSha.toLowerCase();
    yield* execute(cwd, ["check-ref-format", ref]).pipe(
      Effect.mapError(() => fail("The host returned an invalid source branch name.")),
    );

    const checkoutRemote = parseGitRemoteRepository(locator.remoteUrl);
    if (checkoutRemote === null) {
      return yield* fail("Could not identify the Git remote of this checkout.");
    }
    const headRepository = request.headRepositoryNameWithOwner;
    const expectedPath = headRepository
      ? canonicalRepositoryPath(headRepository)
      : checkoutRemote.path;
    const remotes =
      headRepository &&
      expectedPath !== checkoutRemote.path &&
      expectedPath !== canonicalRepositoryPath(project.repository)
        ? (yield* execute(cwd, ["remote"]).pipe(
            Effect.mapError(() => fail("Could not read the Git remotes of this checkout.")),
          )).stdout
            .trim()
            .split("\n")
        : [locator.remoteName];

    for (const remote of remotes) {
      if (remote.length === 0) continue;
      const push = yield* execute(cwd, ["remote", "get-url", "--push", "--all", "--", remote]).pipe(
        Effect.option,
      );
      if (Option.isNone(push)) continue;
      const urls = push.value.stdout.trimEnd().split("\n");
      const url = urls[0];
      if (url === undefined || urls.length !== 1) continue;
      const destination = parseGitRemoteRepository(url);
      if (
        destination === null ||
        parseGitRemoteHost(url)?.host !== parseGitRemoteHost(locator.remoteUrl)?.host ||
        destination.path !==
          (remote === locator.remoteName &&
          expectedPath === canonicalRepositoryPath(project.repository)
            ? checkoutRemote.path
            : expectedPath)
      )
        continue;

      const state = yield* remoteState(cwd, url, ref).pipe(
        Effect.mapError(() =>
          fail("Could not verify the source branch using the configured Git credentials."),
        ),
      );
      if (state.defaultRef === undefined || state.defaultRef === ref) {
        return yield* fail("The source repository's default branch must be verified and kept.");
      }
      if (state.sha !== sha) {
        return yield* fail(
          "The Git remote does not have the reviewed source commit. Refresh the change request first.",
        );
      }
      return { branch, sha, remote, url } satisfies Target;
    }
    return yield* fail(
      "Configure a Git push remote for the change request's source repository first.",
    );
  });

  const removeLocal = Effect.fn("PostMergeBranchCleanup.removeLocal")(function* (
    cwd: string,
    target: Target,
    ref: string,
  ) {
    const readLocal = () =>
      execute(cwd, [
        "for-each-ref",
        "--format=%(objectname)%00%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
        ref,
      ]).pipe(
        Effect.map(({ stdout }) =>
          stdout
            .split("\n")
            .map((line) => line.split("\0"))
            .find(([, name]) => name === ref),
        ),
      );
    const local = yield* readLocal();
    if (local === undefined) return;
    if (local[0] !== target.sha || (local[2] && (local[2] !== target.remote || local[3] !== ref))) {
      return yield* fail(
        "Remote branch removed. The local branch has different commits or tracks a different branch.",
      );
    }
    const listWorktrees = () =>
      execute(cwd, ["worktree", "list", "--porcelain", "-z"]).pipe(
        Effect.map(({ stdout }) => stdout.split("\0\0").map((record) => record.split("\0"))),
      );
    const records = yield* listWorktrees();
    const projectRoot = (yield* execute(cwd, ["rev-parse", "--show-toplevel"])).stdout.trimEnd();
    for (const [index, record] of records.entries()) {
      if (!record.includes("branch " + ref)) continue;
      const worktree = record[0]?.slice("worktree ".length);
      if (
        worktree === undefined ||
        !record.includes("HEAD " + target.sha) ||
        index === 0 ||
        worktree === projectRoot ||
        !(yield* isManagedWorktree(worktree))
      ) {
        return yield* fail(
          "Remote branch removed. The local branch is checked out outside a matching T3 Code worktree.",
        );
      }
      const active = yield* threads
        .getShellSnapshot({ worktreePath: worktree, activityOnly: true })
        .pipe(
          Effect.mapError(() =>
            fail("Remote branch removed. T3 Code could not verify whether the worktree is in use."),
          ),
        );
      if (active.threads.length > 0) {
        return yield* fail("Remote branch removed. An active thread is using the worktree.");
      }
      const taskError = () =>
        fail("Remote branch removed. T3 Code could not complete task folder cleanup.");
      const task = yield* tasks.findContaining(worktree).pipe(Effect.mapError(taskError));
      if (
        task !== null &&
        (task.root !== worktree || task.projectPath !== worktree || task.repositories.length > 0)
      ) {
        return yield* fail(
          "Remote branch removed. The worktree belongs to a task folder with its own layout or other repositories.",
        );
      }
      yield* git
        .removeWorktree({ cwd, path: worktree, force: false })
        .pipe(
          Effect.mapError(() =>
            fail(
              "Remote branch removed. The local branch and worktree were kept because Git refused to remove the worktree.",
            ),
          ),
        );
      if (task !== null) yield* tasks.remove(task.root).pipe(Effect.mapError(taskError));
    }
    if ((yield* listWorktrees()).some((record) => record.includes("branch " + ref))) {
      return yield* fail("Remote branch removed. The local branch is still checked out.");
    }
    // Delete only the reviewed object, including when the merge was squashed or rebased.
    yield* execute(cwd, ["update-ref", "--no-deref", "-d", ref, target.sha]);
  });

  const remove = Effect.fn("PostMergeBranchCleanup.remove")(function* (
    cwd: string,
    target: Target,
  ) {
    const ref = "refs/heads/" + target.branch;
    yield* Effect.gen(function* () {
      const configured = yield* execute(cwd, [
        "remote",
        "get-url",
        "--push",
        "--all",
        "--",
        target.remote,
      ]);
      if (configured.stdout.trimEnd() !== target.url) {
        return yield* fail(
          "The merge completed. The Git push remote changed, so the branches were kept.",
        );
      }
      const state = yield* remoteState(cwd, target.url, ref);
      if (state.defaultRef === undefined || state.defaultRef === ref) {
        return yield* fail(
          "The merge completed. The source repository's default branch could not be ruled out.",
        );
      }
      if (state.sha !== undefined) {
        if (state.sha !== target.sha) {
          return yield* fail(
            "The merge completed. The remote source branch received new commits and was kept.",
          );
        }
        yield* execute(cwd, [
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--no-mirror",
          "--no-recurse-submodules",
          "--force-with-lease=" + ref + ":" + target.sha,
          "--",
          target.remote,
          ":" + ref,
        ]);
        if ((yield* remoteState(cwd, target.url, ref)).sha !== undefined) {
          return yield* fail(
            "The merge completed. The source branch is present on the remote, so the local branch was kept.",
          );
        }
      }
    }).pipe(
      Effect.catchTags({
        GitCommandError: () =>
          fail(
            "The merge completed. Git could not confirm removal of the remote branch, so the local branch was kept.",
          ),
      }),
    );
    yield* removeLocal(cwd, target, ref).pipe(
      Effect.catchTags({
        GitCommandError: () =>
          fail(
            "Remote branch removed. Git could not complete cleanup of the local branch and worktree.",
          ),
      }),
      Effect.ensuring(git.invalidateRefs(cwd)),
    );
  });

  return {
    canPrepare: (project: SupportedProject, request: ChangeRequest) =>
      projectLocator(project, request) !== null,
    prepare,
    remove,
  };
});

export class PostMergeBranchCleanup extends Context.Service<
  PostMergeBranchCleanup,
  Effect.Success<typeof make>
>()("t3/pullRequest/PostMergeBranchCleanup") {}

export const layer = Layer.effect(PostMergeBranchCleanup, make);
