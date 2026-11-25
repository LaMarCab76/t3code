import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { TaskFolderStore } from "../workspace/TaskFolderStore.ts";
import * as Cleanup from "./PostMergeBranchCleanup.ts";

const layer = Cleanup.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-merge-delete-" })),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
      Layer.mock(ProjectionStoreV2)({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [],
          }),
      }),
      Layer.mock(TaskFolderStore)({ findContaining: () => Effect.succeed(null) }),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cleanup = yield* Cleanup.PostMergeBranchCleanup;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-merge-delete-repo-" });
  const url = path.join(repo, "remote.git");
  const cwd = path.join(repo, "checkout");
  const git = (...args: string[]) => driver.execute({ operation: "test.cleanup", cwd, args });
  yield* fs.makeDirectory(cwd);
  yield* git("init", "--bare", "--initial-branch=main", url);
  yield* git("init", "--initial-branch=main");
  yield* git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "base",
  );
  yield* git("remote", "add", "origin", url);
  yield* git("push", "origin", "main");
  yield* git("branch", "feature");
  yield* git("push", "-u", "origin", "feature");
  const sha = (yield* git("rev-parse", "feature")).stdout.trim();
  const target = { branch: "feature", remote: "origin", url, sha };
  const worktree = path.join(
    yield* fs.realPath(config.baseDir),
    "worktrees",
    path.basename(repo),
    "feature",
  );
  yield* git("worktree", "add", worktree, "feature");
  return {
    git,
    worktree,
    remove: cleanup.remove(cwd, target),
    target,
    cwd,
    cleanup,
    local: git("for-each-ref", "refs/heads/feature"),
    remote: git("ls-remote", "--heads", "origin", "refs/heads/feature"),
    worktrees: git("worktree", "list", "--porcelain"),
  };
});

it.layer(layer)("PostMergeBranchCleanup", (it) => {
  it.effect("removes the exact remote and local branch and its clean managed worktree", () =>
    Effect.gen(function* () {
      const repo = yield* fixture;
      yield* repo.remove;
      assert.equal((yield* repo.remote).stdout, "");
      assert.equal((yield* repo.local).stdout, "");
      assert.isFalse((yield* repo.worktrees).stdout.includes(repo.worktree));
      yield* repo.remove;
    }),
  );

  it.effect("keeps a dirty worktree and its local branch after removing the remote ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = yield* fixture;
      yield* fs.writeFileString(repo.worktree + "/new.txt", "keep me");
      const error = yield* repo.remove.pipe(Effect.flip);
      assert.include(error.detail, "Git refused");
      assert.equal((yield* repo.remote).stdout, "");
      assert.include((yield* repo.local).stdout, repo.target.sha);
      assert.include((yield* repo.worktrees).stdout, repo.worktree);
    }),
  );

  it.effect("keeps a remote branch that advanced and refuses the default branch", () =>
    Effect.gen(function* () {
      const repo = yield* fixture;
      yield* repo.git(
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "new",
      );
      yield* repo.git("push", "origin", "HEAD:refs/heads/feature");
      const error = yield* repo.remove.pipe(Effect.flip);
      assert.include(error.detail, "received new commits");
      assert.notEqual((yield* repo.remote).stdout, "");
      assert.include((yield* repo.local).stdout, repo.target.sha);
      const defaultError = yield* repo.cleanup
        .remove(repo.cwd, { ...repo.target, branch: "main" })
        .pipe(Effect.flip);
      assert.include(defaultError.detail, "default branch");
    }),
  );
});
