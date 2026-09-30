import {
  DocumentError,
  type DocumentReadInput,
  type DocumentSaveCopyInput,
  type DocumentCreateInput,
  type DocumentPage,
  type DocumentSavedCopy,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import {
  createWorkspaceDocument,
  readWorkspaceDocument,
  saveWorkspaceDocumentCopy,
} from "./storage.ts";

export class Documents extends Context.Service<
  Documents,
  {
    readonly read: (input: DocumentReadInput) => Effect.Effect<DocumentPage, DocumentError>;
    readonly saveCopy: (
      input: DocumentSaveCopyInput,
    ) => Effect.Effect<DocumentSavedCopy, DocumentError>;
    readonly create: (
      input: DocumentCreateInput,
    ) => Effect.Effect<DocumentSavedCopy, DocumentError>;
  }
>()("t3/documents/Documents") {}

export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;
  const workspace = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = Option.getOrNull(yield* query.getThreadShellById(threadId));
      if (!thread) return yield* new DocumentError({ detail: "Thread not found." });
      const project = Option.getOrNull(yield* query.getProjectShellById(thread.projectId));
      if (!project) return yield* new DocumentError({ detail: "Project not found." });
      return {
        root: thread.worktreePath ?? project.workspaceRoot,
        attachmentPath: (id: string) =>
          parseThreadSegmentFromAttachmentId(id) === toSafeThreadAttachmentSegment(thread.id)
            ? resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId: id })
            : null,
      };
    }).pipe(Effect.mapError((cause) => new DocumentError({ detail: cause.message })));
  const failure = (cause: unknown) =>
    new DocumentError({
      detail: cause instanceof Error ? cause.message : "Document operation failed.",
    });
  return Documents.of({
    read: (input) =>
      workspace(input.threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({ try: () => readWorkspaceDocument(context, input), catch: failure }),
        ),
      ),
    saveCopy: (input) =>
      workspace(input.threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => saveWorkspaceDocumentCopy(context, input),
            catch: failure,
          }),
        ),
      ),
    create: (input) =>
      workspace(input.threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({ try: () => createWorkspaceDocument(context, input), catch: failure }),
        ),
      ),
  });
});
export const layer = Layer.effect(Documents, make);
