import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useMemo } from "react";
import type { DocumentSource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { documentEnvironment } from "../state/documents";
import { assetEnvironment } from "../state/assets";
import DocumentEditor, { type DocumentEditorPort } from "./DocumentEditor";

export default function WorkspaceDocumentPreview(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  source: DocumentSource;
  onSaved: (path: string) => void;
}) {
  const { environmentId, threadId, source, onSaved } = props;
  const read = useAtomCommand(documentEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(documentEnvironment.saveCopy, { reportFailure: false });
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const port = useMemo<DocumentEditorPort>(() => {
    const binaryUrl = async (file = source) => {
      const resource =
        file.kind === "workspace"
          ? { _tag: "workspace-file" as const, threadId: threadId, path: file.path }
          : {
              _tag: "attachment" as const,
              attachmentId: file.id,
              fileName: file.name,
              disposition: "inline" as const,
            };
      const result = await createUrl({ environmentId: environmentId, input: { resource } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!baseUrl) throw new Error("The document environment is disconnected.");
      return new URL(result.value.relativeUrl, baseUrl).href;
    };
    return {
      binaryUrl,
      read: async (range) => {
        const result = await read({
          environmentId: environmentId,
          input: { ...range, threadId: threadId, source: source },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
      saveCopy: async (revision, edits) => {
        const result = await save({
          environmentId: environmentId,
          input: { threadId: threadId, source: source, revision, edits },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const url = await binaryUrl(result.value.source);
        onSaved(result.value.relativePath);
        return { copy: result.value, url };
      },
    };
  }, [environmentId, threadId, source, onSaved, read, save, createUrl, baseUrl]);
  return <DocumentEditor port={port} />;
}
