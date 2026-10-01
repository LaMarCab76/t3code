import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { WorkspaceProfileSchedule } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";

const timeDate = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(2000, 0, 2, hours ?? 0, minutes ?? 0);
};

export function WorkspaceProfileScheduleTimes({
  schedule,
  onChange,
}: {
  schedule: WorkspaceProfileSchedule;
  onChange: (patch: Partial<WorkspaceProfileSchedule>) => void;
}) {
  const [picker, setPicker] = useState<"start" | "end" | null>(null);
  return (
    <View className="gap-3">
      <View className="flex-row gap-3">
        {(["start", "end"] as const).map((field) => (
          <Pressable
            key={field}
            accessibilityRole="button"
            accessibilityLabel={field === "start" ? "Start time" : "End time"}
            onPress={() => setPicker(field)}
            className="min-w-0 flex-1 gap-2 rounded-lg bg-subtle p-3"
          >
            <Text className="text-sm text-foreground">
              {field === "start" ? "Start time" : "End time"}
            </Text>
            <Text className="text-foreground">
              {timeDate(schedule[field]).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </Pressable>
        ))}
      </View>
      {picker ? (
        <>
          <DateTimePicker
            value={timeDate(schedule[picker])}
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            onDismiss={() => setPicker(null)}
            onValueChange={(_, selected) => {
              onChange({
                [picker]: `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`,
              });
              if (Platform.OS === "android") setPicker(null);
            }}
          />
          {Platform.OS === "ios" ? (
            <Pressable accessibilityRole="button" onPress={() => setPicker(null)}>
              <Text className="text-foreground">Done</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
