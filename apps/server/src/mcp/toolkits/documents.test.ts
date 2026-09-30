import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DocumentReadInput,
  type DocumentSaveCopyInput,
  type DocumentCreateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { Documents } from "../../documents/Documents.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { DocumentsHandlers, DocumentsToolkit } from "./documents.ts";

const threadId = ThreadId.make("document-tool-owner");
const invocation = {
  environmentId: EnvironmentId.make("document-tool-environment"),
  threadId,
  providerSessionId: "document-tool-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["documents"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "document-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "document-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "scopes all document tools to their credential's thread and enforces availability",
  () => {
    const reads: DocumentReadInput[] = [],
      copies: DocumentSaveCopyInput[] = [],
      creates: DocumentCreateInput[] = [];
    const copy = {
      source: { kind: "workspace" as const, path: "artifacts/report.csv" },
      name: "report.csv",
      relativePath: "artifacts/report.csv",
      format: "csv" as const,
    };
    const layer = McpServer.toolkit(DocumentsToolkit).pipe(
      Layer.provide(DocumentsHandlers),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(Documents)({
          read: (input) => {
            reads.push(input);
            return Effect.succeed({
              format: "csv",
              revision: "r1",
              name: "source.csv",
              total: 1,
              start: 0,
              count: 1,
              limitations: [],
              sheets: ["Sheet1"],
              sheet: "Sheet1",
              totalColumns: 1,
              cells: [],
            });
          },
          saveCopy: (input) => {
            copies.push(input);
            return Effect.succeed(copy);
          },
          create: (input) => {
            creates.push(input);
            return Effect.succeed(copy);
          },
        }),
      ),
    );
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const source = { kind: "workspace", path: "source.csv" };
      const call = (name: string, args: Record<string, unknown>, allowed = true) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext, {
            ...invocation,
            capabilities: allowed ? invocation.capabilities : new Set<"documents">(),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const denied = yield* call("read_document", { source }, false);
      expect(denied.isError).toBe(true);
      expect(reads).toHaveLength(0);
      expect(
        (yield* call("read_document", {
          source,
          start: 20,
          count: 2,
          columns: 3,
          threadId: "other-thread",
        })).isError,
      ).toBe(false);
      expect(
        (yield* call("save_document_copy", { source, revision: "r1", edits: { cells: [] } }))
          .isError,
      ).toBe(false);
      expect(
        (yield* call("create_document", {
          name: "report.csv",
          format: "csv",
          contents: { cells: [] },
        })).isError,
      ).toBe(false);
      expect(reads[0]).toMatchObject({ threadId, start: 20, count: 2, columns: 3 });
      expect(copies[0]?.threadId).toBe(threadId);
      expect(creates[0]?.threadId).toBe(threadId);
    }).pipe(Effect.provide(layer));
  },
);
