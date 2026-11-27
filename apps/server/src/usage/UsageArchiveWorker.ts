import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { UsageService } from "./UsageService.ts";
import { replicateLinkedUsage } from "./UsageArchivePeer.ts";
import { makeUsageArchive } from "./UsageArchive.ts";

export const usageArchiveWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const archive = makeUsageArchive(
      yield* SqlClient.SqlClient,
      yield* UsageService,
      yield* ServerEnvironment,
    );
    const orchestrator = yield* OrchestratorV2;
    const pending = yield* Queue.sliding<void>(1);
    yield* Effect.forever(
      replicateLinkedUsage(archive).pipe(Effect.ignore, Effect.andThen(Effect.sleep("15 seconds"))),
    ).pipe(Effect.forkScoped);
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter((e) => e.type === "provider-turn.updated" && e.payload.completedAt != null),
      Stream.runForEach(() => Queue.offer(pending, undefined)),
      Effect.forkScoped,
    );
    yield* Effect.forever(
      Effect.sleep("15 minutes").pipe(Effect.andThen(Queue.offer(pending, undefined))),
    ).pipe(Effect.forkScoped);
    yield* Queue.offer(pending, undefined);
    yield* Effect.forever(
      Queue.take(pending).pipe(
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.andThen(archive.capture()),
        Effect.catchCause((cause) => Effect.logWarning("Usage archive capture failed", { cause })),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
