import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { workspaceProfileIncludesProject } from "@t3tools/client-runtime/workspace-profiles";
import { useActiveWorkspaceProfile, useThreadShell } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentShellState } from "../../state/shell";
import {
  finishProfileStartupNavigation,
  isProfileStartupNavigationPending,
} from "./useWorkspaceProfileSelection";

export function useProfileStartupNavigation() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const profile = useActiveWorkspaceProfile();
  const ref =
    profile?.lastThread ??
    (!profile && AsyncResult.isSuccess(preferences)
      ? preferences.value.allWorkspaceProfileLastThread
      : undefined);
  const thread = useThreadShell(ref ?? null);
  const shell = useEnvironmentShellState(ref?.environmentId ?? null);
  const focused = useIsFocused();
  const navigation = useNavigation();
  useEffect(() => {
    if (!isProfileStartupNavigationPending()) return;
    if (!focused || !ref) {
      finishProfileStartupNavigation();
      return;
    }
    if (thread && workspaceProfileIncludesProject(profile, thread)) {
      finishProfileStartupNavigation();
      navigation.navigate("Thread", ref);
    } else if (shell.status === "live" || shell.status === "cached") {
      finishProfileStartupNavigation();
    }
  }, [focused, ref, thread, profile, shell.status, navigation]);
}
