import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

const makeThread = (id: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("project"),
  title: "Source",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  lastVisitedAt: null,
});

it.effect("rejects a planned fork whose source was deleted before it committed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const sourceId = ThreadId.make("fork-source");
    const targetId = ThreadId.make("fork-target");
    const source = makeThread(sourceId, now);
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    const plannedFork = {
      commandId: CommandId.make("fork"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("fork-created"),
          type: "thread.created" as const,
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run" as const, threadId: sourceId, runId: RunId.make("run") },
          },
        },
      ],
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    const rejected = yield* sink.commitCommand(plannedFork);
    assert.equal(rejected.receipt.status, "rejected");
    assert.isFalse(rejected.committed);
    const replayed = yield* sink.commitCommand(plannedFork);
    assert.deepEqual(replayed.receipt, rejected.receipt);
    assert.isFalse(replayed.committed);
    const missing = yield* projections.getThread(targetId).pipe(Effect.flip);
    assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([false, true])(
  "persists pre-commit writes only if the check finishes, interrupted: %s",
  (interrupted) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const reachedCheck = yield* Deferred.make<void>();
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("pre-commit-thread");
      const commandId = CommandId.make("pre-commit-write");
      const event = {
        id: EventId.make("pre-commit-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: makeThread(threadId, now),
      } as const;
      const batch = sink.withProviderBatch(Effect.void, () =>
        Effect.gen(function* () {
          yield* sink.write({ events: [event], commandId });
          const nested = yield* Effect.exit(sink.withProviderBatch(Effect.void, () => Effect.void));
          assert.isTrue(Exit.isFailure(nested));
          if (Exit.isFailure(nested)) {
            assert.deepEqual(
              Cause.prettyErrors(nested.cause).map((error) => error.message),
              ["A pre-commit check requires the outermost batch."],
            );
          }
          yield* Deferred.succeed(reachedCheck, undefined);
          if (interrupted) return yield* Effect.never;
        }),
      );
      if (interrupted) {
        const fiber = yield* batch.pipe(Effect.forkScoped);
        yield* Deferred.await(reachedCheck);
        yield* Fiber.interrupt(fiber);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        yield* sink.withProviderBatch(Effect.void);
      } else {
        const sql = yield* SqlClient.SqlClient;
        const nested = yield* Effect.exit(sql.withTransaction(batch));
        assert.isTrue(Exit.isFailure(nested));
        if (Exit.isFailure(nested)) {
          assert.deepEqual(
            Cause.prettyErrors(nested.cause).map((error) => error.message),
            ["A pre-commit check requires the outermost batch."],
          );
        }
        yield* batch;
      }
      const stored = yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.deepEqual(
        stored.map(({ event }) => event.id),
        interrupted ? [] : [event.id],
      );
    }).pipe(Effect.provide(layer)),
);
