import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WorkspaceProfile } from "@t3tools/contracts";
import {
  formatWorkspaceProfileSchedule,
  removeWorkspaceProfile,
} from "@t3tools/client-runtime/workspace-profiles";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { ControlPillMenu } from "../../components/ControlPill";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { WorkspaceProfileDialog } from "../threads/WorkspaceProfileDialog";
import { WorkspaceProfileAvatar } from "../threads/WorkspaceProfilesControl";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsProfilesRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const [editing, setEditing] = useState<WorkspaceProfile | null | undefined>();
  const current = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const profiles = current.workspaceProfiles ?? [];
  const defaultId = current.defaultWorkspaceProfileId;
  const defaultLabel =
    defaultId === undefined
      ? "Last used"
      : defaultId === null
        ? "All"
        : (profiles.find((profile) => profile.id === defaultId)?.name ?? "All");
  const report = (cause: unknown) =>
    Alert.alert(
      "Could not save profile preferences",
      cause instanceof Error ? cause.message : "Try again.",
    );
  return (
    <SettingsScreen title="Profiles">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Startup">
          <View className="gap-3 p-4">
            <Text className="text-foreground">Default profile</Text>
            <ControlPillMenu
              actions={[
                {
                  id: "last-used",
                  title: "Last used",
                  state: defaultId === undefined ? "on" : "off",
                },
                { id: "all", title: "All", state: defaultId === null ? "on" : "off" },
                ...profiles.map((profile) => ({
                  id: profile.id,
                  title: profile.name,
                  state: defaultId === profile.id ? ("on" as const) : ("off" as const),
                })),
              ]}
              onPressAction={({ nativeEvent }) => {
                const id = nativeEvent.event;
                void save({
                  transform: (values) => ({
                    ...values,
                    defaultWorkspaceProfileId:
                      id === "last-used" ? undefined : id === "all" ? null : id,
                  }),
                }).catch(report);
              }}
            >
              <View className="rounded-lg bg-subtle p-3">
                <Text className="text-foreground">{defaultLabel} ▾</Text>
              </View>
            </ControlPillMenu>
            <Text className="text-sm text-foreground-muted">
              Used when no schedule matches. Profiles and schedules are saved only on this device.
            </Text>
          </View>
        </SettingsSection>
        <SettingsSection title="Profiles">
          <View className="gap-3 p-4">
            <Pressable accessibilityRole="button" onPress={() => setEditing(null)}>
              <Text className="text-foreground">＋ Create profile</Text>
            </Pressable>
            <Text className="text-sm text-foreground-muted">
              Schedules apply only at startup, using this device’s local time. Edit a profile to
              change its projects or schedules.
            </Text>
            <View className="flex-row items-center gap-3 py-2">
              <WorkspaceProfileAvatar profile={null} />
              <Text className="text-foreground">All · All projects</Text>
            </View>
            {profiles.map((profile) => (
              <View key={profile.id} className="gap-2 border-t border-border py-3">
                <View className="flex-row items-center gap-3">
                  <WorkspaceProfileAvatar profile={profile} />
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-foreground">
                      {profile.name}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {profile.projects.length}{" "}
                      {profile.projects.length === 1 ? "project" : "projects"}
                      {defaultId === profile.id ? " · Default" : ""}
                    </Text>
                  </View>
                </View>
                {profile.schedules?.map((schedule) => (
                  <Text
                    key={
                      schedule.id ?? `${schedule.days.join(",")}-${schedule.start}-${schedule.end}`
                    }
                    className="text-xs text-foreground-muted"
                  >
                    {formatWorkspaceProfileSchedule(schedule)}
                  </Text>
                ))}
                <View className="flex-row gap-5">
                  <Pressable accessibilityRole="button" onPress={() => setEditing(profile)}>
                    <Text className="text-foreground">Edit</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      showConfirmDialog({
                        title: "Delete profile?",
                        message: `Delete ${profile.name} and its schedules? Projects and threads will stay available.`,
                        confirmText: "Delete profile",
                        destructive: true,
                        onConfirm: () => {
                          void save({
                            transform: (values) => removeWorkspaceProfile(values, profile.id),
                          }).catch(report);
                        },
                      })
                    }
                  >
                    <Text className="text-destructive">Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            {!profiles.length ? (
              <Text className="text-sm text-foreground-muted">
                Create a profile to organize your projects.
              </Text>
            ) : null}
          </View>
        </SettingsSection>
      </ScreenScrollView>
      {editing !== undefined ? (
        <WorkspaceProfileDialog
          key={editing?.id ?? "new"}
          profile={editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </SettingsScreen>
  );
}
