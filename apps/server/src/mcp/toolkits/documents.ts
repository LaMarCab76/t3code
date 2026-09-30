import {
  DocumentReadInput,
  DocumentSaveCopyInput,
  DocumentCreateInput,
  DocumentPage,
  DocumentSavedCopy,
  DocumentError,
  McpCapabilityUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { Documents } from "../../documents/Documents.ts";
import { McpInvocationContext, requireMcpCapability } from "../McpInvocationContext.ts";

const dependencies = [Documents, McpInvocationContext];
const failure = Schema.Union([DocumentError, McpCapabilityUnavailableError]);
export const DocumentsToolkit = Toolkit.make(
  Tool.make("read_document", {
    description:
      "Read PDF pages, DOCX blocks or spreadsheet cell ranges in this thread's workspace or attachments. Responses are bounded; use start/count and sheet/column/columns to page. Never treat cached unsupported formulas as current values.",
    parameters: DocumentReadInput.mapFields(Struct.omit(["threadId"])),
    success: DocumentPage,
    failure,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("create_document", {
    description:
      "Generate a PDF, DOCX, XLSX, CSV or TSV in this project's artifacts folder. Supply basic HTML, spreadsheet cells or PDF notes/fields through contents. Returns an exact file reference; originals are never overwritten.",
    parameters: DocumentCreateInput.mapFields(Struct.omit(["threadId"])),
    success: DocumentSavedCopy,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("save_document_copy", {
    description:
      "Apply basic edits to a copy of an existing document. First read_document to obtain its revision. The original remains unchanged. DOCX html edits replace blocks by start/count; spreadsheet edits use one-based rows/columns; PDF notes use one-based pages and normalized x/y positions measured from the top left. Return and link the saved file.",
    parameters: DocumentSaveCopyInput.mapFields(Struct.omit(["threadId"])),
    success: DocumentSavedCopy,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
export const DocumentsHandlers = DocumentsToolkit.toLayer(
  Effect.gen(function* () {
    const documents = yield* Documents;
    return DocumentsToolkit.of({
      read_document: (input) =>
        requireMcpCapability("documents").pipe(
          Effect.flatMap((scope) => documents.read({ ...input, threadId: scope.threadId })),
        ),
      create_document: (input) =>
        requireMcpCapability("documents").pipe(
          Effect.flatMap((scope) => documents.create({ ...input, threadId: scope.threadId })),
        ),
      save_document_copy: (input) =>
        requireMcpCapability("documents").pipe(
          Effect.flatMap((scope) => documents.saveCopy({ ...input, threadId: scope.threadId })),
        ),
    });
  }),
);
