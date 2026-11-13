import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2Run,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ThreadInsightsQuery from "./ThreadInsightsQuery.ts";

const now = DateTime.makeUnsafe("2026-11-13T12:00:00Z");
const instance = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const selection = { instanceId: instance, model: "gpt-6.1-sol" };
const layerStore = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layer = ThreadInsightsQuery.layer.pipe(
  Layer.provideMerge(layerStore),
  Layer.provide(
    Layer.mock(UsageService.UsageService)({
      priceRecords: (records) => Effect.succeed(records.map(() => 0.1)),
    }),
  ),
);

const apply = Effect.fn("test.insights.apply")(function* (event: OrchestrationV2DomainEvent) {
  yield* (yield* ProjectionStore.ProjectionStoreV2).apply(event);
});
const thread = Effect.fn("test.insights.thread")(function* (
  name: string,
  parent: ThreadId | null = null,
  relationship: "fork" | "subagent" | null = null,
) {
  const id = ThreadId.make(name);
  yield* apply({
    id: EventId.make(`thread:${name}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: {
      id,
      projectId: ProjectId.make("project"),
      title: name,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instance,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: parent,
        relationshipToParent: relationship,
        rootThreadId: parent ?? id,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return id;
});
const run = Effect.fn("test.insights.run")(function* (
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"] = "completed",
) {
  const id = RunId.make(`${threadId}:run:${ordinal}`);
  const payload: OrchestrationV2Run = {
    id,
    threadId,
    ordinal,
    providerInstanceId: instance,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: MessageId.make(`${id}:message`),
    rootNodeId: NodeId.make(`${id}:node`),
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* apply({
    id: EventId.make(`${id}:event`),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload,
  });
  return payload;
});
const agent = Effect.fn("test.insights.agent")(function* (
  parent: ThreadId,
  child: ThreadId,
  origin: OrchestrationV2Subagent["origin"] = "app_owned",
  remote = false,
) {
  const id = NodeId.make(`${parent}:${child}:agent`);
  yield* apply({
    id: EventId.make(`${id}:event`),
    type: "subagent.updated",
    threadId: parent,
    occurredAt: now,
    payload: {
      id,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make(`${parent}:node`),
      origin,
      createdBy: "agent",
      driver,
      providerInstanceId: instance,
      providerThreadId: ProviderThreadId.make(`${child}:provider`),
      childThreadId: remote ? null : child,
      ...(remote
        ? {
            remoteChild: {
              environmentId: EnvironmentId.make("remote"),
              threadId: child,
              label: "Remote",
            },
          }
        : {}),
      nativeTaskRef: null,
      prompt: "",
      title: child,
      model: selection.model,
      status: "completed",
      result: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  });
});
const usage = (inputTokens: number): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens,
  outputTokens: 10,
  cachedInputTokens: 20,
  cacheCreationTokens: 0,
  hasSubagents: true,
  models: [selection.model],
  otherUsage: { inputTokens: 9000, outputTokens: 9000 },
});
const turn = Effect.fn("test.insights.turn")(function* (
  threadId: ThreadId,
  name: string,
  owner: ThreadId,
  counters?: TurnTokenUsage,
) {
  yield* apply({
    id: EventId.make(`${name}:event`),
    type: "provider-turn.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: ProviderTurnId.make(name),
      providerThreadId: ProviderThreadId.make(`${owner}:provider`),
      nodeId: NodeId.make(`${name}:node`),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: now,
      completedAt: now,
      ...(counters === undefined ? {} : { turnTokenUsage: counters }),
    },
  });
});
const plan = Effect.fn("test.insights.plan")(function* (
  owner: OrchestrationV2Run,
  name: string,
  completed: boolean,
  status: "active" | "superseded" = "active",
) {
  const planId = PlanId.make(name);
  const nodeId = NodeId.make(`${name}:node`);
  const steps = [
    { id: "step", text: name, status: completed ? ("completed" as const) : ("running" as const) },
  ];
  yield* apply({
    id: EventId.make(`${name}:plan`),
    type: "plan.updated",
    threadId: owner.threadId,
    occurredAt: now,
    payload: {
      id: planId,
      threadId: owner.threadId,
      runId: owner.id,
      nodeId,
      status,
      kind: "todo_list",
      steps,
    },
  });
  yield* apply({
    id: EventId.make(`${name}:item`),
    type: "turn-item.updated",
    threadId: owner.threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`${name}:item`),
      threadId: owner.threadId,
      runId: owner.id,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      status: "completed",
      startedAt: now,
      completedAt: now,
      parentItemId: null,
      ordinal: name === "z-first" ? 1 : 2,
      title: name,
      updatedAt: now,
      type: "todo_list",
      planId,
      steps,
    },
  });
});

it.layer(layer)("ThreadInsightsQuery", (it) => {
  it.effect(
    "counts spent own turns once, attributes native children, excludes forks, and keeps missing and remote usage explicit",
    () =>
      Effect.gen(function* () {
        const root = yield* thread("root");
        const child = yield* thread("child", root, "subagent");
        const native = yield* thread("native", child, "subagent");
        yield* thread("fork", root, "fork");
        yield* run(root, 1, "rolled_back");
        yield* agent(root, child);
        yield* agent(child, native, "provider_native");
        yield* agent(native, root);
        yield* agent(root, ThreadId.make("remote-child"), "app_owned", true);
        yield* agent(root, ThreadId.make("deleted-child"));
        yield* turn(root, "root-turn", root, usage(100));
        yield* turn(child, "native-turn", native, usage(50));

        yield* turn(child, "unreported-turn", child);
        const result = yield* (yield* ThreadInsightsQuery.ThreadInsightsQuery).read({
          threadId: root,
        });
        expect(result.rows.map((row) => row.threadId)).toEqual([root, child, native]);
        expect(result.rows.map((row) => row.usage.inputTokens)).toEqual([100, undefined, 50]);
        expect(result.rows.map((row) => row.usage.turns)).toEqual([1, 1, 1]);
        expect(result.rows[1]?.usage.status).toBe("unavailable");
        expect(result.rows[0]?.usage.hasOtherUsage).toBe(true);
        expect(result.remotes[0]?.threadId).toBe("remote-child");
        expect(result.unavailableThreadIds).toEqual(["deleted-child"]);
        expect(result.truncated).toBe(false);
        const direct = yield* (yield* ThreadInsightsQuery.ThreadInsightsQuery).read({
          threadId: native,
        });
        expect(direct.rows.find((row) => row.threadId === native)?.usage.inputTokens).toBe(50);
      }),
  );

  it.effect("selects todo lists by item order, ignores superseded lists and rolled-back runs", () =>
    Effect.gen(function* () {
      const root = yield* thread("plans");
      const store = yield* ProjectionStore.ProjectionStoreV2;
      expect(yield* store.getLatestTodoList(root)).toBeUndefined();
      const initial = yield* run(root, 1);
      yield* plan(initial, "z-first", false);
      yield* plan(initial, "a-second", true);
      yield* plan(initial, "superseded", false, "superseded");
      const rolledBack = yield* run(root, 2, "rolled_back");
      yield* plan(rolledBack, "rolled-back", false);
      const result = yield* (yield* ThreadInsightsQuery.ThreadInsightsQuery).read({
        threadId: root,
      });
      expect(result.rows[0]?.steps?.[0]?.text).toBe("a-second");
      expect(result.rows[0]?.steps?.[0]?.status).toBe("completed");
    }),
  );
  it.effect("bounds wide families and reports omitted children", () =>
    Effect.gen(function* () {
      const root = yield* thread("wide");
      for (let index = 0; index < 201; index++) {
        const child = yield* thread(`wide-child-${index}`, root, "subagent");
        yield* agent(root, child);
      }
      const result = yield* (yield* ThreadInsightsQuery.ThreadInsightsQuery).read({
        threadId: root,
      });
      expect(result.rows).toHaveLength(200);
      expect(result.truncated).toBe(true);
    }),
  );
});
