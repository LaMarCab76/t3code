import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { resolveInitialWorkspaceProfileId } from "@t3tools/client-runtime/workspace-profiles";
import { AppText } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

let initialized = false;
let startup: Promise<unknown> | undefined;

export function WorkspaceProfileStartupGate({ children }: { children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const preferencesLoaded = AsyncResult.isSuccess(preferences);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const [ready, setReady] = useState(initialized);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (ready || error || !preferencesLoaded) return;
    let mounted = true;
    const now = new Date();
    const attempt = initialized
      ? Promise.resolve()
      : (startup ??= save({
          transform: (current) => ({
            activeWorkspaceProfileId: resolveInitialWorkspaceProfileId(current, now),
          }),
        })
          .then(() => {
            initialized = true;
          })
          .catch((cause: unknown) => {
            startup = undefined;
            throw cause;
          }));
    void attempt
      .then(() => {
        if (mounted) setReady(true);
      })
      .catch(() => {
        if (mounted) setError(true);
      });
    return () => {
      mounted = false;
    };
  }, [preferencesLoaded, save, error, ready]);
  if (ready || initialized) return children;
  if (!error) return null;
  return (
    <View className="flex-1 items-center justify-center gap-4 bg-screen">
      <AppText>Could not load profile preferences.</AppText>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setError(false);
        }}
      >
        <AppText>Retry</AppText>
      </Pressable>
    </View>
  );
}
