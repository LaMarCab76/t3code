import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { mobilePreferencesAtom } from "../../state/preferences";

export function useMobileSidebarViewMode() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.sidebarViewMode ?? "status")
    : "status";
}
