import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import type { WorkspaceProfile, WorkspaceProfileSchedule } from "@t3tools/contracts";
import {
  WORKSPACE_PROFILE_DAYS,
  findWorkspaceProfileScheduleIssue,
  workspaceProfileScheduleIssueMessage,
} from "@t3tools/client-runtime/workspace-profiles";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import {
  mobilePreferencesAtom,
  updateMobilePreferencesAtom,
  MobilePreferencesSaveError,
} from "../../state/preferences";
import type { Preferences } from "../../persistence/mobile-preferences";
import { useAllProjects } from "../../state/entities";
import { WorkspaceProfileAvatarPicker } from "./WorkspaceProfileAvatarPicker";
import { WorkspaceProfileScheduleTimes } from "./WorkspaceProfileScheduleTimes";
import { useWorkspaceProfileSelection } from "./useWorkspaceProfileSelection";

export function WorkspaceProfileDialog({
  profile,
  onClose,
}: {
  profile: WorkspaceProfile | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const selectProfile = useWorkspaceProfileSelection();
  const projects = useAllProjects();
  const [id] = useState(() => profile?.id ?? Crypto.randomUUID());
  const [step, setStep] = useState(1);
  const [name, setName] = useState(profile?.name ?? "");
  const [emoji, setEmoji] = useState(profile?.emoji ?? "💼");
  const [color, setColor] = useState(profile?.color ?? "#6366f1");
  const [members, setMembers] = useState<WorkspaceProfile["projects"]>(profile?.projects ?? []);
  const [schedules, setSchedules] = useState<readonly WorkspaceProfileSchedule[]>(() =>
    (profile?.schedules ?? []).map((schedule) => ({
      ...schedule,
      id: schedule.id ?? Crypto.randomUUID(),
    })),
  );
  const [isDefault, setIsDefault] = useState(
    AsyncResult.isSuccess(preferences) && preferences.value.defaultWorkspaceProfileId === id,
  );
  const [startupOpen, setStartupOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = name.trim().length > 0 && name.trim().length <= 60 && emoji.trim().length > 0;
  const patchSchedule = (index: number, value: Partial<WorkspaceProfileSchedule>) =>
    setSchedules((current) =>
      current.map((schedule, i) => (i === index ? { ...schedule, ...value } : schedule)),
    );
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updateDraft = (current: Preferences): Partial<Preferences> => {
        const previous = current.workspaceProfiles?.find((entry) => entry.id === id);
        const draft: WorkspaceProfile = {
          ...previous,
          id,
          name: name.trim(),
          emoji: emoji.trim(),
          color,
          projects: members,
          schedules,
        };
        const profiles = previous
          ? (current.workspaceProfiles ?? []).map((entry) => (entry.id === id ? draft : entry))
          : [...(current.workspaceProfiles ?? []), draft];
        const issue = findWorkspaceProfileScheduleIssue(profiles);
        if (issue) throw new Error(workspaceProfileScheduleIssueMessage(issue, profiles));
        return {
          workspaceProfiles: profiles,
          ...(isDefault
            ? { defaultWorkspaceProfileId: id }
            : current.defaultWorkspaceProfileId === id
              ? { defaultWorkspaceProfileId: null }
              : {}),
        };
      };
      if (AsyncResult.isSuccess(preferences)) updateDraft(preferences.value);
      if (profile) await save({ transform: updateDraft });
      else await selectProfile(id, updateDraft);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof MobilePreferencesSaveError && cause.cause instanceof Error
          ? cause.cause.message
          : cause instanceof Error
            ? cause.message
            : "Could not save profile.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      visible
      onRequestClose={() => {
        if (!saving) onClose();
      }}
      animationType="slide"
      presentationStyle="pageSheet"
    >
      <KeyboardAvoidingView
        className="flex-1 bg-sheet"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ paddingTop: Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <View className="gap-2 px-5 pb-4">
          <Text className="text-xl text-foreground">
            {profile ? "Edit profile" : "Create profile"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            Step {step} of 2 · {step === 1 ? "Profile details" : "Projects"}
          </Text>
        </View>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ padding: 20, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          {step === 1 ? (
            <>
              <Text className="text-sm text-foreground">Name</Text>
              <TextInput
                autoFocus
                accessibilityLabel="Profile name"
                placeholder="Name"
                maxLength={60}
                value={name}
                onChangeText={setName}
              />
              <WorkspaceProfileAvatarPicker
                emoji={emoji}
                color={color}
                onEmojiChange={setEmoji}
                onColorChange={setColor}
              />
            </>
          ) : (
            <>
              <Text className="text-sm text-foreground-muted">
                Choose projects to show in this profile. A project can belong to several profiles.
              </Text>
              {!projects.length ? (
                <Text className="text-sm text-foreground-muted">
                  No projects available. You can add projects later.
                </Text>
              ) : null}
              {projects.map((project) => {
                const included = members.some(
                  (member) =>
                    member.environmentId === project.environmentId &&
                    member.projectId === project.id,
                );
                return (
                  <Pressable
                    key={`${project.environmentId}:${project.id}`}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`${project.title}, ${project.workspaceRoot}`}
                    accessibilityState={{ checked: included }}
                    onPress={() =>
                      setMembers((current) =>
                        included
                          ? current.filter(
                              (member) =>
                                member.environmentId !== project.environmentId ||
                                member.projectId !== project.id,
                            )
                          : [
                              ...current,
                              { environmentId: project.environmentId, projectId: project.id },
                            ],
                      )
                    }
                    className="flex-row items-center gap-3 py-2"
                  >
                    <Text className="text-lg text-foreground">{included ? "☑" : "☐"}</Text>
                    <View className="min-w-0 flex-1">
                      <Text numberOfLines={1} className="text-foreground">
                        {project.title}
                      </Text>
                      <Text numberOfLines={1} className="text-xs text-foreground-muted">
                        {project.workspaceRoot}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {members.some(
                (member) =>
                  !projects.some(
                    (project) =>
                      project.environmentId === member.environmentId &&
                      project.id === member.projectId,
                  ),
              ) ? (
                <Text className="text-xs text-foreground-muted">
                  Projects from disconnected environments are kept in this profile.
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: startupOpen }}
                onPress={() => setStartupOpen((value) => !value)}
              >
                <Text className="text-base text-foreground">
                  Startup preferences {startupOpen ? "▾" : "▸"}
                </Text>
              </Pressable>
              {startupOpen ? (
                <>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isDefault }}
                    onPress={() => setIsDefault((value) => !value)}
                  >
                    <Text className="text-foreground">
                      {isDefault ? "☑" : "☐"} Use as default profile
                    </Text>
                  </Pressable>
                  <Text className="text-sm text-foreground-muted">
                    Schedules use this device’s local time and apply only when the app starts. For
                    overnight hours, select the day the schedule starts.
                  </Text>
                  {schedules.map((schedule, index) => (
                    <View
                      key={
                        schedule.id ??
                        `${schedule.days.join(",")}-${schedule.start}-${schedule.end}`
                      }
                      className="gap-3 rounded-xl border border-border p-3"
                    >
                      <Text className="text-foreground">Schedule {index + 1}</Text>
                      <View className="flex-row flex-wrap gap-2">
                        {WORKSPACE_PROFILE_DAYS.map(([day, label, short]) => (
                          <Pressable
                            key={day}
                            accessibilityRole="checkbox"
                            accessibilityLabel={label}
                            accessibilityState={{ checked: schedule.days.includes(day) }}
                            onPress={() =>
                              patchSchedule(index, {
                                days: schedule.days.includes(day)
                                  ? schedule.days.filter((value) => value !== day)
                                  : [...schedule.days, day],
                              })
                            }
                            className="rounded-lg bg-subtle p-2"
                          >
                            <Text className="text-sm text-foreground">
                              {schedule.days.includes(day) ? "✓ " : ""}
                              {short}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <WorkspaceProfileScheduleTimes
                        schedule={schedule}
                        onChange={(patch) => patchSchedule(index, patch)}
                      />
                      {schedule.end < schedule.start ? (
                        <Text className="text-xs text-foreground-muted">
                          Ends the following day.
                        </Text>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          setSchedules((current) => current.filter((_, i) => i !== index))
                        }
                      >
                        <Text className="text-sm text-foreground">Remove schedule</Text>
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setSchedules((current) => [
                        ...current,
                        {
                          id: Crypto.randomUUID(),
                          days: [1, 2, 3, 4, 5],
                          start: "09:00",
                          end: "17:00",
                        },
                      ])
                    }
                  >
                    <Text className="text-foreground">＋ Add schedule</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          )}
          {error ? (
            <Text accessibilityRole="alert" className="text-destructive">
              {error}
            </Text>
          ) : null}
        </ScrollView>
        <View className="flex-row items-center justify-between gap-2 px-5 pt-4">
          <Pressable accessibilityRole="button" disabled={saving} onPress={onClose}>
            <Text className="text-foreground">Cancel</Text>
          </Pressable>
          <View className="flex-row gap-3">
            {step === 2 ? (
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={() => {
                  setError(null);
                  setStep(1);
                }}
                className="rounded-lg bg-subtle p-3"
              >
                <Text className="text-foreground">Back</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !valid || saving }}
              disabled={!valid || saving}
              onPress={() => {
                if (step === 1) setStep(2);
                else void submit();
              }}
              className={
                valid && !saving ? "rounded-lg bg-primary p-3" : "rounded-lg bg-subtle p-3"
              }
            >
              <Text
                className={valid && !saving ? "text-primary-foreground" : "text-foreground-muted"}
              >
                {saving
                  ? "Saving…"
                  : step === 1
                    ? "Next"
                    : profile
                      ? "Save changes"
                      : "Create profile"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
