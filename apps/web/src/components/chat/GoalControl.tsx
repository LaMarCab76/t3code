import { useEffect, useState } from "react";
import { useParams } from "@tanstack/react-router";
import type { NativeGoalState, ProviderGoalInput } from "@t3tools/contracts";
import { useThreadShell, useServerConfigs } from "../../state/entities";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function GoalControl() {
  const ref = useParams({ strict: false, select: resolveThreadRouteRef });
  const thread = useThreadShell(ref);
  const configs = useServerConfigs();
  const config = ref ? configs.get(ref.environmentId) : undefined;
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
        provider.instanceId === thread?.modelSelection.instanceId && provider.driver === "codex",
    );
  const state = thread?.session?.nativeGoal ?? confirmed;
  useEffect(() => {
    if (!supported || !ref || !thread?.session || thread.session.nativeGoal) return;
    let current = true;
    void request({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, action: "get" },
    }).then((result) => {
      if (current && result._tag === "Success") setConfirmed(result.value);
    });
    return () => {
      current = false;
    };
  }, [supported, ref, thread?.session, request]);
  if (!supported || !ref || !thread) return null;
  const perform = async (input: Omit<ProviderGoalInput, "threadId">) => {
    setBusy(true);
    setError(null);
    try {
      const result = await request({
        environmentId: ref.environmentId,
        input: { ...input, threadId: ref.threadId },
      });
      if (result._tag === "Success") setConfirmed(result.value);
      else setError("Could not update the goal. Check the provider connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  const goal = state?.goal;
  return (
    <div className="grid gap-2 px-3 py-2 text-sm">
      {goal ? (
        <>
          <p className="break-words">
            <strong>Goal:</strong> {goal.objective}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {goal.status} · {goal.tokensUsed.toLocaleString()} tokens
              {goal.tokenBudget != null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} ·{" "}
              {Math.round(goal.timeUsedSeconds)}s
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void perform({
                  action: "set",
                  status: goal.status === "active" ? "paused" : "active",
                });
              }}
            >
              {goal.status === "active" ? "Pause" : "Resume"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setObjective(goal.objective);
                setBudget(goal.tokenBudget != null ? String(goal.tokenBudget) : "");
                setOpen((value) => !value);
              }}
            >
              Edit goal
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void perform({ action: "clear" });
              }}
            >
              Remove goal
            </Button>
          </div>
        </>
      ) : state?.available === false ? (
        <p>Native Goal is unavailable in this version of Codex.</p>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
          Set goal
        </Button>
      )}
      {open && state?.available !== false ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const tokenBudget = budget.trim() ? Number(budget) : null;
            if (
              !objective.trim() ||
              (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
            ) {
              setError(
                "Enter an objective and a positive token budget, or leave the budget empty.",
              );
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
          <Input
            aria-label="Goal objective"
            placeholder="What should the agent achieve?"
            value={objective}
            maxLength={4000}
            onChange={(event) => setObjective(event.target.value)}
          />
          <Input
            aria-label="Goal token budget"
            placeholder="Token budget (optional)"
            inputMode="numeric"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          <Button size="sm" disabled={busy} type="submit">
            {goal ? "Update and resume goal" : "Start goal"}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
