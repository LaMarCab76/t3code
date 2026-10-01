import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  WORKSPACE_PROFILE_COLORS,
  WORKSPACE_PROFILE_EMOJIS,
} from "@t3tools/client-runtime/workspace-profiles";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SegmentedControl } from "../../components/SegmentedControl";

export function WorkspaceProfileAvatarPicker({
  emoji,
  color,
  onEmojiChange,
  onColorChange,
}: {
  emoji: string;
  color: string;
  onEmojiChange: (value: string) => void;
  onColorChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"emoji" | "color">("emoji");
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [emojiDraft, setEmojiDraft] = useState<string | null>(null);
  return (
    <View className="gap-4">
      <View className="items-center py-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change profile emoji and background color"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          style={{
            backgroundColor: color,
            width: 64,
            height: 64,
            borderRadius: 32,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text className="text-3xl">{emoji}</Text>
        </Pressable>
      </View>
      {open ? (
        <View className="gap-4 rounded-xl border border-border p-3">
          <SegmentedControl
            options={
              [
                { value: "emoji", label: "Emoji" },
                { value: "color", label: "Background color" },
              ] as const
            }
            selected={tab}
            onSelect={setTab}
            role="tab"
          />
          {tab === "emoji" ? (
            <>
              <View className="flex-row flex-wrap justify-center">
                {WORKSPACE_PROFILE_EMOJIS.map(([value, label]) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: emoji === value }}
                    onPress={() => {
                      setEmojiDraft(null);
                      onEmojiChange(value);
                    }}
                    className={
                      emoji === value
                        ? "size-10 items-center justify-center rounded-lg bg-subtle"
                        : "size-10 items-center justify-center rounded-lg active:bg-subtle"
                    }
                  >
                    <Text className="text-2xl">{value}</Text>
                  </Pressable>
                ))}
              </View>
              <Text className="text-sm text-foreground">Other emoji</Text>
              <TextInput
                accessibilityLabel="Other emoji"
                placeholder="Paste an emoji"
                maxLength={32}
                value={emojiDraft ?? emoji}
                onChangeText={(value) => {
                  setEmojiDraft(value);
                  if (value.trim()) onEmojiChange(value.trim());
                }}
                onBlur={() => setEmojiDraft(null)}
              />
            </>
          ) : (
            <>
              <View className="flex-row flex-wrap justify-center gap-2">
                {WORKSPACE_PROFILE_COLORS.map(([value, label]) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: color.toLowerCase() === value }}
                    onPress={() => {
                      setHexDraft(null);
                      onColorChange(value);
                    }}
                    style={{
                      backgroundColor: value,
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      borderWidth: color.toLowerCase() === value ? 3 : 0,
                      borderColor: "white",
                    }}
                  />
                ))}
              </View>
              <Text className="text-sm text-foreground">Hex color</Text>
              <TextInput
                accessibilityLabel="Hex color"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                value={hexDraft ?? color}
                onChangeText={(value) => {
                  setHexDraft(value);
                  if (/^#[\da-f]{6}$/i.test(value)) onColorChange(value.toLowerCase());
                }}
                onBlur={() => setHexDraft(null)}
              />
            </>
          )}
        </View>
      ) : (
        <Text className="text-center text-sm text-foreground-muted">
          Choose an emoji and background color for your profile.
        </Text>
      )}
    </View>
  );
}
