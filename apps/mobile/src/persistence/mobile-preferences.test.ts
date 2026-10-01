import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import { removeWorkspaceProfile } from "@t3tools/client-runtime/workspace-profiles";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";
import { make, type Preferences } from "./mobile-preferences";

const memoryStore = (initial: Preferences) => {
  let stored: StoredPreferencesJson = { payload: JSON.stringify(initial), updatedAt: 1 };
  const database = MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secure = MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return make().pipe(
    Effect.provideService(MobileDatabase, database),
    Effect.provideService(MobileSecureStorage, secure),
  );
};

describe("mobile profile preference persistence", () => {
  const profile = {
    id: "work",
    name: "Work",
    emoji: "💼",
    color: "#6366f1",
    projects: [],
    schedules: [{ days: [1], start: "22:00", end: "06:00" }],
  };
  it.effect(
    "loads old profiles and round-trips defaults and overnight schedules without replacing appearance",
    () =>
      Effect.gen(function* () {
        const store = yield* memoryStore({
          workspaceProfiles: [{ ...profile, schedules: undefined }],
          activeWorkspaceProfileId: "work",
          baseFontSize: 18,
        });
        const old = yield* store.load;
        expect(old.activeWorkspaceProfileId).toBe("work");
        expect(old.defaultWorkspaceProfileId).toBeUndefined();
        yield* store.savePatch({ workspaceProfiles: [profile], defaultWorkspaceProfileId: "work" });
        expect(yield* store.load).toEqual({
          workspaceProfiles: [profile],
          activeWorkspaceProfileId: "work",
          defaultWorkspaceProfileId: "work",
          baseFontSize: 18,
        });
        yield* store.savePatch({ defaultWorkspaceProfileId: undefined });
        expect((yield* store.load).defaultWorkspaceProfileId).toBeUndefined();
      }),
  );
  it.effect(
    "deletes selected defaults and schedules while keeping other profiles and appearance",
    () =>
      Effect.gen(function* () {
        const other = { ...profile, id: "personal", schedules: [] };
        const store = yield* memoryStore({
          workspaceProfiles: [profile, other],
          activeWorkspaceProfileId: "work",
          defaultWorkspaceProfileId: "work",
          baseFontSize: 18,
        });
        yield* store.update((current) => removeWorkspaceProfile(current, "work"));
        expect(yield* store.load).toEqual({
          workspaceProfiles: [other],
          activeWorkspaceProfileId: null,
          defaultWorkspaceProfileId: null,
          baseFontSize: 18,
        });
      }),
  );
});

it.effect(
  "round-trips hidden models for disconnected instances without replacing profiles or favorites",
  () =>
    Effect.gen(function* () {
      const store = yield* memoryStore({ workspaceProfiles: [], baseFontSize: 18 });
      const preferences = {
        ["codex_work" as import("@t3tools/contracts").ProviderInstanceId]: {
          hiddenModels: ["custom", "temporarily-absent"],
          modelOrder: ["visible"],
        },
      };
      yield* store.savePatch({ providerModelPreferences: preferences });
      expect((yield* store.load).providerModelPreferences).toEqual(preferences);
      yield* store.savePatch({ activeWorkspaceProfileId: "work" });
      expect((yield* store.load).providerModelPreferences).toEqual(preferences);
      expect((yield* store.load).baseFontSize).toBe(18);
    }),
);
