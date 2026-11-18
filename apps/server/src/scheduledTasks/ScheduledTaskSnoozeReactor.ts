import { CommandId, type OrchestrationV2DomainEvent, type RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
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
  const sql = yield* SqlClient.SqlClient;
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
      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      if (message?.notification !== undefined || message?.delegatedCompletion !== undefined) {
        return;
      }
      if (message?.scheduledTaskId !== undefined) {
        // A fast turn can finish before the scheduler commits the next occurrence.
        const pending = yield* tasks.pendingDispatch(message.scheduledTaskId, run.userMessageId);
        if (pending !== undefined) yield* pending;
      }
      const nextRun = (now: DateTime.Utc) =>
        ScheduledTasks.nextRunForThread(event.threadId, now).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      // Capture dispatches before the read so a commit between lookup and wait cannot be missed.
      const dispatches = yield* tasks.pendingDispatches;
      if ((yield* nextRun(yield* DateTime.now)) === null) {
        if (dispatches.size === 0) return;
        const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
          messageIds: Array.from(dispatches.values(), (dispatch) => dispatch.messageId),
        });
        const waits = messages.flatMap((message) => {
          if (message.scheduledTaskId === undefined) return [];
          const dispatch = dispatches.get(message.scheduledTaskId);
          return dispatch?.messageId === message.id ? [dispatch.settled] : [];
        });
        let upcoming: DateTime.Utc | null = null;
        while (waits.length > 0 && upcoming === null) {
          const settled = yield* Effect.raceAll(
            waits.map((wait, index) => wait.pipe(Effect.as(index))),
          );
          waits.splice(settled, 1);
          upcoming = yield* nextRun(yield* DateTime.now);
        }
        if (upcoming === null) return;
      }

      // Completion can be re-emitted by checkpoints and delegated rewrites.
      yield* engine.autoSnoozeAfterRun({
        commandId: CommandId.make(`server:scheduled-task-snooze:${run.id}`),
        threadId: event.threadId,
        runId: run.id,
        nextRun,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("snoozing a thread until its scheduled task failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start = Effect.fn("ScheduledTaskSnoozeReactor.start")(function* () {
    const inFlight = yield* FiberMap.make<RunId, void, never>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (!isCompletedRun(event)) return Effect.void;
        return FiberMap.run(inFlight, event.payload.id, handle(event), { onlyIfMissing: true });
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
