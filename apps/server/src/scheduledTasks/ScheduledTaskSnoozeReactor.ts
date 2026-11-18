import { CommandId, type OrchestrationV2DomainEvent, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "./ScheduledTaskService.ts";

const isCompletedRun = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }> =>
  event.type === "run.updated" && event.payload.status === "completed";

export class ScheduledTaskSnoozeReactor extends Context.Service<
  ScheduledTaskSnoozeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledTaskSnoozeReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const tasks = yield* ScheduledTasks.ScheduledTaskService;

  // Runs for every domain event; most events return before any work is needed.
  const handle: ScheduledTaskSnoozeReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (!isCompletedRun(event)) return;
      const enabled = yield* settings.withSettingsSnapshot(
        (snapshot) => Effect.succeed(snapshot.snoozeThreadsUntilScheduledTask),
        { materializeSecrets: false },
      );
      if (!enabled) return;
      const run = event.payload;
      const { messages, runs } = yield* projections.getThreadRecords(
        event.threadId,
        ["messages", "runs"],
        { messageIds: [run.userMessageId], latestRunLimit: 1 },
      );
      if (runs[0]?.id !== run.id || runs[0].status !== "completed") return;
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      if (message?.notification !== undefined || message?.delegatedCompletion !== undefined) {
        return;
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scheduleChanged = yield* tasks.subscribeChanges;
          if (message?.scheduledTaskId !== undefined) {
            // A first launch can complete before its task is bound to the new thread.
            while (true) {
              const pending = yield* tasks.pendingDispatch(
                message.scheduledTaskId,
                run.userMessageId,
                event.threadId,
              );
              if (pending === undefined) break;
              const settled = yield* Effect.raceFirst(
                pending.pipe(Effect.as(true)),
                scheduleChanged.pipe(Effect.as(false)),
              );
              if (settled) break;
            }
          }
          const upcoming = yield* tasks.resolveThreadSchedule(event.threadId, yield* DateTime.now);
          if (upcoming.nextRun === null && !upcoming.hasRunningTask) return;

          let waits: ReadonlyArray<Effect.Effect<void>> = [];
          const nextRun = (now: DateTime.Utc) =>
            tasks.resolveThreadSchedule(event.threadId, now).pipe(
              Effect.map((schedule) => {
                waits = schedule.waits;
                return schedule.nextRun;
              }),
            );
          // Completion can be re-emitted by checkpoints and delegated rewrites.
          let commandId = CommandId.make(`server:scheduled-task-snooze:${run.id}`);
          while (true) {
            const result = yield* engine.autoSnoozeAfterRun({
              commandId,
              threadId: event.threadId,
              runId: run.id,
              nextRun,
            });
            if (result.outcome !== "no-next-run" || waits.length === 0) return;
            commandId = result.commandId;
            yield* Effect.raceAll([...waits, scheduleChanged]);
          }
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("snoozing a thread until its scheduled task failed", {
                threadId: event.threadId,
                cause,
              }),
        ),
      ),
  );

  const start = Effect.fn("ScheduledTaskSnoozeReactor.start")(function* () {
    const inFlight = yield* FiberMap.make<ThreadId, void, never>();
    const activeOrdinals = new Map<ThreadId, number>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (!isCompletedRun(event)) return Effect.void;
        const {
          threadId,
          payload: { ordinal },
        } = event;
        const previous = activeOrdinals.get(threadId);
        if (previous !== undefined && previous >= ordinal) return Effect.void;
        activeOrdinals.set(threadId, ordinal);
        return FiberMap.run(
          inFlight,
          threadId,
          handle(event).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (activeOrdinals.get(threadId) === ordinal) activeOrdinals.delete(threadId);
              }),
            ),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled task snooze event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies ScheduledTaskSnoozeReactor["Service"];
});

export const layer = Layer.effect(ScheduledTaskSnoozeReactor, make);
