import { useRef, useState } from "react";
import { WebView } from "react-native-webview";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  DocumentReadInput,
  DocumentEdits,
  type DocumentSource,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { documentEnvironment } from "../../state/documents";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FilePreviewNotice, FilePreviewLoading } from "./FilePreviewFeedback";

const Request = Schema.Struct({
  id: Schema.String,
  operation: Schema.Literals(["read", "saveCopy", "binaryUrl"]),
  input: Schema.Unknown,
});
const Range = DocumentReadInput.mapFields(Struct.omit(["threadId", "source"]));
const Save = Schema.Struct({ revision: Schema.String, edits: DocumentEdits });

const decodeRequest = Schema.decodeOption(Schema.fromJsonString(Request));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeRange = Schema.decodeUnknownSync(Range);
const decodeSave = Schema.decodeUnknownSync(Save);

/** Native owns authentication and the file reference; the WebView only requests bounded edits. */
export function NativeDocumentPreview(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  source: DocumentSource;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const connection = usePreparedConnection(props.environmentId);
  const read = useAtomCommand(documentEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(documentEnvironment.saveCopy, { reportFailure: false });
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const webview = useRef<WebView>(null);
  const source = useRef(props.source);
  const issuedUrls = useRef(new Set<string>());
  if (loadError)
    return <FilePreviewNotice title="Document editor unavailable">{loadError}</FilePreviewNotice>;
  if (Option.isNone(connection))
    return <FilePreviewLoading message="Connecting document editor…" />;
  const baseUrl = connection.value.httpBaseUrl;
  const editorUrl = new URL("document-editor.html", `${baseUrl.replace(/\/$/, "")}/`).href;
  const binaryUrl = async (file = source.current) => {
    const resource =
      file.kind === "workspace"
        ? { _tag: "workspace-file" as const, threadId: props.threadId, path: file.path }
        : {
            _tag: "attachment" as const,
            attachmentId: file.id,
            fileName: file.name,
            disposition: "inline" as const,
          };
    const result = await createUrl({ environmentId: props.environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const url = new URL(result.value.relativeUrl, baseUrl).href;
    issuedUrls.current.add(url);
    return url;
  };
  return (
    <WebView
      ref={webview}
      source={{ uri: editorUrl }}
      style={{ flex: 1 }}
      originWhitelist={[new URL(editorUrl).origin]}
      setSupportMultipleWindows={false}
      onError={() =>
        setLoadError(
          "Could not load the document editor from this environment. Reconnect and try again.",
        )
      }
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === editorUrl || request.url === "about:blank") return true;
        if (issuedUrls.current.has(request.url))
          void tryOpenExternalUrl(request.url, "file-preview");
        return false;
      }}
      onMessage={(event) => {
        const decoded = decodeRequest(event.nativeEvent.data);
        if (Option.isNone(decoded)) return;
        const request = decoded.value;
        const reply = (ok: boolean, value?: unknown, error?: string, saved = false) => {
          const data = encodeJson({
            id: request.id,
            ok,
            value,
            error,
          });
          const literal = encodeString(data);
          webview.current?.injectJavaScript(
            `window.dispatchEvent(new MessageEvent("message", { data: ${literal} })); ${saved ? 'window.dispatchEvent(new Event("document-source-changed"));' : ""} true;`,
          );
        };
        void (async () => {
          try {
            if (request.operation === "binaryUrl") {
              reply(true, await binaryUrl());
              return;
            }
            if (request.operation === "read") {
              const range = decodeRange(request.input);
              const result = await read({
                environmentId: props.environmentId,
                input: { ...range, threadId: props.threadId, source: source.current },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              reply(true, result.value);
              return;
            }
            const input = decodeSave(request.input);
            const result = await save({
              environmentId: props.environmentId,
              input: { ...input, threadId: props.threadId, source: source.current },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            const url = await binaryUrl(result.value.source);
            source.current = result.value.source;
            reply(true, { copy: result.value, url }, undefined, true);
          } catch (cause) {
            reply(
              false,
              undefined,
              cause instanceof Error ? cause.message : "Document operation failed.",
            );
          }
        })();
      }}
    />
  );
}
