import { expect, it } from "@effect/vitest";
import { AuthSessionId, USAGE_ARCHIVE_PEER_PATH } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import migration from "../persistence/Migrations/120_UsageArchive.ts";
import { UsageService } from "./UsageService.ts";
import { archivePeerRoute } from "./UsageArchivePeer.ts";

it("serves only usage to a full-access peer, including when no GUI is open", async () => {
  const descriptor = descriptorOf("origin", "Origin");
  const db = Layer.effectDiscard(migration).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const app = archivePeerRoute.pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(
        db,
        NodeCrypto.layer,
        ServerSettingsService.layerTest({ linkedEnvironmentsEnabled: true }),
        Layer.mock(ServerEnvironment)({
          getDescriptor: Effect.succeed(descriptor),
          getEnvironmentId: Effect.succeed(descriptor.environmentId),
        }),
        Layer.mock(UsageService)({}),
        Layer.mock(EnvironmentAuth)({
          authenticateMcpClient: (req) =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test-client"),
              label: "peer",
              peerLink: req.headers["x-test-client"] !== "ordinary",
              access:
                req.headers["x-test-client"] === "limited" ? "approval-required" : "full-access",
            }),
        }),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  try {
    const request = (headers: Record<string, string>) =>
      handler(new Request("http://localhost" + USAGE_ARCHIVE_PEER_PATH, { headers }));
    expect((await request({ "x-test-client": "ordinary" })).status).toBe(403);
    expect((await request({ "x-test-client": "limited" })).status).toBe(403);
    expect((await request({ origin: "http://localhost" })).status).toBe(403);
    const response = await request({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      environmentId: "origin",
      days: [],
      cursor: 0,
      more: false,
    });
  } finally {
    await dispose();
  }
});
