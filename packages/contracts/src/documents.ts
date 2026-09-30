import * as Schema from "effect/Schema";
import { ThreadId, PositiveInt, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DocumentFormat = Schema.Literals(["pdf", "docx", "xlsx", "csv", "tsv"]);
export type DocumentFormat = typeof DocumentFormat.Type;
export const DocumentSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workspace"), path: TrimmedNonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    id: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
  }),
]);
export type DocumentSource = typeof DocumentSource.Type;
export const DocumentFile = Schema.Struct({ threadId: ThreadId, source: DocumentSource });
export type DocumentFile = typeof DocumentFile.Type;
export const DocumentCellStyle = Schema.Struct({
  bold: Schema.optionalKey(Schema.Boolean),
  italic: Schema.optionalKey(Schema.Boolean),
  numberFormat: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
});
export const DocumentCellEdit = Schema.Struct({
  sheet: Schema.String,
  row: PositiveInt.check(Schema.isLessThanOrEqualTo(200000)),
  column: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  value: Schema.String.check(Schema.isMaxLength(8192)),
  style: Schema.optionalKey(DocumentCellStyle),
});
export const DocumentCell = Schema.Struct({
  ...DocumentCellEdit.fields,
  display: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type DocumentCell = typeof DocumentCell.Type;
export const DocumentEdits = Schema.Struct({
  html: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        start: NonNegativeInt,
        count: NonNegativeInt,
        contents: Schema.String.check(Schema.isMaxLength(200000)),
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  cells: Schema.optionalKey(Schema.Array(DocumentCellEdit).check(Schema.isMaxLength(10000))),
  notes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        page: PositiveInt,
        text: Schema.String.check(Schema.isMaxLength(2000)),
        x: Schema.Number,
        y: Schema.Number,
      }),
    ).check(Schema.isMaxLength(1000)),
  ),
  fields: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  ),
});
export type DocumentEdits = typeof DocumentEdits.Type;
export const DocumentReadInput = Schema.Struct({
  ...DocumentFile.fields,
  edits: Schema.optionalKey(DocumentEdits),
  start: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(200000))),
  count: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  sheet: Schema.optionalKey(Schema.String),
  column: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(1000))),
  columns: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
});
export type DocumentReadInput = typeof DocumentReadInput.Type;
const BaseDocumentPage = {
  revision: Schema.String,
  name: Schema.String,
  total: NonNegativeInt,
  start: NonNegativeInt,
  count: NonNegativeInt,
  limitations: Schema.Array(Schema.String),
};
export const DocumentPage = Schema.Union([
  Schema.Struct({ ...BaseDocumentPage, format: Schema.Literal("docx"), html: Schema.String }),
  Schema.Struct({
    ...BaseDocumentPage,
    format: Schema.Literals(["xlsx", "csv", "tsv"]),
    sheets: Schema.Array(Schema.String),
    sheet: Schema.String,
    totalColumns: NonNegativeInt,
    cells: Schema.Array(DocumentCell),
  }),
  Schema.Struct({
    ...BaseDocumentPage,
    format: Schema.Literal("pdf"),
    pages: Schema.Array(
      Schema.Struct({
        page: PositiveInt,
        text: Schema.String,
        width: Schema.Number,
        height: Schema.Number,
      }),
    ),
    fields: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.Literals(["text", "checkbox", "choice", "unsupported"]),
        value: Schema.Union([Schema.String, Schema.Boolean]),
        options: Schema.Array(Schema.String),
        readOnly: Schema.Boolean,
      }),
    ),
  }),
]);
export type DocumentPage = typeof DocumentPage.Type;
export const DocumentSavedCopy = Schema.Struct({
  source: DocumentSource,
  name: Schema.String,
  relativePath: Schema.String,
  format: DocumentFormat,
});
export type DocumentSavedCopy = typeof DocumentSavedCopy.Type;
export const DocumentSaveCopyInput = Schema.Struct({
  ...DocumentFile.fields,
  revision: Schema.String,
  edits: DocumentEdits,
});
export type DocumentSaveCopyInput = typeof DocumentSaveCopyInput.Type;
export const DocumentCreateInput = Schema.Struct({
  threadId: ThreadId,
  name: TrimmedNonEmptyString,
  format: DocumentFormat,
  contents: DocumentEdits,
});
export type DocumentCreateInput = typeof DocumentCreateInput.Type;
export class DocumentError extends Schema.TaggedError<DocumentError>()("DocumentError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
