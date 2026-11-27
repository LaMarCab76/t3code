import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import paymentMigration from "../persistence/Migrations/121_UsageSubscriptionPayments.ts";
import migration from "../persistence/Migrations/120_UsageArchive.ts";
import { makeUsageArchive } from "./UsageArchive.ts";

it.effect("reopens the destination archive without its source and counts a retried page once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      dir = yield* fs.makeTempDirectoryScoped();
    const origin = EnvironmentId.make("laptop"),
      target = EnvironmentId.make("desktop"),
      day = UsageDay.make("2026-11-27");
    const window = { sinceDay: day, untilDay: day, timeZone: "UTC" };
    const snapshot: UsageSummary = {
      ...window,
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-11-27T15:00:00.000Z",
      pricing: { status: "cached", source: "fixture", fetchedAt: null, knownModels: 0 },
      scanDurationMs: 0,
      sources: [
        {
          fingerprint: {
            provider: "codex",
            hostId: "laptop",
            resolvedHomePath: "source",
            volumeId: "disk",
          },
          status: "ok",
          distinctSessions: 1,
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          message: null,
        },
      ],
      buckets: ["11:00", "11:01"].map((time) => ({
        day,
        hourStart: "2026-11-27T" + time + ":00.000Z",
        provider: "codex",
        model: "test-model",
        sourcePath: "source",
        totals: {
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 2,
          reasoningTokens: 1,
        },
        sessions: 1,
        archiveSessions: ["private-session"],
        records: 1,
        costUsd: 1,
        cacheSavingsUsd: 0,
        costSource: "modelPriced",
        unpricedRecords: 0,
      })),
    };
    const open = (id: EnvironmentId) =>
      Effect.gen(function* () {
        return makeUsageArchive(
          yield* SqlClient.SqlClient,
          { archiveSummary: () => Effect.succeed(snapshot) },
          {
            getEnvironmentId: Effect.succeed(id),
            getDescriptor: Effect.succeed({ environmentId: id, label: id }),
          },
        );
      });
    const page = yield* Effect.gen(function* () {
      yield* migration;
      yield* paymentMigration;
      const src = yield* open(origin);
      yield* src.updatePayments({ "2026-11/codex": 3050, "2026-11/claude": 0 });
      yield* src.updatePayments({ "2026-11/claude": null });
      assert.equal((yield* src.payments)["2026-11/codex"]?.cents, 3050);
      assert.notProperty(yield* src.payments, "2026-11/claude");
      return yield* src.changes({ cursor: 0, capture: true });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dir + "/source.sqlite" })));
    assert.equal(page.days.length, 1);
    assert.notInclude(JSON.stringify(page), "private-session");
    const dest = () => NodeSqliteClient.layer({ filename: dir + "/dest.sqlite" });
    yield* Effect.gen(function* () {
      yield* migration;
      yield* paymentMigration;
      const api = yield* open(target);
      yield* api.receive(page);
      yield* api.receive(page);
    }).pipe(Effect.provide(dest()));
    const result = yield* Effect.gen(function* () {
      const api = yield* open(target);
      assert.deepStrictEqual(yield* api.payments, {});
      return yield* api.read(window);
    }).pipe(Effect.provide(dest()));
    const relayed = yield* Effect.gen(function* () {
      const api = yield* open(target);
      return yield* api.changes({ cursor: 0, capture: false, origin });
    }).pipe(Effect.provide(dest()));
    assert.equal(relayed.environmentId, origin);
    assert.equal(relayed.cursor, page.cursor);
    yield* Effect.gen(function* () {
      yield* migration;
      yield* paymentMigration;
      const third = yield* open(EnvironmentId.make("third"));
      yield* third.receive(relayed);
      yield* third.receive(page);
      assert.deepStrictEqual(yield* third.payments, {});
      assert.equal((yield* third.read(window))[0]?.summary.buckets[0]?.costUsd, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dir + "/third.sqlite" })));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.summary.sources[0]?.distinctSessions, 1);
    assert.equal(result[0]?.summary.buckets[0]?.costUsd, 2);
    assert.equal(result[0]?.summary.buckets[0]?.totals.uncachedInputTokens, 20);
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
