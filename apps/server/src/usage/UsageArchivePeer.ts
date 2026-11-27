import { USAGE_ARCHIVE_PEER_PATH, UsageArchivePage, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { LINK_EXPIRES_AT_HEADER } from "../mcp/McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { UsageService } from "./UsageService.ts";
import { makeUsageArchive } from "./UsageArchive.ts";

const empty = (status: number) =>
  HttpServerResponse.empty({ status, headers: { "cache-control": "no-store" } });

export const archivePeerRoute = HttpRouter.add(
  "GET",
  USAGE_ARCHIVE_PEER_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.origin !== undefined) return empty(403);
    const settings = yield* ServerSettingsService;
    const limit = settings.managedPolicy?.limits?.maxRuntimeMode;
    if (
      (limit && limit !== "full-access") ||
      !(yield* settings.getSettings).linkedEnvironmentsEnabled
    )
      return empty(403);
    const auth = yield* EnvironmentAuth;
    const caller = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(caller)) return empty(401);
    if (!caller.value.peerLink || caller.value.access !== "full-access") return empty(403);
    const cursor = Number(new URLSearchParams(request.url.split("?")[1]).get("cursor") ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return empty(400);
    const archive = makeUsageArchive(
      yield* SqlClient.SqlClient,
      yield* UsageService,
      yield* ServerEnvironment,
    );
    const page = yield* archive.changes({ cursor, capture: false });
    return HttpServerResponse.jsonUnsafe(page, {
      headers: {
        "cache-control": "no-store",
        ...(caller.value.linkExpiresAt
          ? { [LINK_EXPIRES_AT_HEADER]: DateTime.formatIso(caller.value.linkExpiresAt) }
          : {}),
      },
    });
  }).pipe(Effect.orElseSucceed(() => empty(500))),
);

export const replicateLinkedUsage = Effect.fn("UsageArchive.replicateLinked")(function* (
  archive: ReturnType<typeof makeUsageArchive>,
) {
  const links = yield* PeerLinks;
  if (!(yield* links.enabled)) return;
  const http = yield* HttpClient.HttpClient;
  const stored = yield* archive.status;
  const pull = Effect.fn("UsageArchive.pullPeer")(function* (id: EnvironmentId) {
    const saved = yield* links.get(id);
    if (Option.isNone(saved) || saved.value.access !== "full-access") return;
    const remote = yield* links.resolve(id);
    if (!remote.capabilities.usageArchive) return;
    let cursor = stored.find((row) => row.environmentId === id)?.cursor ?? 0;
    while (true) {
      const request = HttpClientRequest.get(remote.url + USAGE_ARCHIVE_PEER_PATH).pipe(
        HttpClientRequest.setUrlParam("cursor", String(cursor)),
        HttpClientRequest.setHeader("authorization", "Bearer " + remote.token),
      );
      const response = yield* http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("10 seconds"),
        );
      if (response.status !== 200) return;
      const page = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(UsageArchivePage)),
        Effect.timeout("15 seconds"),
      );
      if (
        page.environmentId !== id ||
        page.from !== cursor ||
        !(yield* links.enabled) ||
        Option.isNone(yield* links.get(id))
      )
        return;
      const expiry = response.headers[LINK_EXPIRES_AT_HEADER];
      if (expiry) {
        const renewed = DateTime.make(expiry);
        if (Option.isSome(renewed)) yield* links.recordExpiry(id, renewed.value);
      }
      if (
        page.days.length ||
        !stored.some((r) => r.environmentId === id && r.readAt === page.readAt)
      ) {
        const next = yield* archive.receive(page);
        if (next <= cursor || !page.more) return;
        cursor = next;
      } else return;
    }
  });
  yield* Effect.forEach(
    yield* links.names,
    (peer) => pull(peer.environmentId).pipe(Effect.ignore),
    { concurrency: 2, discard: true },
  );
});
