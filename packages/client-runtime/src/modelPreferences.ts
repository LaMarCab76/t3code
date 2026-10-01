import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";

export type ProviderModelPreferences = ClientSettings["providerModelPreferences"];

export function isModelHidden(
  preferences: ProviderModelPreferences | undefined,
  instanceId: ProviderInstanceId,
  model: string,
): boolean {
  return preferences?.[instanceId]?.hiddenModels.includes(model) ?? false;
}

/** Apply device visibility without changing the provider's catalog. */
export function filterVisibleModels<T extends { readonly slug: string }>(
  models: ReadonlyArray<T>,
  hiddenModels: ReadonlyArray<string>,
): T[] {
  const hidden = new Set(hiddenModels);
  return models.filter((model) => !hidden.has(model.slug));
}
