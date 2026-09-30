import { workspaceProfileIncludesProject } from "@t3tools/client-runtime/workspace-profiles";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { WorkspaceProfile } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { readThreadShell, useActiveWorkspaceProfile, useAllProjects } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function WorkspaceProfilesControl() {
  const navigation = useNavigation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const profiles = AsyncResult.isSuccess(preferences)
    ? (preferences.value.workspaceProfiles ?? [])
    : [];
  const active = useActiveWorkspaceProfile();
  const projects = useAllProjects();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceProfile | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("💼");
  const [color, setColor] = useState("#6366f1");
  const [members, setMembers] = useState<WorkspaceProfile["projects"]>([]);
  const selectProfile = (profile: WorkspaceProfile | null) => {
    save({ activeWorkspaceProfileId: profile?.id ?? null });
    const ref =
      profile?.lastThread ??
      (!profile && AsyncResult.isSuccess(preferences)
        ? preferences.value.allWorkspaceProfileLastThread
        : undefined);
    const thread = ref ? readThreadShell(ref) : null;
    const lastThread = thread && workspaceProfileIncludesProject(profile, thread) ? ref : undefined;
    navigation.dispatch(
      CommonActions.reset({
        index: lastThread ? 1 : 0,
        routes: [{ name: "Home" }, ...(lastThread ? [{ name: "Thread", params: lastThread }] : [])],
      }),
    );
    setOpen(false);
  };
  const edit = (profile: WorkspaceProfile | null) => {
    setEditing(profile);
    setName(profile?.name ?? "");
    setEmoji(profile?.emoji ?? "💼");
    setColor(profile?.color ?? "#6366f1");
    setMembers(profile?.projects ?? []);
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Workspace profiles"
        onPress={() => {
          edit(active);
          setOpen(true);
        }}
        className="flex-row items-center gap-2 px-4 py-2"
      >
        <View style={{ backgroundColor: active?.color ?? "#64748b", borderRadius: 6, padding: 4 }}>
          <Text>{active?.emoji ?? "🌐"}</Text>
        </View>
        <Text className="text-sm text-foreground">{active?.name ?? "All"}</Text>
      </Pressable>
      <Modal
        visible={open}
        onRequestClose={() => setOpen(false)}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <ScrollView
          className="flex-1 bg-screen"
          contentContainerStyle={{ padding: 24, paddingTop: 56, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="text-xl text-foreground">Workspace profiles</Text>
          <View className="flex-row gap-3">
            {(["status", "projects", "combined"] as const).map((mode) => (
              <Pressable key={mode} onPress={() => save({ sidebarViewMode: mode })}>
                <Text className="text-foreground">
                  {mode === "status"
                    ? "By status"
                    : mode === "projects"
                      ? "By project"
                      : "Combined"}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => {
              selectProfile(null);
            }}
          >
            <Text className="text-foreground">🌐 All projects</Text>
          </Pressable>
          {profiles.map((profile) => (
            <View key={profile.id} className="flex-row justify-between">
              <Pressable
                onPress={() => {
                  selectProfile(profile);
                }}
              >
                <Text className="text-foreground">
                  {profile.emoji} {profile.name}
                </Text>
              </Pressable>
              <Pressable onPress={() => edit(profile)}>
                <Text className="text-foreground-muted">Edit</Text>
              </Pressable>
            </View>
          ))}
          <Pressable onPress={() => edit(null)}>
            <Text className="text-foreground">＋ New profile</Text>
          </Pressable>
          <TextInput
            accessibilityLabel="Profile name"
            placeholder="Name"
            placeholderTextColor="#888"
            value={name}
            maxLength={60}
            onChangeText={setName}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Profile emoji"
            value={emoji}
            maxLength={32}
            onChangeText={setEmoji}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Profile background color"
            value={color}
            maxLength={7}
            onChangeText={setColor}
            autoCapitalize="none"
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Text className="text-foreground">Projects</Text>
          {projects.map((project) => {
            const included = members.some(
              (member) =>
                member.environmentId === project.environmentId && member.projectId === project.id,
            );
            return (
              <Pressable
                key={`${project.environmentId}:${project.id}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: included }}
                onPress={() =>
                  setMembers(
                    included
                      ? members.filter(
                          (member) =>
                            member.environmentId !== project.environmentId ||
                            member.projectId !== project.id,
                        )
                      : [
                          ...members,
                          { environmentId: project.environmentId, projectId: project.id },
                        ],
                  )
                }
              >
                <Text className="text-foreground">
                  {included ? "☑" : "☐"} {project.title}
                </Text>
                <Text className="text-xs text-foreground-muted">{project.workspaceRoot}</Text>
              </Pressable>
            );
          })}
          <Pressable
            disabled={!name.trim() || !emoji.trim() || !/^#[0-9a-f]{6}$/i.test(color)}
            onPress={() => {
              const profile = {
                ...(editing ?? {}),
                id: editing?.id ?? Crypto.randomUUID(),
                name: name.trim(),
                emoji: emoji.trim(),
                color,
                projects: members,
              };
              save({
                workspaceProfiles: editing
                  ? profiles.map((entry) => (entry.id === editing.id ? profile : entry))
                  : [...profiles, profile],
              });
              setOpen(false);
            }}
          >
            <Text className="text-foreground">Save profile</Text>
          </Pressable>
          {editing ? (
            <Pressable
              onPress={() => {
                save({
                  workspaceProfiles: profiles.filter((profile) => profile.id !== editing.id),
                  ...(active?.id === editing.id ? { activeWorkspaceProfileId: null } : {}),
                });
                edit(null);
              }}
            >
              <Text className="text-destructive">Delete profile</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setOpen(false)}>
            <Text className="text-foreground-muted">Close</Text>
          </Pressable>
        </ScrollView>
      </Modal>
    </>
  );
}
