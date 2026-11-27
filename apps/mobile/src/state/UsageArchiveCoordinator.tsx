import { useEffect } from "react";
import {
  createUsagePayments,
  startUsageReplication,
} from "@t3tools/client-runtime/state/usage-archive";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";
import { environmentShell } from "./shell";
import { serverEnvironment } from "./server";

export const usagePayments = createUsagePayments(
  appAtomRegistry,
  environmentPresentations.presentationsAtom,
  environmentSession,
  serverEnvironment,
);

export function UsageArchiveCoordinator() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the root owns the subscriptions to paired machines.
  useEffect(
    () =>
      startUsageReplication(
        appAtomRegistry,
        environmentPresentations.presentationsAtom,
        environmentShell,
        environmentSession,
        serverEnvironment,
      ),
    [],
  );
  return null;
}
