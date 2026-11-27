import {
  AuthSettingsWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type EnvironmentId,
  type UsageArchiveCopy,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import type { createEnvironmentShellAtoms } from "./shell.ts";
import type { createEnvironmentSessionAtoms } from "./session.ts";
import { archiveRevision, type createServerEnvironmentAtoms } from "./server.ts";
import { runAtomCommand } from "./runtime.ts";

export function startUsageReplication(
  registry: AtomRegistry.AtomRegistry,
  presentations: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>,
  shell: Pick<ReturnType<typeof createEnvironmentShellAtoms>, "stateValueAtom">,
  sessions: Pick<ReturnType<typeof createEnvironmentSessionAtoms>, "sessionStateAtom">,
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "archiveStatus" | "exportArchive" | "importArchive"
  >,
) {
  let stopped = false,
    running = false;
  const pending = new Set<EnvironmentId>();
  const changed = new Set<EnvironmentId>();
  const watchers = new Map<EnvironmentId, () => void>();
  let timer: Fiber.Fiber<void> | undefined;
  const authorized = (id: EnvironmentId) => {
    const p = registry.get(presentations).get(id);
    if (
      p?.connection.phase !== "connected" ||
      p.serverConfig?.environment.capabilities.usageArchive !== true
    )
      return false;
    const state = registry.get(sessions.sessionStateAtom(id));
    const session = AsyncResult.getOrElse(state, () => null);
    return (
      state._tag !== "Failure" &&
      session !== null &&
      sessionGrantsScope(session, AuthDiagnosticsReadScope) &&
      sessionGrantsScope(session, AuthEnvironmentMaintainScope)
    );
  };
  const options = { reportFailure: false };
  const synchronize = async () => {
    if (stopped || running) return;
    running = true;
    const origins = [...pending];
    pending.clear();
    try {
      for (const origin of origins) {
        const targets = [...watchers.keys()].filter((id) => id !== origin && authorized(id));
        if (!authorized(origin) || !targets.length) continue;
        const donor = await runAtomCommand(
          registry,
          server.archiveStatus,
          { environmentId: origin, input: {} },
          options,
        );
        const replicas =
          donor._tag === "Success"
            ? donor.value.filter((row) => row.cursor > 0 && !watchers.has(row.environmentId))
            : [];
        let capture = changed.delete(origin);
        for (const target of targets) {
          const status = await runAtomCommand(
            registry,
            server.archiveStatus,
            { environmentId: target, input: {} },
            options,
          );
          if (status._tag !== "Success") {
            pending.add(origin);
            continue;
          }
          for (const source of [
            origin,
            ...replicas
              .filter(
                (row) =>
                  row.environmentId !== target &&
                  row.cursor >
                    (status.value.find((s) => s.environmentId === row.environmentId)?.cursor ?? 0),
              )
              .map((row) => row.environmentId),
          ]) {
            let cursor = status.value.find((row) => row.environmentId === source)?.cursor ?? 0;
            while (authorized(origin) && authorized(target)) {
              if (stopped) break;
              const result = await runAtomCommand(
                registry,
                server.exportArchive,
                {
                  environmentId: origin,
                  input: { cursor, capture: capture && source === origin, origin: source },
                },
                options,
              );
              if (result._tag !== "Success" || result.value.environmentId !== source) {
                pending.add(origin);
                break;
              }
              if (capture) registry.update(archiveRevision(origin), (v) => v + 1);
              capture = false;
              if (stopped || !authorized(target) || !authorized(origin)) break;
              const imported = await runAtomCommand(
                registry,
                server.importArchive,
                { environmentId: target, input: result.value },
                options,
              );
              if (imported._tag !== "Success") {
                pending.add(origin);
                break;
              }
              if (!result.value.more || imported.value <= cursor) {
                if (
                  imported.value > cursor ||
                  status.value.every((row) => row.environmentId !== source)
                )
                  registry.update(archiveRevision(target), (v) => v + 1);
                break;
              }
              cursor = imported.value;
            }
          }
        }
      }
    } finally {
      running = false;
      if (pending.size && !stopped) schedule(5_000);
    }
  };
  const schedule = (ms = 1500) => {
    if (!timer && !stopped)
      timer = Effect.runFork(
        Effect.sleep(ms).pipe(
          Effect.andThen(() => {
            timer = undefined;
            return Effect.promise(synchronize);
          }),
        ),
      );
  };
  const wake = (id: EnvironmentId) => {
    changed.add(id);
    pending.add(id);
    schedule();
  };
  const reconcile = () => {
    const collection = registry.get(presentations);
    for (const [id, dispose] of watchers) {
      if (collection.get(id)?.connection.phase !== "connected") {
        dispose();
        watchers.delete(id);
      }
    }
    for (const [id, p] of collection) {
      if (
        watchers.has(id) ||
        p.connection.phase !== "connected" ||
        !p.serverConfig?.environment.capabilities.usageArchive
      )
        continue;
      let latest = -1;
      const unsubShell = registry.subscribe(
        shell.stateValueAtom(id),
        (value) => {
          if (value.status !== "live" || Option.isNone(value.snapshot)) return;
          const next = value.snapshot.value.threads.reduce(
            (t, thread) =>
              thread.latestRunCompletedAt
                ? Math.max(t, DateTime.toEpochMillis(thread.latestRunCompletedAt))
                : t,
            0,
          );
          if (next > latest) {
            latest = next;
            wake(id);
          }
        },
        { immediate: true },
      );
      const unsubSession = registry.subscribe(sessions.sessionStateAtom(id), () => {
        for (const key of watchers.keys()) wake(key);
      });
      watchers.set(id, () => {
        unsubShell();
        unsubSession();
      });
      for (const key of watchers.keys()) wake(key);
    }
  };
  const stop = registry.subscribe(presentations, reconcile, { immediate: true });
  const retry = Effect.runFork(
    Effect.forever(
      Effect.sleep("2 minutes").pipe(
        Effect.map(() => {
          if (watchers.size > 1) {
            for (const id of watchers.keys()) pending.add(id);
            schedule();
          }
        }),
      ),
    ),
  );
  return () => {
    stopped = true;
    Effect.runFork(Fiber.interrupt(retry));
    if (timer) Effect.runFork(Fiber.interrupt(timer));
    stop();
    for (const dispose of watchers.values()) dispose();
  };
}

export function createUsagePayments(
  registry: AtomRegistry.AtomRegistry,
  presentations: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>,
  sessions: Pick<ReturnType<typeof createEnvironmentSessionAtoms>, "sessionStateAtom">,
  server: Pick<ReturnType<typeof createServerEnvironmentAtoms>, "payments" | "setPayments">,
) {
  const chosen = Atom.make<EnvironmentId | null>(null);
  const state = Atom.make((get) => {
    const entries = [...get(presentations)];
    const targets = entries.map(([id, p]) => ({ id, label: p.entry.target.label }));
    const id =
      get(chosen) ??
      entries.find(([, p]) => p.entry.target._tag === "PrimaryConnectionTarget")?.[0] ??
      (entries.length === 1 ? entries[0]?.[0] : null);
    const p = entries.find(([key]) => key === id)?.[1];
    const session = id
      ? AsyncResult.getOrElse(get(sessions.sessionStateAtom(id)), () => null)
      : null;
    const permitted =
      !!id &&
      p?.connection.phase === "connected" &&
      p.serverConfig?.environment.capabilities.usageArchive &&
      !!session &&
      sessionGrantsScope(session, AuthSettingsWriteScope);
    const result = permitted ? get(server.payments({ environmentId: id, input: {} })) : null;
    const ready = result ? AsyncResult.getOrElse(result, () => null) : null;
    return {
      id: id ?? null,
      targets,
      label: p?.entry.target.label ?? null,
      book: ready ?? {},
      writers: ready && id ? [id] : [],
    };
  });
  const select = (id: EnvironmentId) => registry.set(chosen, id);
  const save = async (id: EnvironmentId, patch: Readonly<Record<string, number | null>>) => {
    if (!registry.get(state).writers.includes(id)) return false;
    const result = await runAtomCommand(
      registry,
      server.setPayments,
      { environmentId: id, input: { payments: patch } },
      { reportFailure: false },
    );
    registry.refresh(server.payments({ environmentId: id, input: {} }));
    return result._tag === "Success";
  };
  return { state, select, save };
}

export function withUsageCopies<
  T extends {
    environmentId: EnvironmentId;
    summary: UsageSummary | null;
    isConnected: boolean;
    canReadDiagnostics: boolean;
    error: unknown;
    isPending: boolean;
    label: string;
  },
>(
  live: readonly T[],
  copies: readonly UsageArchiveCopy[],
  create: (copy: UsageArchiveCopy) => T,
): readonly T[] {
  const saved = new Map<EnvironmentId, UsageArchiveCopy>();
  for (const copy of copies) {
    if ((saved.get(copy.environmentId)?.summary.readAt ?? "") < copy.summary.readAt)
      saved.set(copy.environmentId, copy);
  }
  const result = live.map((row) => {
    const copy = saved.get(row.environmentId);
    saved.delete(row.environmentId);
    return copy && !row.isConnected ? create(copy) : row;
  });
  for (const copy of saved.values()) result.push(create(copy));
  return result;
}
