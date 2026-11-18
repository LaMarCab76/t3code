import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
      const { snoozeThreadsUntilScheduledTask } = yield* settings.getSettings;
      if (!snoozeThreadsUntilScheduledTask) return;
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
      if ((yield* nextRun(yield* DateTime.now)) === null) return;
      if (!(yield* settings.getSettings).snoozeThreadsUntilScheduledTask) return;

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
    const threadReactions = yield* KeyedLock.makeRunner<ThreadId>();
    const inFlight = new Set<RunId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (!isCompletedRun(event) || inFlight.has(event.payload.id)) return Effect.void;
        const runId = event.payload.id;
        inFlight.add(runId);
        return threadReactions.run(
          event.threadId,
          handle(event).pipe(Effect.ensuring(Effect.sync(() => void inFlight.delete(runId)))),
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
