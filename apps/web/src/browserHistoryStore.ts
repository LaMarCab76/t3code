import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewSessionSnapshot,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { normalizePreviewUrl } from "@t3tools/shared/preview";
import {
  previewStateAtom,
  previewThreadRefsAtom,
  readThreadPreviewState,
  type ThreadPreviewState,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  readProject,
  readProjects,
  readThreadShell,
  useProjects,
  useQuietThreadShell,
} from "~/state/entities";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "~/state/environments";
import { readPreparedConnection } from "~/state/session";

import { isLocalLoopbackHost, normalizeHostname } from "./browser/browserTargetResolver";
import { useComposerDraftStore } from "./composerDraftStore";
import { randomUUID } from "./lib/utils";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  isClientSettingsHydrated,
  useClientSettings,
} from "./hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "./sidebarProjectGrouping";
import type { Project } from "./types";

export type BrowserHistoryEntry = { url: string; lastVisitedAt: number; title?: string };

export const BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT = 50;
export const BROWSER_HISTORY_MAX_PROJECTS = 20;
const BROWSER_HISTORY_MAX_URL_LENGTH = 2048;
const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

export function isValidHistoryTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_VALID_DATE_MS
  );
}

export function normalizeHistoryUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(normalizePreviewUrl(raw));
  } catch {
    return null;
  }
  parsed.username = parsed.password = "";
  return parsed.href.length > BROWSER_HISTORY_MAX_URL_LENGTH ? null : parsed.href;
}

function titleLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(visitLookupKey(normalized, environmentHostname));
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/"))
    parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.href;
}

function visitLookupKey(normalized: string, environmentHostname?: string | null): string {
  const parsed = new URL(normalized);
  const host = normalizeHostname(parsed.hostname);
  const environmentHost = environmentHostname && normalizeHostname(environmentHostname);
  if (isLocalLoopbackHost(host) || host === "0.0.0.0" || host === environmentHost)
    parsed.hostname = "local";
  return parsed.href;
}

function isStableLocalUrl(normalized: string): boolean {
  const host = normalizeHostname(new URL(normalized).hostname);
  return isLocalLoopbackHost(host) || host === "0.0.0.0";
}

export function upsertHistoryEntry(
  entries: ReadonlyArray<BrowserHistoryEntry>,
  url: string,
  at: number,
  options?: { insertOrdered?: boolean; environmentHostname?: string | null },
): BrowserHistoryEntry[] {
  const key = visitLookupKey(url, options?.environmentHostname);
  const existing = entries.find(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) === key,
  );
  const rest = entries.filter(
    (candidate) => visitLookupKey(candidate.url, options?.environmentHostname) !== key,
  );
  const visitedAt =
    options?.insertOrdered && existing && existing.lastVisitedAt > at ? existing.lastVisitedAt : at;
  const storedUrl =
    existing && (isStableLocalUrl(existing.url) || !isStableLocalUrl(url)) ? existing.url : url;
  const entry: BrowserHistoryEntry = existing
    ? { ...existing, url: storedUrl, lastVisitedAt: visitedAt }
    : { url, lastVisitedAt: visitedAt };
  if (!options?.insertOrdered)
    return [entry, ...rest].slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
  const index = rest.findIndex((candidate) => candidate.lastVisitedAt < entry.lastVisitedAt);
  const next = index === -1 ? [...rest, entry] : rest.toSpliced(index, 0, entry);
  return next.slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
}

function evictExcessProjects(
  byProjectKey: Record<string, BrowserHistoryEntry[]>,
): Record<string, BrowserHistoryEntry[]> {
  const keys = Object.keys(byProjectKey);
  if (keys.length <= BROWSER_HISTORY_MAX_PROJECTS) return byProjectKey;
  const kept = keys
    .toSorted(
      (a, b) =>
        (byProjectKey[b]?.[0]?.lastVisitedAt ?? 0) - (byProjectKey[a]?.[0]?.lastVisitedAt ?? 0),
    )
    .slice(0, BROWSER_HISTORY_MAX_PROJECTS);
  return Object.fromEntries(kept.map((key) => [key, byProjectKey[key] ?? []]));
}

export function migratePersistedBrowserHistoryState(
  persistedState: unknown,
  fallbackRemovals?: Readonly<Record<string, number>>,
): {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byProjectKey: {} };
  const raw = (persistedState as { byProjectKey?: unknown }).byProjectKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { byProjectKey: {} };
  const byProjectKey: Record<string, BrowserHistoryEntry[]> = {};
  for (const [projectKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const seenUrls = new Set<string>();
    const entries = value
      .flatMap<BrowserHistoryEntry>((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const { url, lastVisitedAt, title } = candidate as Record<string, unknown>;
        if (typeof url !== "string") return [];
        const normalizedUrl = normalizeHistoryUrl(url);
        if (!normalizedUrl) return [];
        if (!isValidHistoryTimestamp(lastVisitedAt)) return [];
        if (
          fallbackRemovals &&
          lastVisitedAt <=
            (fallbackRemovals[historyRemovalKey(projectKey, normalizedUrl)] ?? -Infinity)
        )
          return [];
        return [
          {
            url: normalizedUrl,
            lastVisitedAt,
            ...(typeof title === "string" && title.length > 0
              ? { title: title.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) }
              : {}),
          },
        ];
      })
      .toSorted((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .filter((entry) => {
        const key = visitLookupKey(entry.url);
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      })
      .slice(0, BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT);
    if (entries.length > 0) byProjectKey[projectKey] = entries;
  }
  return { byProjectKey: evictExcessProjects(byProjectKey) };
}

const BROWSER_HISTORY_STORAGE_KEY = "t3code:browser-history:v1";
const BROWSER_HISTORY_FALLBACK_PREFIX = `${BROWSER_HISTORY_STORAGE_KEY}:fallback:`;

const MAX_PERSISTED_THREAD_MAPPINGS = 100;
const PENDING_MAX_PER_THREAD = 10;
const PENDING_MAX_THREADS = 20;

type PendingVisit = { url: string; at: number; environmentHostname: string | null };

interface BrowserHistoryStoreState {
  byProjectKey: Record<string, BrowserHistoryEntry[]>;
  projectKeyByThreadKey: Record<string, string>;
  pendingVisitsByThreadKey: Record<string, PendingVisit[]>;
  recordVisit: (
    projectKey: string,
    url: string,
    at: number,
    options?: { insertOrdered?: boolean; environmentHostname?: string | null },
  ) => void;
  setTitleForUrl: (
    projectKey: string,
    url: string,
    title: string,
    options?: { environmentHostname?: string | null; onlyIfUntitled?: boolean },
  ) => void;
  removeUrl: (projectKey: string, url: string) => void;
  registerThreadProject: (ref: ScopedThreadRef, projectKey: string) => void;
}

function addPendingByThread<T>(
  pendingByThreadKey: Record<string, T[]>,
  threadKey: string,
  item: T,
): Record<string, T[]> {
  const existing = pendingByThreadKey[threadKey] ?? [];
  const next = { ...pendingByThreadKey };
  next[threadKey] = [...existing, item].slice(-PENDING_MAX_PER_THREAD);
  const keys = Object.keys(next);
  if (keys.length > PENDING_MAX_THREADS) {
    const oldestKey = keys[0];
    if (oldestKey !== undefined && oldestKey !== threadKey) delete next[oldestKey];
  }
  return next;
}

type PersistedBrowserHistory = Pick<
  BrowserHistoryStoreState,
  "byProjectKey" | "projectKeyByThreadKey"
> & { readonly fallbackRemovals?: Readonly<Record<string, number>> };

type UpdateHistory = (
  state: PersistedBrowserHistory,
  fallback?: boolean,
) => PersistedBrowserHistory;

function historyRemovalKey(projectKey: string, url: string): string {
  // Keep the removal without retaining the deleted URL.
  return bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify([projectKey, visitLookupKey(url)]))),
  );
}

function readFallbackRemovals(state: unknown): Record<string, number> {
  const raw = (state as { fallbackRemovals?: unknown } | null | undefined)?.fallbackRemovals;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([key, value]) => /^[a-f0-9]{64}$/.test(key) && isValidHistoryTimestamp(value),
    ),
  );
}

function boundThreadMappings(
  previous: PersistedBrowserHistory,
  next: PersistedBrowserHistory,
): PersistedBrowserHistory {
  return {
    ...next,
    projectKeyByThreadKey: Object.fromEntries(
      Object.entries(next.projectKeyByThreadKey)
        // Keep new registrations for empty projects, but drop projects that lost their history.
        .filter(
          ([, projectKey]) =>
            !Object.hasOwn(previous.byProjectKey, projectKey) ||
            Object.hasOwn(next.byProjectKey, projectKey),
        )
        .slice(-MAX_PERSISTED_THREAD_MAPPINGS),
    ),
  };
}

const HISTORY_OBJECT_STORE = "history";
const EMPTY_PERSISTED_HISTORY: PersistedBrowserHistory = {
  byProjectKey: {},
  projectKeyByThreadKey: {},
};
let historyDatabase: Promise<IDBDatabase> | undefined;
let historyChannel: BroadcastChannel | undefined;
let historySync = Promise.resolve();
let unsavedHistoryUpdates: UpdateHistory[] = [];
let unsavedHistoryBase: PersistedBrowserHistory | undefined;

interface HistorySnapshot {
  readonly key: string;
  readonly raw: string;
  readonly history: PersistedBrowserHistory;
}

function readHistorySnapshots(): HistorySnapshot[] {
  try {
    const storage = window.localStorage;
    const keys = [BROWSER_HISTORY_STORAGE_KEY];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(BROWSER_HISTORY_FALLBACK_PREFIX)) keys.push(key);
    }
    return keys.flatMap((key) => {
      const raw = storage.getItem(key);
      if (raw === null) return [];
      try {
        const parsed: { state?: unknown } | null = JSON.parse(raw);
        return [
          {
            key,
            raw,
            history: {
              ...migratePersistedBrowserHistoryState(parsed?.state),
              projectKeyByThreadKey: migratePersistedThreadProjectKeys(parsed?.state),
              fallbackRemovals: readFallbackRemovals(parsed?.state),
            },
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function retireHistorySnapshots(snapshots: readonly HistorySnapshot[]): void {
  try {
    const storage = window.localStorage;
    for (const { key, raw } of snapshots) {
      // Fallback keys are immutable. Older clients may still overwrite the original key.
      if (key !== BROWSER_HISTORY_STORAGE_KEY || storage.getItem(key) === raw)
        storage.removeItem(key);
    }
  } catch {
    // The browser can deny access to localStorage independently of IndexedDB.
  }
}

function mergeHistorySnapshots(
  saved: PersistedBrowserHistory | undefined,
  snapshots: readonly HistorySnapshot[],
): PersistedBrowserHistory | undefined {
  if (snapshots.length === 0) return saved;
  const histories = snapshots.map(({ history }) => history);
  if (saved) histories.unshift(saved);
  const byProjectKey: Record<string, BrowserHistoryEntry[]> = Object.create(null);
  const fallbackRemovals: Record<string, number> = {};
  for (const history of histories) {
    for (const [projectKey, entries] of Object.entries(history.byProjectKey))
      (byProjectKey[projectKey] ??= []).push(...entries);
    for (const [key, at] of Object.entries(history.fallbackRemovals ?? {}))
      fallbackRemovals[key] = Math.max(at, fallbackRemovals[key] ?? -Infinity);
  }
  const hasRemovals = Object.keys(fallbackRemovals).length > 0;
  return {
    ...migratePersistedBrowserHistoryState(
      { byProjectKey },
      hasRemovals ? fallbackRemovals : undefined,
    ),
    projectKeyByThreadKey: Object.fromEntries(
      histories.toReversed().flatMap((history) => Object.entries(history.projectKeyByThreadKey)),
    ),
    ...(hasRemovals ? { fallbackRemovals } : {}),
  };
}

// Without IndexedDB, merge into the freshest localStorage snapshot so a reload keeps new visits.
function transactLegacyHistory(update: UpdateHistory, current: PersistedBrowserHistory) {
  const snapshots = readHistorySnapshots();
  const previous = mergeHistorySnapshots(undefined, snapshots) ?? current;
  const history = update(previous, true);
  if (history === previous) return { history, unsavedBase: undefined };
  try {
    window.localStorage.setItem(
      `${BROWSER_HISTORY_FALLBACK_PREFIX}${randomUUID()}`,
      JSON.stringify({ state: history, version: 1 }),
    );
    retireHistorySnapshots(snapshots);
    return { history, unsavedBase: undefined };
  } catch {
    return { history, unsavedBase: previous };
  }
}

function invalidateHistoryDatabase(opening: Promise<IDBDatabase>): void {
  if (historyDatabase === opening) historyDatabase = undefined;
}

function openHistoryDatabase() {
  if (historyDatabase) return historyDatabase;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_HISTORY_STORAGE_KEY, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HISTORY_OBJECT_STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => invalidateHistoryDatabase(opening);
      db.onversionchange = () => {
        invalidateHistoryDatabase(opening);
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  historyDatabase = opening;
  void opening.catch(() => invalidateHistoryDatabase(opening));
  return opening;
}

async function transactIndexedHistory(update?: UpdateHistory, retry = true) {
  const opening = openHistoryDatabase();
  const db = await opening;
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(HISTORY_OBJECT_STORE, update ? "readwrite" : "readonly");
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      invalidateHistoryDatabase(opening);
      if (retry) return transactIndexedHistory(update, false);
    }
    throw error;
  }

  return new Promise<{ history: PersistedBrowserHistory; changed: boolean }>((resolve, reject) => {
    const store = transaction.objectStore(HISTORY_OBJECT_STORE);
    const request = store.get(BROWSER_HISTORY_STORAGE_KEY);
    let history: PersistedBrowserHistory;
    let changed = false;
    let snapshots: readonly HistorySnapshot[] = [];
    request.onsuccess = () => {
      const saved = request.result as PersistedBrowserHistory | undefined;
      if (update) snapshots = readHistorySnapshots();
      const previous = mergeHistorySnapshots(saved, snapshots) ?? EMPTY_PERSISTED_HISTORY;
      history = update?.(previous) ?? previous;
      changed = history !== saved;
      if (update && changed) store.put(history, BROWSER_HISTORY_STORAGE_KEY);
    };
    transaction.oncomplete = () => {
      // Keep the migration source until the IndexedDB snapshot has committed.
      if (snapshots.length > 0) retireHistorySnapshots(snapshots);
      resolve({ history, changed });
    };
    transaction.onabort = () => reject(transaction.error);
  });
}

export const useBrowserHistoryStore = create<BrowserHistoryStoreState>()((set, get) => {
  const publish = ({ byProjectKey }: PersistedBrowserHistory) => {
    if (byProjectKey !== get().byProjectKey) set({ byProjectKey });
  };
  const updateHistory = (update: UpdateHistory) => {
    if (typeof window === "undefined") {
      publish(update(get()));
      return;
    }
    historySync = historySync.then(async () => {
      unsavedHistoryUpdates.push(update);
      const replay: UpdateHistory = (base, fallback) =>
        unsavedHistoryUpdates.reduce((state, apply) => {
          const next = apply(state, fallback);
          return next === state ? state : boundThreadMappings(state, next);
        }, base);
      const saved = await transactIndexedHistory(replay).catch(() => null);
      if (saved) {
        unsavedHistoryUpdates = [];
        unsavedHistoryBase = undefined;
        publish(saved.history);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is scoped to the origin
        if (saved.changed) historyChannel?.postMessage(null);
        return;
      }
      const { byProjectKey, projectKeyByThreadKey } = get();
      const fallback = transactLegacyHistory(
        replay,
        unsavedHistoryBase ?? { byProjectKey, projectKeyByThreadKey },
      );
      unsavedHistoryBase = fallback.unsavedBase;
      if (!unsavedHistoryBase) unsavedHistoryUpdates = [];
      publish(fallback.history);
    });
  };

  return mergeBrowserHistoryState(undefined, {
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
    recordVisit: (projectKey, url, at, options) => {
      const normalized = normalizeHistoryUrl(url);
      if (!normalized) return;
      updateHistory((state) => {
        if (
          state.fallbackRemovals &&
          at <= (state.fallbackRemovals[historyRemovalKey(projectKey, normalized)] ?? -Infinity)
        )
          return state;
        const entries = state.byProjectKey[projectKey] ?? [];
        return {
          ...state,
          byProjectKey: evictExcessProjects({
            ...state.byProjectKey,
            [projectKey]: upsertHistoryEntry(entries, normalized, at, {
              ...options,
              insertOrdered: options?.insertOrdered || (entries[0]?.lastVisitedAt ?? at) > at,
            }),
          }),
        };
      });
    },
    setTitleForUrl: (projectKey, url, title, options) => {
      const normalized = normalizeHistoryUrl(url);
      const trimmed = title.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
      if (!normalized || trimmed.length === 0) return;
      const key = titleLookupKey(normalized, options?.environmentHostname);
      updateHistory((state) => {
        const entries = state.byProjectKey[projectKey];
        const index =
          entries?.findIndex(
            (candidate) => titleLookupKey(candidate.url, options?.environmentHostname) === key,
          ) ?? -1;
        const entry = entries?.[index];
        if (
          !entries ||
          !entry ||
          entry.title === trimmed ||
          (entry.title && options?.onlyIfUntitled)
        )
          return state;
        return {
          ...state,
          byProjectKey: {
            ...state.byProjectKey,
            [projectKey]: entries.with(index, { ...entry, title: trimmed }),
          },
        };
      });
    },
    removeUrl: (projectKey, url) => {
      const normalized = normalizeHistoryUrl(url);
      if (!normalized) return;
      const observed = get().byProjectKey[projectKey]?.find((entry) => entry.url === normalized);
      updateHistory((state, fallback) => {
        const entries = state.byProjectKey[projectKey] ?? [];
        const index = entries.findIndex((entry) => entry.url === normalized);
        let next = state;
        if (index !== -1) {
          const byProjectKey = { ...state.byProjectKey };
          if (entries.length === 1) delete byProjectKey[projectKey];
          else byProjectKey[projectKey] = entries.toSpliced(index, 1);
          next = { ...state, byProjectKey };
        }
        if (!fallback) return next;
        const removedThrough = Math.max(
          entries[index]?.lastVisitedAt ?? -Infinity,
          observed?.lastVisitedAt ?? -Infinity,
        );
        if (removedThrough === -Infinity) return next;
        const key = historyRemovalKey(projectKey, normalized);
        if (removedThrough <= (state.fallbackRemovals?.[key] ?? -Infinity)) return next;
        return { ...next, fallbackRemovals: { ...state.fallbackRemovals, [key]: removedThrough } };
      });
    },
    registerThreadProject: (ref, projectKey) => {
      const threadKey = scopedThreadKey(ref);
      const state = get();
      const pendingVisits = state.pendingVisitsByThreadKey[threadKey];
      if (state.projectKeyByThreadKey[threadKey] === projectKey && !pendingVisits) return;
      const nextPendingVisits = { ...state.pendingVisitsByThreadKey };
      delete nextPendingVisits[threadKey];
      set({
        projectKeyByThreadKey: { ...state.projectKeyByThreadKey, [threadKey]: projectKey },
        pendingVisitsByThreadKey: nextPendingVisits,
      });
      updateHistory((shared) =>
        shared.projectKeyByThreadKey[threadKey] === projectKey
          ? shared
          : {
              ...shared,
              projectKeyByThreadKey: { ...shared.projectKeyByThreadKey, [threadKey]: projectKey },
            },
      );
      for (const visit of pendingVisits ?? [])
        get().recordVisit(projectKey, visit.url, visit.at, {
          insertOrdered: true,
          environmentHostname: visit.environmentHostname,
        });
      if (pendingVisits)
        recordPreviewTitles(ref, readThreadPreviewState(ref), {
          urls: pendingVisits.map((visit) => visit.url),
        });
    },
  });
});

if (typeof window !== "undefined") {
  try {
    historyChannel = new BroadcastChannel(BROWSER_HISTORY_STORAGE_KEY);
  } catch {
    // History still persists when the browser cannot send change notifications.
  }
  if (historyChannel) {
    historyChannel.onmessage = () => {
      historySync = historySync.then(async () => {
        if (unsavedHistoryUpdates.length > 0) return;
        const saved = await transactIndexedHistory().catch(() => null);
        if (saved) useBrowserHistoryStore.setState({ byProjectKey: saved.history.byProjectKey });
      });
    };
  }
  const hydrate = (history: PersistedBrowserHistory) => {
    useBrowserHistoryStore.setState((state) => ({
      byProjectKey: history.byProjectKey,
      projectKeyByThreadKey: {
        ...migratePersistedThreadProjectKeys(history, history.byProjectKey),
        ...state.projectKeyByThreadKey,
      },
    }));
  };
  historySync = transactIndexedHistory((history) => history).then(
    ({ history }) => hydrate(history),
    () =>
      hydrate(mergeHistorySnapshots(undefined, readHistorySnapshots()) ?? EMPTY_PERSISTED_HISTORY),
  );
  import.meta.hot?.dispose(() => {
    historyChannel?.close();
    historyChannel = undefined;
    void historyDatabase?.then(
      (db) => db.close(),
      () => undefined,
    );
  });
}

export function mergeBrowserHistoryState(
  persistedState: unknown,
  currentState: BrowserHistoryStoreState,
): BrowserHistoryStoreState {
  const migrated = migratePersistedBrowserHistoryState(persistedState);
  return {
    ...currentState,
    ...migrated,
    projectKeyByThreadKey: migratePersistedThreadProjectKeys(persistedState, migrated.byProjectKey),
    pendingVisitsByThreadKey: {},
  };
}

function migratePersistedThreadProjectKeys(
  persistedState: unknown,
  byProjectKey?: Record<string, BrowserHistoryEntry[]>,
): Record<string, string> {
  if (!persistedState || typeof persistedState !== "object") return {};
  const raw = (persistedState as { projectKeyByThreadKey?: unknown }).projectKeyByThreadKey;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && (!byProjectKey || Object.hasOwn(byProjectKey, entry[1])),
  );
  return Object.fromEntries(entries.slice(-MAX_PERSISTED_THREAD_MAPPINGS));
}

/**
 * History follows the sidebar's project rows, so a duplicate row shares the
 * history of the group it is listed under rather than keying by its own path.
 */
function deriveHistoryProjectKey(
  project: Project,
  projects: ReadonlyArray<Project>,
  settings: ProjectGroupingSettings,
  primaryEnvironmentId: EnvironmentId | null,
): string {
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }).get(
      derivePhysicalProjectKey(project),
    ) ?? deriveLogicalProjectKeyFromSettings(project, settings)
  );
}

/** Server threads name their project in the shell; drafts in the composer draft store. */
function readThreadProjectRef(ref: ScopedThreadRef): ScopedProjectRef | null {
  const projectId = readThreadShell(ref)?.projectId;
  if (projectId) return scopeProjectRef(ref.environmentId, projectId);
  const draft = useComposerDraftStore.getState().getDraftSessionByRef(ref);
  return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
}

/**
 * Registers the thread under its current project so queued visits and titles
 * land. Until the project loads, or client settings hydrate (the grouping is
 * unknown before then), the last registration stands and writes stay queued.
 */
function resolveThreadProjectKey(ref: ScopedThreadRef): string | undefined {
  const state = useBrowserHistoryStore.getState();
  const registered = state.projectKeyByThreadKey[scopedThreadKey(ref)];
  if (!isClientSettingsHydrated()) {
    void ensureClientSettingsHydrated().then(
      () => resolveThreadProjectKey(ref),
      () => undefined,
    );
    return registered;
  }
  const projectRef = readThreadProjectRef(ref);
  const project = projectRef ? readProject(projectRef) : null;
  if (!project) return registered;
  const projectKey = deriveHistoryProjectKey(
    project,
    readProjects(),
    selectProjectGroupingSettings(getClientSettings()),
    readPrimaryEnvironmentId(),
  );
  state.registerThreadProject(ref, projectKey);
  return projectKey;
}

export function recordVisitForThread(ref: ScopedThreadRef, url: string, at?: number): void {
  const threadKey = scopedThreadKey(ref);
  const projectKey = resolveThreadProjectKey(ref);
  const state = useBrowserHistoryStore.getState();
  const visitAt = at ?? Date.now();
  const connection = readPreparedConnection(ref.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : null;
  if (!projectKey) {
    useBrowserHistoryStore.setState({
      pendingVisitsByThreadKey: addPendingByThread(state.pendingVisitsByThreadKey, threadKey, {
        url,
        at: visitAt,
        environmentHostname,
      }),
    });
    return;
  }
  state.recordVisit(projectKey, url, visitAt, { environmentHostname });
  // A page can settle before the address bar records its visit.
  recordPreviewTitles(ref, readThreadPreviewState(ref), { urls: [url] });
}

/**
 * History is shared across a project's threads and settled sessions are retained,
 * so replaying an old settle would clobber another thread's newer title. Visits
 * only fill untitled entries; settles apply only pages that loaded or retitled.
 */
function recordPreviewTitles(
  ref: ScopedThreadRef,
  preview: ThreadPreviewState,
  only:
    | { readonly urls: ReadonlyArray<string> }
    | { readonly changedSince: ThreadPreviewState["sessions"] },
): void {
  const state = useBrowserHistoryStore.getState();
  const projectKey = state.projectKeyByThreadKey[scopedThreadKey(ref)];
  if (!projectKey) return;
  const connection = readPreparedConnection(ref.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : null;
  const titleKey = (url: string) => {
    const normalized = normalizeHistoryUrl(url);
    return normalized ? titleLookupKey(normalized, environmentHostname) : null;
  };
  const visitKeys = "urls" in only ? new Set(only.urls.map(titleKey)) : null;
  // Resizes and list reconciles replace a session without loading a new page.
  const settledAgain = (session: PreviewSessionSnapshot, previous?: PreviewSessionSnapshot) =>
    previous?.navStatus._tag === "Success" &&
    session.navStatus._tag === "Success" &&
    previous.navStatus.url === session.navStatus.url &&
    previous.navStatus.title === session.navStatus.title;
  const include = (session: PreviewSessionSnapshot, url: string) =>
    "changedSince" in only
      ? !settledAgain(session, only.changedSince[session.tabId])
      : (visitKeys?.has(titleKey(url)) ?? false);
  // A fill uses the newest eligible title first because it only sets an untitled entry.
  const sessions = Object.values(preview.sessions).toSorted((a, b) =>
    "urls" in only
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.updatedAt.localeCompare(b.updatedAt),
  );
  for (const session of sessions) {
    const status = session.navStatus;
    if (session.profileId === INCOGNITO_BROWSER_PROFILE_ID) continue;
    if (status._tag !== "Success" || !status.title || !include(session, status.url)) continue;
    state.setTitleForUrl(projectKey, status.url, status.title, {
      environmentHostname,
      onlyIfUntitled: "urls" in only,
    });
  }
}

/** Records settled page titles for every thread with previews, for the life of the page. */
export function startPreviewTitleRecording(): () => void {
  const followed = new Map<string, () => void>();
  const followNewThreads = (refs: ReadonlyMap<string, ScopedThreadRef>) => {
    for (const [threadKey, threadRef] of refs) {
      if (followed.has(threadKey)) continue;
      const atom = previewStateAtom(threadKey);
      let previousSessions = appAtomRegistry.get(atom).sessions;
      followed.set(
        threadKey,
        appAtomRegistry.subscribe(atom, (next) => {
          if (next.sessions === previousSessions) return;
          const changedSince = previousSessions;
          previousSessions = next.sessions;
          recordPreviewTitles(threadRef, next, { changedSince });
        }),
      );
    }
  };
  const stopIndex = appAtomRegistry.subscribe(previewThreadRefsAtom, followNewThreads, {
    immediate: true,
  });
  return () => {
    stopIndex();
    for (const stop of followed.values()) stop();
  };
}

export function removeUrlForThread(ref: ScopedThreadRef, url: string): void {
  const projectKey = resolveThreadProjectKey(ref);
  if (!projectKey) return;
  useBrowserHistoryStore.getState().removeUrl(projectKey, url);
}

const EMPTY_HISTORY: ReadonlyArray<BrowserHistoryEntry> = [];

function useThreadHistoryProjectKey(ref: ScopedThreadRef): string | null {
  const threadKey = scopedThreadKey(ref);
  const shellProjectId = useQuietThreadShell(ref)?.projectId ?? null;
  const draftProjectKey = useComposerDraftStore((state) => {
    const draft = state.getDraftSessionByRef(ref);
    return draft ? scopedProjectKey(scopeProjectRef(draft.environmentId, draft.projectId)) : null;
  });
  const projectKey = shellProjectId
    ? scopedProjectKey(scopeProjectRef(ref.environmentId, shellProjectId))
    : draftProjectKey;
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registered = useBrowserHistoryStore(
    (state) => state.projectKeyByThreadKey[threadKey] ?? null,
  );
  const project = projects.find(
    (candidate) =>
      scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)) === projectKey,
  );
  return project
    ? deriveHistoryProjectKey(project, projects, settings, primaryEnvironmentId)
    : registered;
}

export function useThreadRecentHistory(
  ref: ScopedThreadRef,
  limit: number,
): ReadonlyArray<BrowserHistoryEntry> {
  const projectKey = useThreadHistoryProjectKey(ref);
  return useBrowserHistoryStore(
    useShallow((state) => {
      const entries = projectKey ? state.byProjectKey[projectKey] : undefined;
      return entries && entries.length > 0 ? entries.slice(0, limit) : EMPTY_HISTORY;
    }),
  );
}

export function resetBrowserHistoryForTests(): void {
  useBrowserHistoryStore.setState({
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
  });
}
