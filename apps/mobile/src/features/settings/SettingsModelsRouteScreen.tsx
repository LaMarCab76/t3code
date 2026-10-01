import { useAtomSet } from "@effect/atom-react";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useModelPreferences } from "../../state/model-preferences";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function SettingsModelsRouteScreen() {
  const { environments } = useEnvironments();
  const preferences = useModelPreferences();
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const targets = environments.filter((environment) => environment.serverConfig !== null);
  return (
    <SettingsScreen title="Models">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          Choose which models appear in menus on this device. Existing threads and explicit drafts
          keep their model. These preferences apply to all profiles.
        </Text>
        <TextInput
          accessibilityLabel="Search models"
          placeholder="Search models"
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          className="rounded-lg border border-border bg-subtle p-3 text-foreground"
        />
        {targets.map((environment) => (
          <View key={environment.environmentId} className="gap-4">
            <Text className="text-foreground">{environment.label}</Text>
            {environment.serverConfig?.providers.map((provider) => {
              const hidden = preferences[provider.instanceId]?.hiddenModels ?? [];
              const models = provider.models.filter((model) =>
                `${model.name} ${model.slug}`.toLowerCase().includes(query),
              );
              if (query && !models.length) return null;
              return (
                <SettingsSection
                  key={provider.instanceId}
                  title={provider.displayName ?? provider.instanceId}
                >
                  {models.map((model) => (
                    <SettingsSwitchRow
                      key={model.slug}
                      icon="slider.horizontal.3"
                      label={model.name}
                      subtitle={model.slug}
                      value={!hidden.includes(model.slug)}
                      onValueChange={(visible) => {
                        void save({
                          transform: (current) => {
                            const previous = current.providerModelPreferences?.[
                              provider.instanceId
                            ] ?? { hiddenModels: [], modelOrder: [] };
                            return {
                              providerModelPreferences: {
                                ...current.providerModelPreferences,
                                [provider.instanceId]: {
                                  ...previous,
                                  hiddenModels: visible
                                    ? previous.hiddenModels.filter((slug) => slug !== model.slug)
                                    : [...new Set([...previous.hiddenModels, model.slug])],
                                },
                              },
                            };
                          },
                        }).catch(() =>
                          Alert.alert("Could not save model preferences", "Try again."),
                        );
                      }}
                    />
                  ))}
                  {!models.length ? (
                    <Text className="p-4 text-sm text-foreground-muted">
                      No models available. Connect or refresh this provider to load its catalog.
                    </Text>
                  ) : null}
                </SettingsSection>
              );
            })}
          </View>
        ))}
        {!targets.length ? (
          <Text className="text-sm text-foreground-muted">
            Connect an environment to manage its models. Your saved visibility preferences will be
            retained.
          </Text>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
