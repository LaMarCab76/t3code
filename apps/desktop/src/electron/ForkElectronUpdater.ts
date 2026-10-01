import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "./ElectronApp.ts";
import {
  ForkUpdateBackend,
  acknowledgeForkUpdate,
  readForkRecoveryNotice,
} from "../updates/ForkUpdateBackend.ts";
import {
  FORK_UPDATE_REPOSITORY,
  FORK_APP_ID,
  selectForkArchitecture,
} from "../updates/forkManifest.ts";
import {
  ElectronUpdater,
  make,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
} from "./ElectronUpdater.ts";

// Official installations keep the native backend. Only fork Mac bundles carry
// this immutable resource; runtime environment variables cannot redirect it.
export const layer = Layer.effect(
  ElectronUpdater,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronApp = yield* ElectronApp.ElectronApp;
    if (environment.platform !== "darwin" || !environment.isPackaged) return make;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = environment.path;
    const configuration = yield* fileSystem
      .readFileString(path.join(environment.resourcesPath, "fork-update.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    if (!configuration) return make;
    const decoded = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ repository: Schema.String, appId: Schema.String })),
    )(configuration).pipe(Effect.orElseSucceed(() => null));
    if (decoded?.repository !== FORK_UPDATE_REPOSITORY || decoded.appId !== FORK_APP_ID)
      return make;
    const cachePath = path.join(
      environment.homeDirectory,
      "Library",
      "Caches",
      FORK_APP_ID,
      "fork-updates",
    );
    const context = yield* Effect.context<never>();
    const backend = new ForkUpdateBackend({
      currentVersion: environment.appVersion,
      arch: selectForkArchitecture(
        environment.processArch,
        environment.runtimeInfo.runningUnderArm64Translation,
      ),
      resourcesPath: environment.resourcesPath,
      installationPath: path.resolve(environment.resourcesPath, "..", ".."),
      cachePath,
      quit: () => {
        void Effect.runPromiseWith(context)(electronApp.quit);
      },
    });
    return ElectronUpdater.of({
      source: {
        kind: "fork",
        repository: FORK_UPDATE_REPOSITORY,
        url: `https://github.com/${FORK_UPDATE_REPOSITORY}/releases`,
      },
      startupNotice: Effect.tryPromise(() =>
        readForkRecoveryNotice(cachePath, environment.appVersion),
      ).pipe(Effect.orElseSucceed(() => null)),
      acknowledgeStartup: Effect.tryPromise(() =>
        acknowledgeForkUpdate(cachePath, environment.appVersion, process.argv),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not acknowledge fork update startup", error),
        ),
      ),
      setFeedURL: () => Effect.void,
      setAutoDownload: () => Effect.void,
      setAutoInstallOnAppQuit: () => Effect.void,
      setChannel: () => Effect.void,
      setAllowPrerelease: () => Effect.void,
      allowDowngrade: Effect.succeed(false),
      setAllowDowngrade: () => Effect.void,
      setFullChangelog: () => Effect.void,
      setDisableDifferentialDownload: () => Effect.void,
      checkForUpdates: Effect.tryPromise({
        try: () => backend.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
      }),
      downloadUpdate: Effect.tryPromise({
        try: () => backend.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
      }),
      quitAndInstall: ({ isSilent, isForceRunAfter }) =>
        Effect.tryPromise({
          try: () => backend.quitAndInstall(),
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel: null,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        }),
      on: (eventName, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            backend.on(eventName, listener);
          }),
          () =>
            Effect.sync(() => {
              backend.removeListener(eventName, listener);
            }),
        ).pipe(Effect.asVoid),
    });
  }),
);
