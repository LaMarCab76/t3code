import { useAtomSet } from "@effect/atom-react";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { workspaceProfileIncludesProject } from "@t3tools/client-runtime/workspace-profiles";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { readThreadShell } from "../../state/entities";
import type { Preferences } from "../../persistence/mobile-preferences";

let switchesInFlight = 0;
export const isMobileWorkspaceProfileSwitching = () => switchesInFlight > 0;
let startupNavigationPending = true;
export const isProfileStartupNavigationPending = () => startupNavigationPending;
export const finishProfileStartupNavigation = () => {
  startupNavigationPending = false;
};

export function useWorkspaceProfileSelection() {
  const navigation = useNavigation();
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  return async (
    id: string | null,
    updateProfile?: (current: Preferences) => Partial<Preferences>,
  ) => {
    finishProfileStartupNavigation();
    switchesInFlight++;
    try {
      const preferences = await save({
        transform: (current) => ({ ...updateProfile?.(current), activeWorkspaceProfileId: id }),
      });
      const profile = preferences.workspaceProfiles?.find((entry) => entry.id === id) ?? null;
      const ref =
        profile?.lastThread ??
        (id === null ? preferences.allWorkspaceProfileLastThread : undefined);
      const thread = ref ? readThreadShell(ref) : null;
      const lastThread =
        thread && workspaceProfileIncludesProject(profile, thread) ? ref : undefined;
      navigation.dispatch(
        CommonActions.reset({
          index: lastThread ? 1 : 0,
          routes: [
            { name: "Home" },
            ...(lastThread ? [{ name: "Thread", params: lastThread }] : []),
          ],
        }),
      );
    } finally {
      switchesInFlight--;
    }
  };
}
