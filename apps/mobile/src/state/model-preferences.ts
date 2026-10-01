import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ProviderModelPreferences } from "@t3tools/client-runtime/model-preferences";
import { mobilePreferencesAtom } from "./preferences";

const EMPTY: ProviderModelPreferences = {};
export function useModelPreferences() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.providerModelPreferences ?? EMPTY)
    : EMPTY;
}
