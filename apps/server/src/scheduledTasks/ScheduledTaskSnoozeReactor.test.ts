import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ScheduledTaskSnoozeReactor from "./ScheduledTaskSnoozeReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = (
  snoozeThreadsUntilScheduledTask: boolean,
  pendingDispatch: ScheduledTaskService.ScheduledTaskService["Service"]["pendingDispatch"] = () =>
    Effect.undefined,
  wrapOrchestrator: (
    engine: Orchestrator.OrchestratorV2["Service"],
  ) => Orchestrator.OrchestratorV2["Service"] = (engine) => engine,
  pendingDispatches: Parameters<typeof ScheduledTaskService.readThreadSchedule>[2] = undefined,
  wrapEventSink?: (sink: EventSink.EventSinkV2Shape) => EventSink.EventSinkV2Shape,
  subscribeChanges: ScheduledTaskService.ScheduledTaskService["Service"]["subscribeChanges"] = Effect.succeed(
    Effect.never,
  ),
) => {
  const settingsLayer = ServerSettings.layerTest({ snoozeThreadsUntilScheduledTask }).pipe(
    Layer.orDie,
  );
  const replayLayer = ProviderReplayHarness.layerWithRegistry(
    { name: "scheduled-task-snooze" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      settingsLayer,
      ...(wrapEventSink === undefined ? {} : { wrapEventSink }),
    },
  );
  return ScheduledTaskSnoozeReactor.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        settingsLayer,
        Layer.unwrap(
          SqlClient.SqlClient.pipe(
            Effect.map((sql) =>
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                pendingDispatch,
                resolveThreadSchedule: (threadId, now) =>
                  ScheduledTaskService.readThreadSchedule(threadId, now, pendingDispatches).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
                subscribeChanges,
              }),
            ),
          ),
        ).pipe(Layer.provide(layerDatabase)),
        Layer.effect(
          Orchestrator.OrchestratorV2,
          Effect.map(Orchestrator.OrchestratorV2, wrapOrchestrator),
        ).pipe(Layer.provideMerge(replayLayer)),
      ),
    ),
  );
};

const threadId = ThreadId.make("thread:scheduled-snooze");
const NEXT_RUN = "2030-01-01T09:00:00.000Z";

const insertTask = (
  sql: SqlClient.SqlClient,
  task: {
    id: string;
    threadId: string;
    next: string | null;
    enabled?: number;
    running?: boolean;
    webhook?: boolean;
  },
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: task.id,
    title: "task",
    prompt: "Run task",
    enabled: task.enabled ?? 1,
    schedule_json:
      task.webhook === true ? '{"type":"webhook"}' : '{"type":"interval","everyMs":60000}',
    project_id: "project:scheduled-snooze",
    thread_id: task.threadId,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    next_run_at: task.next,
    last_run_at: null,
    last_run_status: task.running === true ? "running" : "never",
    last_run_error: null,
    run_count: 0,
  })}`;

/** Starts a turn from `message`, writes its completion, and optionally hands it to the reactor. */
const completeTurn = Effect.fn("test.completeTurn")(function* (
  message: { scheduledTaskId?: ScheduledTaskId } = {},
  options: {
    threadId?: ThreadId;
    ordinal?: number;
    observe?: boolean;
    queueAnother?: boolean;
    pendingQuestion?: boolean;
    pendingLink?: boolean;
    sendBeforeHandle?: boolean;
    snoozeBeforeComplete?: boolean;
  } = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
  const targetThreadId = options.threadId ?? threadId;
  const ordinal = options.ordinal ?? 1;
  const turnKey = `${targetThreadId}:${ordinal}`;
  if (ordinal === 1)
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-scheduled-snooze:${targetThreadId}`),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:scheduled-snooze"),
      title: "Scheduled snooze",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send-scheduled-snooze:${turnKey}`),
    threadId: targetThreadId,
    messageId: MessageId.make(`message:scheduled-snooze:${turnKey}`),
    text: "Schedule a daily check",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...message,
  });
  if (options.queueAnother === true) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queue-scheduled-snooze"),
      threadId: targetThreadId,
      messageId: MessageId.make("message:scheduled-snooze-queued"),
      text: "And another thing",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
  }
  const { runs } = yield* projections.getThreadRecords(targetThreadId, ["runs"]);
  const run = runs.find((candidate) => candidate.ordinal === ordinal)!;
  const now = yield* DateTime.now;
  if (options.snoozeBeforeComplete) {
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("manual-scheduled-snooze"),
      threadId: targetThreadId,
      snoozedUntil: "2031-01-01T00:00:00.000Z",
    });
  }
  const events: OrchestrationV2DomainEvent[] = [];
  if (options.pendingLink === true) {
    events.push({
      id: EventId.make("event:scheduled-snooze-link"),
      type: "turn-item.updated",
      threadId: targetThreadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:scheduled-snooze-link"),
        threadId: targetThreadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "link_request",
        status: "waiting",
        title: "Link laptop",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        reason: "Link laptop",
        linkStatus: "pending",
      },
    });
  }
  if (options.pendingQuestion === true) {
    events.push({
      id: EventId.make("event:scheduled-snooze-question"),
      type: "runtime-request.updated",
      threadId: targetThreadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:scheduled-snooze"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
  }
  const completed = {
    id: EventId.make(`event:scheduled-snooze-completed:${turnKey}`),
    type: "run.updated",
    threadId: targetThreadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "completed", startedAt: now, completedAt: now },
  } satisfies OrchestrationV2DomainEvent;
  events.push(completed);
  yield* eventSink.write({ events });
  if (options.sendBeforeHandle === true) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("follow-up-scheduled-snooze"),
      threadId: targetThreadId,
      messageId: MessageId.make("message:scheduled-snooze-follow-up"),
      text: "One more thing",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  }
  if (options.observe !== false) yield* reactor.handle(completed);
  return completed;
});

const snoozedUntil = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const thread = yield* projections.getThread(threadId);
  return thread.snoozedUntil == null ? null : DateTime.formatIso(thread.snoozedUntil);
});

it.effect.each([false, true])(
  "preserves manual wakes after completion with prior snooze %s",
  (snoozeBeforeComplete) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertTask(sql, { id: "later", threadId, next: "2030-02-01T00:00:00.000Z" });
      yield* insertTask(sql, { id: "soonest", threadId, next: NEXT_RUN });
      yield* insertTask(sql, {
        id: "paused",
        threadId,
        next: "2029-06-01T00:00:00.000Z",
        enabled: 0,
      });
      yield* insertTask(sql, { id: "overdue", threadId, next: "1969-01-01T00:00:00.000Z" });
      yield* insertTask(sql, {
        id: "overdue-with-offset",
        threadId,
        next: "1970-01-01T01:00:00.000+03:00",
      });
      yield* insertTask(sql, { id: "webhook", threadId, next: null });
      yield* insertTask(sql, {
        id: "other",
        threadId: "thread:other",
        next: "2029-06-01T00:00:00.000Z",
      });
      const completed = yield* completeTurn({}, { snoozeBeforeComplete });
      assert.strictEqual(
        yield* snoozedUntil,
        snoozeBeforeComplete ? "2031-01-01T00:00:00.000Z" : NEXT_RUN,
      );

      // A re-emitted completion must not undo a manual wake.
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("wake-scheduled-snooze"),
        threadId,
        reason: "user",
      });
      const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
      yield* reactor.handle(completed);
      assert.strictEqual(yield* snoozedUntil, null);
    }).pipe(Effect.provide(layerTest(true))),
);

it.effect.each([
  { name: "the setting is off", setting: false },
  { name: "another run is still queued", setting: true, queueAnother: true },
  { name: "the turn ended on a question", setting: true, pendingQuestion: true },
  { name: "a link card awaits the user", setting: true, pendingLink: true },
  { name: "a message arrives before the snooze", setting: true, sendBeforeHandle: true },
])("leaves the thread awake when $name", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, { id: "soonest", threadId, next: NEXT_RUN });
    yield* completeTurn({}, scenario);
    assert.strictEqual(yield* snoozedUntil, null);
  }).pipe(Effect.provide(layerTest(scenario.setting))),
);

it.effect.each([
  { next: NEXT_RUN, taskId: "current", expected: NEXT_RUN },
  { next: NEXT_RUN, taskId: "follow-up", expected: NEXT_RUN },
  { next: null, taskId: "current", expected: null },
])("uses the remaining schedule after a task runs: $taskId / $next", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertTask(sql, { id: scenario.taskId, threadId, next: scenario.next });
    yield* completeTurn({ scheduledTaskId: ScheduledTaskId.make("current") });
    assert.strictEqual(yield* snoozedUntil, scenario.expected);
  }).pipe(Effect.provide(layerTest(true))),
);

it.effect.each([
  { pending: true, expected: NEXT_RUN },
  { pending: false, expected: null },
])("evaluates snooze after a dispatch lookup with a pending wait: $pending", (scenario) =>
  Effect.gen(function* () {
    const dispatchReached = yield* Deferred.make<ScheduledTaskId>();
    const dispatchReleased = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      const current = ScheduledTaskId.make("current");
      yield* insertTask(sql, { id: current, threadId, next: null });
      yield* insertTask(sql, { id: "later", threadId, next: "2030-02-01T00:00:00.000Z" });
      const completion = yield* completeTurn({ scheduledTaskId: current }).pipe(Effect.forkScoped);
      assert.strictEqual(yield* Deferred.await(dispatchReached), current);
      assert.strictEqual(yield* snoozedUntil, null);
      if (!scenario.pending) {
        yield* settings.updateSettings({ snoozeThreadsUntilScheduledTask: false });
      }
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${NEXT_RUN} WHERE task_id = ${current}`;
      yield* Deferred.succeed(dispatchReleased, undefined);
      yield* Fiber.join(completion);
      assert.strictEqual(yield* snoozedUntil, scenario.expected);
    }).pipe(
      Effect.provide(
        layerTest(true, (id) => {
          const reached = Deferred.succeed(dispatchReached, id).pipe(
            Effect.andThen(Deferred.await(dispatchReleased)),
          );
          return scenario.pending ? Effect.succeed(reached) : reached.pipe(Effect.as(undefined));
        }),
      ),
    );
  }),
);

it.effect.each([
  "committed",
  "pending",
  "replacing",
  "paused before write",
  "paused while waiting",
  "running webhook",
] as const)("reacts to newer turns and other threads when the next occurrence is %s", (schedule) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const changes = yield* PubSub.sliding<void>(1);
    const dispatchStarted = yield* Deferred.make<void>();
    const retiredWait = yield* Deferred.make<void>();
    const releaseDispatch = yield* Deferred.make<void>();
    const paused = yield* Ref.make(false);
    const waits = yield* Ref.make(0);
    const newerWaitStarted = yield* Deferred.make<void>();
    const beforeWriter = yield* Deferred.make<void>();
    const gateNextWriter = yield* Ref.make(false);
    const allowWriter = yield* Deferred.make<void>();
    const activeTaskId = ScheduledTaskId.make("dispatch-in-progress");
    const dispatches = yield* Ref.make(
      new Map<ScheduledTaskId, { messageId: MessageId; settled: Effect.Effect<void> }>(),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventSink.EventSinkV2;
      const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
      const otherThreadId = ThreadId.make("thread:other");
      const waitForSnooze = (threadId: ThreadId) =>
        events
          .stream({ threadId, eventType: "thread.snoozed", afterSequence: 0 })
          .pipe(Stream.runHead);

      yield* insertTask(sql, {
        id: activeTaskId,
        threadId,
        next:
          schedule === "committed"
            ? NEXT_RUN
            : schedule === "replacing"
              ? "2029-01-01T00:00:00.000Z"
              : null,
        running: schedule !== "committed" && schedule !== "paused before write",
        webhook: schedule === "running webhook",
      });
      if (schedule === "paused before write") {
        yield* insertTask(sql, { id: "paused-candidate", threadId, next: NEXT_RUN });
      }
      if (schedule === "paused while waiting" || schedule === "running webhook") {
        yield* insertTask(sql, { id: "timed-candidate", threadId, next: NEXT_RUN });
      }
      yield* insertTask(sql, { id: "other-next", threadId: otherThreadId, next: NEXT_RUN });
      yield* reactor.start();
      const scheduled = yield* completeTurn({ scheduledTaskId: activeTaskId }, { observe: false });
      yield* Ref.set(
        dispatches,
        new Map([
          [
            activeTaskId,
            {
              messageId: scheduled.payload.userMessageId,
              settled: Deferred.succeed(newerWaitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDispatch)),
              ),
            },
          ],
        ]),
      );
      yield* Queue.offer(input, scheduled);
      yield* Deferred.await(dispatchStarted);
      yield* Queue.offer(input, {
        ...scheduled,
        id: EventId.make("event:re-emitted-completion"),
      });

      const other = yield* completeTurn({}, { threadId: otherThreadId, observe: false });
      yield* Queue.offer(input, other);
      yield* waitForSnooze(otherThreadId);
      assert.strictEqual(yield* snoozedUntil, null);

      const newer = yield* completeTurn({}, { ordinal: 2, observe: false });
      if (schedule === "paused before write") yield* Ref.set(gateNextWriter, true);
      yield* Queue.offer(input, newer);
      if (schedule === "paused before write") {
        yield* Deferred.await(beforeWriter);
        yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'paused-candidate'`;
        yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running' WHERE task_id = ${activeTaskId}`;
        yield* Deferred.succeed(allowWriter, undefined);
      }
      if (schedule !== "committed") {
        const waiting = yield* Effect.raceFirst(
          Deferred.await(newerWaitStarted).pipe(Effect.as(true)),
          waitForSnooze(threadId).pipe(Effect.as(false)),
        );
        assert.strictEqual(waiting, schedule !== "running webhook");
        if (schedule === "pending") {
          yield* Deferred.await(retiredWait);
          yield* Queue.offer(input, { ...scheduled, id: EventId.make("event:late-older-turn") });
        }
        if (schedule === "paused while waiting") {
          yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = ${activeTaskId}`;
          yield* Ref.set(paused, true);
          yield* PubSub.publish(changes, undefined);
        } else if (waiting) {
          assert.strictEqual(yield* snoozedUntil, null);
          yield* sql`UPDATE scheduled_tasks SET next_run_at = ${NEXT_RUN}, last_run_status = 'succeeded' WHERE task_id = ${activeTaskId}`;
          yield* Ref.set(dispatches, new Map());
          yield* Deferred.succeed(releaseDispatch, undefined);
        }
      }
      yield* waitForSnooze(threadId);
      assert.strictEqual(yield* snoozedUntil, NEXT_RUN);
      assert.strictEqual(yield* Ref.get(waits), 1);
      yield* Deferred.succeed(releaseDispatch, undefined);
    }).pipe(
      Effect.provide(
        layerTest(
          true,
          () =>
            Ref.get(paused).pipe(
              Effect.map((paused) =>
                paused
                  ? undefined
                  : Ref.update(waits, (count) => count + 1).pipe(
                      Effect.andThen(Deferred.succeed(dispatchStarted, undefined)),
                      Effect.andThen(Deferred.await(releaseDispatch)),
                      Effect.ensuring(Deferred.succeed(retiredWait, undefined)),
                    ),
              ),
            ),
          (engine) => ({ ...engine, streamDomainEvents: Stream.fromQueue(input) }),
          Ref.get(dispatches),
          (sink) => ({
            ...sink,
            withProviderBatch: (write, beforeCommit) =>
              Ref.getAndSet(gateNextWriter, false).pipe(
                Effect.flatMap((gate) =>
                  gate
                    ? Deferred.succeed(beforeWriter, undefined).pipe(
                        Effect.andThen(Deferred.await(allowWriter)),
                      )
                    : Effect.void,
                ),
                Effect.andThen(sink.withProviderBatch(write, beforeCommit)),
              ),
          }),
          PubSub.subscribe(changes).pipe(Effect.map(PubSub.take)),
        ),
      ),
    );
  }),
);

it.effect("keeps the thread awake when disabled while the snooze waits for its lock", () =>
  Effect.gen(function* () {
    const lockAcquired = yield* Deferred.make<void>();
    const beforeSnoozeLock = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
      yield* insertTask(sql, { id: "next", threadId, next: NEXT_RUN });
      const completed = yield* completeTurn({}, { observe: false });
      yield* locks
        .withLock(
          threadId,
          Deferred.succeed(lockAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLock)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lockAcquired);
      const attempt = yield* reactor.handle(completed).pipe(Effect.forkScoped);
      yield* Deferred.await(beforeSnoozeLock);
      yield* settings.updateSettings({ snoozeThreadsUntilScheduledTask: false });
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(attempt);
      assert.strictEqual(yield* snoozedUntil, null);
    }).pipe(
      Effect.provide(
        layerTest(true, undefined, (engine) => ({
          ...engine,
          autoSnoozeAfterRun: (input) =>
            Deferred.succeed(beforeSnoozeLock, undefined).pipe(
              Effect.andThen(engine.autoSnoozeAfterRun(input)),
            ),
        })),
      ),
    );
  }),
);

it.effect("keeps a question committed before the SQLite writer visible", () =>
  Effect.gen(function* () {
    const beforeWriter = yield* Deferred.make<void>();
    const allowWriter = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventSink.EventSinkV2;
      const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
      yield* insertTask(sql, { id: "next", threadId, next: NEXT_RUN });
      const completed = yield* completeTurn({}, { observe: false });
      const attempt = yield* reactor.handle(completed).pipe(Effect.forkScoped);
      yield* Deferred.await(beforeWriter);
      const now = yield* DateTime.now;
      yield* events.write({
        events: [
          {
            id: EventId.make("event:question-before-snooze-writer"),
            type: "runtime-request.updated",
            threadId,
            runId: completed.payload.id,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("request:question-before-snooze-writer"),
              nodeId: completed.payload.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      yield* Deferred.succeed(allowWriter, undefined);
      yield* Fiber.join(attempt);
      assert.strictEqual(yield* snoozedUntil, null);
    }).pipe(
      Effect.provide(
        layerTest(true, undefined, undefined, undefined, (sink) => ({
          ...sink,
          withProviderBatch: (write, beforeCommit) =>
            Deferred.succeed(beforeWriter, undefined).pipe(
              Effect.andThen(Deferred.await(allowWriter)),
              Effect.andThen(sink.withProviderBatch(write, beforeCommit)),
            ),
        })),
      ),
    );
  }),
);

it.effect.each([
  { expiring: 1, hasLaterDate: true, expires: "during lookup" },
  { expiring: 1, hasLaterDate: false, expires: "during lookup" },
  { expiring: 2, hasLaterDate: true, expires: "during lookup" },
  { expiring: 2, hasLaterDate: false, expires: "during lookup" },
  { expiring: 1, hasLaterDate: true, expires: "before commit" },
  { expiring: 1, hasLaterDate: false, expires: "before commit" },
  { expiring: 1, hasLaterDate: true, expires: "after commit" },
  { expiring: 1, hasLaterDate: false, expires: "after commit" },
])(
  "handles $expiring expiring deadlines with another date: $hasLaterDate, expires $expires",
  ({ expiring, hasLaterDate, expires }) =>
    Effect.gen(function* () {
      const outcomes = yield* Ref.make<ReadonlyArray<string>>([]);
      const initialTime = yield* DateTime.now;
      const expiringDates = Array.from({ length: expiring }, (_, index) =>
        DateTime.formatIso(DateTime.add(initialTime, { milliseconds: index + 1 })),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          expiringDates,
          (next, index) => insertTask(sql, { id: `expiring-${index}`, threadId, next }),
          { discard: true },
        );
        if (hasLaterDate) yield* insertTask(sql, { id: "later", threadId, next: NEXT_RUN });
        const completed = yield* completeTurn();
        assert.deepEqual(yield* Ref.get(outcomes), [hasLaterDate ? "snoozed" : "no-next-run"]);
        assert.strictEqual(yield* snoozedUntil, hasLaterDate ? NEXT_RUN : null);
        const sink = yield* EventSink.EventSinkV2;
        const snoozes = sink
          .readByCommandId({
            commandId: CommandId.make(`server:scheduled-task-snooze:${completed.runId}`),
          })
          .pipe(
            Stream.filter(({ event }) => event.type === "thread.snoozed"),
            Stream.runCount,
          );
        assert.strictEqual(yield* snoozes, hasLaterDate || expires === "after commit" ? 1 : 0);
        if (!hasLaterDate && expires === "after commit") {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const thread = yield* projections.getThread(threadId);
          assert.isNull(thread.snoozedAt);
          assert.isNull(thread.lastSnoozeWakeAt ?? null);
        }
        if (!hasLaterDate) {
          const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
          yield* insertTask(sql, { id: "later", threadId, next: NEXT_RUN });
          yield* reactor.handle(completed);
          assert.deepEqual(yield* Ref.get(outcomes), ["no-next-run", "snoozed"]);
          assert.strictEqual(yield* snoozedUntil, NEXT_RUN);
          assert.strictEqual(yield* snoozes, 1);
        } else if (expires === "after commit") {
          const reactor = yield* ScheduledTaskSnoozeReactor.ScheduledTaskSnoozeReactor;
          yield* TestClock.setTime(Date.parse(NEXT_RUN));
          yield* insertTask(sql, {
            id: "after-natural-wake",
            threadId,
            next: "2031-01-01T00:00:00.000Z",
          });
          yield* reactor.handle(completed);
          assert.strictEqual(yield* snoozedUntil, NEXT_RUN);
        }
      }).pipe(
        Effect.provide(
          layerTest(
            true,
            undefined,
            (engine) => ({
              ...engine,
              autoSnoozeAfterRun: (attempt) =>
                engine
                  .autoSnoozeAfterRun({
                    ...attempt,
                    nextRun: (now) =>
                      attempt
                        .nextRun(now)
                        .pipe(
                          Effect.tap((candidate) =>
                            expires === "during lookup" &&
                            candidate !== null &&
                            expiringDates.includes(DateTime.formatIso(candidate))
                              ? TestClock.adjust(1)
                              : Effect.void,
                          ),
                        ),
                  })
                  .pipe(
                    Effect.tap(({ outcome }) => Ref.update(outcomes, (all) => [...all, outcome])),
                  ),
            }),
            undefined,
            (sink) => ({
              ...sink,
              withProviderBatch: (write, beforeCommit) =>
                sink
                  .withProviderBatch(write, beforeCommit)
                  .pipe(
                    Effect.tap(() =>
                      expires === "after commit"
                        ? DateTime.now.pipe(
                            Effect.flatMap((now) =>
                              DateTime.formatIso(now) === DateTime.formatIso(initialTime)
                                ? TestClock.adjust(1)
                                : Effect.void,
                            ),
                          )
                        : Effect.void,
                    ),
                  ),
              commitCommand: (command) =>
                sink
                  .commitCommand(command)
                  .pipe(
                    Effect.tap(({ storedEvents }) =>
                      expires === "before commit" &&
                      storedEvents.some(
                        ({ event }) =>
                          event.type === "thread.snoozed" &&
                          event.payload.snoozedUntil != null &&
                          expiringDates.includes(DateTime.formatIso(event.payload.snoozedUntil)),
                      )
                        ? TestClock.adjust(1)
                        : Effect.void,
                    ),
                  ),
            }),
          ),
        ),
      );
    }),
);
