import { assistantInsightPreview } from "@t3tools/shared/assistantInsights";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export function ThreadInsightBlock(props: {
  readonly markdown: string;
  readonly children: ReactNode;
}) {
  const { assistantInsightsCollapsed } = useAppearancePreferences();
  // Until the user toggles this block, it follows the setting.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? !assistantInsightsCollapsed;
  const preview = useMemo(
    () => (open ? "" : assistantInsightPreview(props.markdown)),
    [open, props.markdown],
  );

  return (
    <View className="my-2 rounded-xl border border-border-subtle bg-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={preview ? `Insight: ${preview}` : "Insight"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpenOverride(!open)}
        className="min-h-11 flex-row items-center gap-1.5 px-3"
      >
        <SymbolView
          name="star.fill"
          size={13}
          tintColorClassName="accent-adaptive-amber-700-400"
          type="monochrome"
        />
        <Text className="font-t3-medium text-sm text-foreground">Insight</Text>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground-muted">
          {preview}
        </Text>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
      {open ? <View className="px-3 pb-2.5">{props.children}</View> : null}
    </View>
  );
}
