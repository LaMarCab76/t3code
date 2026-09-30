import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ProviderGoalInput,
  NativeGoalState,
} from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";

export function GoalControl(props: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const request = useAtomCommand(threadEnvironment.goal, "native goal");
  const [confirmed, setConfirmed] = useState<NativeGoalState | null>(null);
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported =
    config?.environment.capabilities.nativeGoals === true &&
    config.providers.some(
      (provider) =>
        provider.instanceId === props.thread.modelSelection.instanceId &&
        provider.driver === "codex",
    );
  useEffect(() => {
    if (!supported || !props.thread.session || props.thread.session.nativeGoal) return;
    let current = true;
    void request({
      environmentId: props.environmentId,
      input: { threadId: props.thread.id, action: "get" },
    }).then((result) => {
      if (current && result._tag === "Success") setConfirmed(result.value);
    });
    return () => {
      current = false;
    };
  }, [supported, props.environmentId, props.thread.id, props.thread.session, request]);
  if (!supported) return null;
  const state = props.thread.session?.nativeGoal ?? confirmed;
  const perform = async (input: Omit<ProviderGoalInput, "threadId">) => {
    setBusy(true);
    setError(null);
    try {
      const result = await request({
        environmentId: props.environmentId,
        input: { ...input, threadId: props.thread.id },
      });
      if (result._tag === "Success") setConfirmed(result.value);
      else setError("Could not update the goal. Check the provider connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  const goal = state?.goal;
  return (
    <View className="gap-2 px-3 py-2">
      {goal ? (
        <>
          <Text className="text-sm text-foreground">Goal: {goal.objective}</Text>
          <Text className="text-xs text-foreground-muted">
            {goal.status} · {goal.tokensUsed} tokens
            {goal.tokenBudget != null ? ` / ${goal.tokenBudget}` : ""} ·{" "}
            {Math.round(goal.timeUsedSeconds)}s
          </Text>
          <View className="flex-row gap-4">
            <Pressable
              disabled={busy}
              onPress={() => {
                void perform({
                  action: "set",
                  status: goal.status === "active" ? "paused" : "active",
                });
              }}
            >
              <Text className="text-foreground">
                {goal.status === "active" ? "Pause" : "Resume"}
              </Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() => {
                setObjective(goal.objective);
                setBudget(goal.tokenBudget != null ? String(goal.tokenBudget) : "");
                setOpen((value) => !value);
              }}
            >
              <Text className="text-foreground">Edit goal</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() => {
                void perform({ action: "clear" });
              }}
            >
              <Text className="text-foreground">Remove goal</Text>
            </Pressable>
          </View>
        </>
      ) : state?.available === false ? (
        <Text className="text-foreground-muted">
          Native Goal is unavailable in this version of Codex.
        </Text>
      ) : (
        <Pressable onPress={() => setOpen((value) => !value)}>
          <Text className="text-foreground">Set goal</Text>
        </Pressable>
      )}
      {open && state?.available !== false ? (
        <>
          <TextInput
            accessibilityLabel="Goal objective"
            placeholder="What should the agent achieve?"
            value={objective}
            maxLength={4000}
            onChangeText={setObjective}
            className="rounded-md border border-border p-2 text-foreground"
          />
          <TextInput
            accessibilityLabel="Goal token budget"
            placeholder="Token budget (optional)"
            value={budget}
            keyboardType="number-pad"
            onChangeText={setBudget}
            className="rounded-md border border-border p-2 text-foreground"
          />
          <Pressable
            disabled={busy}
            onPress={() => {
              const tokenBudget = budget.trim() ? Number(budget) : null;
              if (
                !objective.trim() ||
                (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
              ) {
                setError("Enter an objective and a positive budget, or leave the budget empty.");
                return;
              }
              void perform({
                action: "set",
                objective: objective.trim(),
                status: "active",
                tokenBudget,
              });
            }}
          >
            <Text className="text-foreground">
              {goal ? "Update and resume goal" : "Start goal"}
            </Text>
          </Pressable>
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
