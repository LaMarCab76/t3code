import {
  type PromptFormat,
  promptFormats,
  sourceFormatActive,
} from "@t3tools/client-runtime/prompt-format";
import { useGT } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { AppText } from "../../components/ui/AppText";

export function PromptFormatToolbar(props: {
  value: string;
  selection: ComposerEditorSelection;
  disabled: boolean;
  onApply: (format: PromptFormat) => void;
}) {
  const gt = useGT();
  return (
    <View className="min-w-0 flex-1">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerClassName="flex-row items-center"
      >
        {promptFormats.map((format) => {
          const label =
            typeof format === "number"
              ? gt("Heading {level}", { level: format })
              : format === "bold"
                ? gt("Bold")
                : gt("Italic");
          const selected = sourceFormatActive(props.value, props.selection, format);
          return (
            <Pressable
              key={format}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected, disabled: props.disabled }}
              disabled={props.disabled}
              className={
                selected
                  ? "h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-subtle-strong"
                  : "h-[44px] min-w-[44px] items-center justify-center rounded-lg active:bg-subtle"
              }
              onPress={() => props.onApply(format)}
            >
              <AppText
                className={
                  format === "bold"
                    ? "font-t3-bold text-foreground"
                    : format === "italic"
                      ? "italic text-foreground"
                      : "text-sm text-foreground"
                }
              >
                {typeof format === "number" ? `H${format}` : format === "bold" ? "B" : "I"}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
