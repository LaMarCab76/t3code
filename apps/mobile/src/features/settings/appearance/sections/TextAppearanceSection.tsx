import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import {
  AppearancePreviewSeparator,
  TextAppearancePreview,
} from "../components/AppearancePreviews";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function TextAppearanceSection() {
  const {
    isReady,
    appearance,
    setBaseFontSize,
    mathRenderingEnabled,
    setMathRenderingEnabled,
    assistantInsightsCollapsed,
    setAssistantInsightsCollapsed,
  } = useAppearancePreferences();

  return (
    <SettingsSection title="Text">
      <TextAppearancePreview fontSize={appearance.baseFontSize} />
      <AppearancePreviewSeparator />
      <FontSizeSliderRow
        disabled={!isReady}
        icon="textformat.size"
        label="Text size"
        max={MAX_BASE_FONT_SIZE}
        min={MIN_BASE_FONT_SIZE}
        onChange={setBaseFontSize}
        step={BASE_FONT_SIZE_STEP}
        value={appearance.baseFontSize}
        valueLabel={`${appearance.baseFontSize} pt`}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="plusminus"
        label="Render math"
        value={mathRenderingEnabled}
        onValueChange={setMathRenderingEnabled}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="star"
        label="Collapse insights"
        subtitle="Start Claude's ★ Insight asides collapsed in replies"
        value={assistantInsightsCollapsed}
        onValueChange={setAssistantInsightsCollapsed}
      />
    </SettingsSection>
  );
}
