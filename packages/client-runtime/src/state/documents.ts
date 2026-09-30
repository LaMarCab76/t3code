import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createDocumentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    read: createEnvironmentRpcCommand(runtime, {
      label: "documents.read",
      tag: WS_METHODS.documentRead,
    }),
    saveCopy: createEnvironmentRpcCommand(runtime, {
      label: "documents.save-copy",
      tag: WS_METHODS.documentSaveCopy,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "documents.create",
      tag: WS_METHODS.documentCreate,
    }),
  };
}
