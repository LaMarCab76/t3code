import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "./atom-registry";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";
import {
  activeWorkspaceProfile,
  filterWorkspaceProfileProjects,
  filterWorkspaceProfileThreads,
} from "@t3tools/client-runtime/workspace-profiles";
import { mobilePreferencesAtom } from "./preferences";

import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);

/** Resolves when the project event reaches the live client store. */
export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject | null> {
  const atom = environmentProjects.projectAtom(ref);
  const current = appAtomRegistry.get(atom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, finish);
    finish(appAtomRegistry.get(atom));
  });
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  const projects = useAllProjects();
  const profile = useActiveWorkspaceProfile();
  return useMemo(() => filterWorkspaceProfileProjects(projects, profile), [projects, profile]);
}

export function useAllProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useActiveWorkspaceProfile() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? activeWorkspaceProfile(
        preferences.value.workspaceProfiles ?? [],
        preferences.value.activeWorkspaceProfileId,
      )
    : null;
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const profile = useActiveWorkspaceProfile();
  return useMemo(() => filterWorkspaceProfileThreads(threads, profile), [threads, profile]);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
}
