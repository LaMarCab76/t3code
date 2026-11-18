import { CommandId, type OrchestrationV2DomainEvent, type RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
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

  const waitingRuns = new Set<RunId>();
  const logFailure = (event: OrchestrationV2DomainEvent) =>
    Effect.catchCause((cause) =>
      Effect.logWarning("snoozing a thread until its scheduled task failed", {
        threadId: event.threadId,
        cause,
      }),
    );

  // Runs for every domain event; most events return before any work is needed.
  const handle = Effect.fnUntraced(
    function* (event: OrchestrationV2DomainEvent, scope: Scope.Scope | undefined) {
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
      const pending =
        message?.scheduledTaskId === undefined
          ? undefined
          : yield* tasks.pendingDispatch(message.scheduledTaskId, run.userMessageId);
      // Completion can be re-emitted by checkpoints and delegated rewrites.
      const snooze = engine.autoSnoozeAfterRun({
        commandId: CommandId.make(`server:scheduled-task-snooze:${run.id}`),
        threadId: event.threadId,
        runId: run.id,
        nextRun: (now) =>
          ScheduledTasks.nextRunForThread(event.threadId, now).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
      });
      if (pending === undefined) {
        yield* snooze;
        return;
      }
      // A fast turn can finish before the scheduler commits the next occurrence.
      const afterDispatch = pending.pipe(
        Effect.andThen(settings.getSettings),
        Effect.flatMap(({ snoozeThreadsUntilScheduledTask }) =>
          snoozeThreadsUntilScheduledTask ? snooze : Effect.void,
        ),
      );
      if (scope === undefined) {
        yield* afterDispatch;
      } else if (!waitingRuns.has(run.id)) {
        waitingRuns.add(run.id);
        yield* afterDispatch.pipe(
          logFailure(event),
          Effect.ensuring(Effect.sync(() => void waitingRuns.delete(run.id))),
          Effect.forkIn(scope),
        );
      }
    },
    (effect, event, _scope) => effect.pipe(logFailure(event)),
  );

  const start = Effect.fn("ScheduledTaskSnoozeReactor.start")(function* () {
    const scope = yield* Effect.scope;
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => handle(event, scope)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled task snooze event stream failed", { cause }),
        ),
      ),
    );
  });

  return {
    start,
    handle: (event) => handle(event, undefined),
  } satisfies ScheduledTaskSnoozeReactor["Service"];
});

export const layer = Layer.effect(ScheduledTaskSnoozeReactor, make);
