import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WorkspaceProfile } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { useActiveWorkspaceProfile } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { WorkspaceProfileDialog } from "./WorkspaceProfileDialog";
import { useWorkspaceProfileSelection } from "./useWorkspaceProfileSelection";

export function WorkspaceProfileAvatar({ profile }: { profile: WorkspaceProfile | null }) {
  return (
    <View
      style={{
        backgroundColor: profile?.color ?? "#64748b",
        width: 32,
        height: 32,
        borderRadius: 16,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <Text className="text-lg">{profile?.emoji ?? "🌐"}</Text>
    </View>
  );
}

export function WorkspaceProfilesControl() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const profiles = AsyncResult.isSuccess(preferences)
    ? (preferences.value.workspaceProfiles ?? [])
    : [];
  const active = useActiveWorkspaceProfile();
  const selectProfile = useWorkspaceProfileSelection();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Workspace profile: ${active?.name ?? "All"}`}
        onPress={() => setOpen(true)}
        className="size-11 items-center justify-center"
      >
        <WorkspaceProfileAvatar profile={active} />
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <View className="flex-1 justify-end" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close profile menu"
            onPress={() => setOpen(false)}
            className="flex-1"
          />
          <View
            className="rounded-t-2xl bg-black px-4 pt-4"
            style={{ paddingBottom: Math.max(insets.bottom, 20), maxHeight: "70%" }}
          >
            <Text className="mb-3 text-lg" style={{ color: "white" }}>
              Workspace profiles
            </Text>
            <ScrollView>
              {[null, ...profiles].map((profile) => (
                <Pressable
                  key={profile?.id ?? "all"}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: (profile?.id ?? null) === (active?.id ?? null) }}
                  onPress={() => {
                    setOpen(false);
                    void selectProfile(profile?.id ?? null).catch((cause: unknown) =>
                      Alert.alert(
                        "Could not change profile",
                        cause instanceof Error ? cause.message : "Try again.",
                      ),
                    );
                  }}
                  className="flex-row items-center gap-3 py-3"
                >
                  <WorkspaceProfileAvatar profile={profile} />
                  <Text numberOfLines={1} className="min-w-0 flex-1" style={{ color: "white" }}>
                    {profile?.name ?? "All"}
                  </Text>
                  {(profile?.id ?? null) === (active?.id ?? null) ? (
                    <Text style={{ color: "white" }}>✓</Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
            <View className="mt-2 border-t border-white/20 pt-2">
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className="py-3"
              >
                <Text style={{ color: "white" }}>＋ Create profile</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setOpen(false);
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsProfiles" },
                  });
                }}
                className="py-3"
              >
                <Text style={{ color: "white" }}>Manage profiles</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {creating ? (
        <WorkspaceProfileDialog profile={null} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
