// @effect-diagnostics nodeBuiltinImport:off -- Async binary codec boundary uses exclusive file writes and realpath checks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { documentFormat, documentRevision, editDocument, readDocument } from "./codec.ts";
import type {
  DocumentCreateInput,
  DocumentReadInput,
  DocumentSaveCopyInput,
  DocumentSavedCopy,
  DocumentSource,
} from "@t3tools/contracts";

export interface DocumentWorkspace {
  readonly root: string;
  readonly attachmentPath: (id: string) => string | null;
}
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const within = (root: string, file: string) => {
  const relative = NodePath.relative(root, file);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

async function resolveDocument(context: DocumentWorkspace, source: DocumentSource) {
  const root = await NodeFSP.realpath(context.root);
  if (source.kind === "attachment") {
    const file = context.attachmentPath(source.id);
    if (!file) throw new Error("Attachment not found.");
    return {
      root,
      file,
      name: NodePath.basename(source.name),
      copyDirectory: NodePath.join(root, "artifacts"),
    };
  }
  const file = await NodeFSP.realpath(NodePath.resolve(root, source.path));
  if (!within(root, file)) throw new Error("Document is outside this thread's workspace.");
  return { root, file, name: NodePath.basename(file), copyDirectory: NodePath.dirname(file) };
}

async function readBytes(file: string) {
  const handle = await NodeFSP.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES)
      throw new Error("Documents must be regular files smaller than 32 MiB.");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds the 32 MiB limit.");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function saveUnique(
  root: string,
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<DocumentSavedCopy> {
  if (name !== NodePath.basename(name) || name.includes("\\") || name.includes("\0"))
    throw new Error("Use a file name without directories.");
  const format = documentFormat(name);
  await NodeFSP.mkdir(directory, { recursive: true });
  const canonicalDirectory = await NodeFSP.realpath(directory);
  if (!within(root, canonicalDirectory))
    throw new Error("Copy directory is outside the workspace.");
  const base = name.slice(0, -(format.length + 1));
  const fileName = `${base}-copy-${NodeCrypto.randomUUID().slice(0, 8)}.${format}`;
  const file = NodePath.join(canonicalDirectory, fileName);
  await NodeFSP.writeFile(file, bytes, { flag: "wx" });
  return {
    source: { kind: "workspace", path: file },
    name: fileName,
    relativePath: NodePath.relative(root, file).split(NodePath.sep).join("/"),
    format,
  };
}

export async function readWorkspaceDocument(context: DocumentWorkspace, input: DocumentReadInput) {
  const resolved = await resolveDocument(context, input.source);
  return readDocument(await readBytes(resolved.file), resolved.name, input);
}

export async function saveWorkspaceDocumentCopy(
  context: DocumentWorkspace,
  input: DocumentSaveCopyInput,
) {
  const resolved = await resolveDocument(context, input.source),
    bytes = await readBytes(resolved.file);
  if (documentRevision(bytes) !== input.revision)
    throw new Error("The original document changed. Reload it before saving a copy.");
  const edited = await editDocument(documentFormat(resolved.name), input.edits, bytes);
  return saveUnique(resolved.root, resolved.copyDirectory, resolved.name, edited);
}

export async function createWorkspaceDocument(
  context: DocumentWorkspace,
  input: DocumentCreateInput,
) {
  const root = await NodeFSP.realpath(context.root);
  if (documentFormat(input.name) !== input.format)
    throw new Error("The file extension must match the requested format.");
  return saveUnique(
    root,
    NodePath.join(root, "artifacts"),
    input.name,
    await editDocument(input.format, input.contents),
  );
}
