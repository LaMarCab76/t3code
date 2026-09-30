import { createRoot } from "react-dom/client";
import * as Schema from "effect/Schema";
import { DocumentPage, DocumentSavedCopy } from "@t3tools/contracts";
import DocumentEditor, { type DocumentEditorPort } from "./DocumentEditor";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}
const Response = Schema.Struct({
  id: Schema.String,
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
const decodeResponse = Schema.decodeOption(Schema.fromJsonString(Response));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextId = 0;
window.addEventListener("message", (event) => {
  const result = decodeResponse(typeof event.data === "string" ? event.data : "");
  if (result._tag === "None") return;
  const response = result.value,
    request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (response.ok) request.resolve(response.value);
  else request.reject(new Error(response.error ?? "Document operation failed."));
});
const request = (operation: "read" | "saveCopy" | "binaryUrl", input: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    if (!window.ReactNativeWebView) {
      reject(new Error("Open this editor from T3 Code's file panel."));
      return;
    }
    const id = String(++nextId);
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The native document operation timed out. Try again."));
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- React Native's bridge accepts only a message, not the browser postMessage API's targetOrigin.
    window.ReactNativeWebView.postMessage(encodeJson({ id, operation, input }));
  });
const decodePage = Schema.decodeUnknownSync(DocumentPage);
const decodeSaved = Schema.decodeUnknownSync(
  Schema.Struct({ copy: DocumentSavedCopy, url: Schema.String }),
);
const decodeUrl = Schema.decodeUnknownSync(Schema.String);
const port: DocumentEditorPort = {
  read: async (range) => decodePage(await request("read", range)),
  saveCopy: async (revision, edits) => decodeSaved(await request("saveCopy", { revision, edits })),
  binaryUrl: async () => decodeUrl(await request("binaryUrl", {})),
};
const root = createRoot(document.getElementById("document-root")!);
let sourceVersion = 0;
window.addEventListener("document-source-changed", () => {
  root.render(<DocumentEditor key={++sourceVersion} port={port} />);
});
root.render(<DocumentEditor port={port} />);
