import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { resetBrowserHistoryForTests, useBrowserHistoryStore } from "./browserHistoryStore";

const storageKey = "t3code:browser-history:v1";
const oldEntry = { url: "http://example.test/removed", lastVisitedAt: 1 };
const otherEntry = { url: "http://example.test/other", lastVisitedAt: 2 };
const page = { url: "http://localhost:3000/page", lastVisitedAt: 3, title: "Page" };

const fallbackPrefix = `${storageKey}:fallback:`;

function fallbackKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith(fallbackPrefix));
}

function openHistoryFixture(disposables: DisposableStack) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(storageKey, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("history");
    request.onsuccess = () => {
      const db = request.result;
      disposables.defer(() => db.close());
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function readHistoryFixture(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("history").objectStore("history").get(storageKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeHistoryFixture(db: IDBDatabase, state: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("history", "readwrite");
    transaction.objectStore("history").put(state, storageKey);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

it.each([
  {
    name: "records a visit without bringing back a deleted URL",
    change: () => useBrowserHistoryStore.getState().recordVisit("a", "http://example.test/new", 4),
    expected: {
      byProjectKey: {
        a: [{ url: "http://example.test/new", lastVisitedAt: 4 }, page],
        b: [otherEntry],
      },
    },
  },
  {
    name: "titles the latest matching visit without changing its URL",
    change: () =>
      useBrowserHistoryStore.getState().setTitleForUrl("a", "http://127.0.0.1:3000/page/", "New"),
    expected: { byProjectKey: { a: [{ ...page, title: "New" }], b: [otherEntry] } },
  },
  {
    name: "removes a visit added elsewhere without clearing the other project",
    change: () => useBrowserHistoryStore.getState().removeUrl("a", page.url),
    expected: { byProjectKey: { b: [otherEntry] } },
  },
  {
    name: "registers a thread without replacing another tab's history",
    change: () =>
      useBrowserHistoryStore.getState().registerThreadProject(
        {
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("thread"),
        },
        "a",
      ),
    expected: { byProjectKey: { a: [page], b: [otherEntry] } },
  },
])("$name", async ({ change, expected }) => {
  await resetHistoryFixture();
  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    useBrowserHistoryStore.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toMatchObject({ byProjectKey: { a: [oldEntry] } }),
    );

    // Another document has committed newer history that this store has not heard about.
    await writeHistoryFixture(db, {
      byProjectKey: { a: [page], b: [otherEntry] },
      projectKeyByThreadKey: {},
    });
    change();

    await vi.waitFor(async () => {
      const saved = await readHistoryFixture(db);
      expect(saved).toHaveProperty("byProjectKey", expected.byProjectKey);
      expect(saved).toHaveProperty(
        "projectKeyByThreadKey",
        useBrowserHistoryStore.getState().projectKeyByThreadKey,
      );
    });
    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual(expected.byProjectKey),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("refreshes the open history when another document adds a visit", async () => {
  await resetHistoryFixture();
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
    );

    using documents = new DisposableStack();
    const otherStore = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(otherStore.getState().byProjectKey).toEqual({ a: [page] }));
    otherStore.getState().recordVisit("a", page.url, page.lastVisitedAt);

    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({ a: [page] }),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("caps the persisted mappings after importing multiple snapshots", async () => {
  await resetHistoryFixture();
  try {
    using documents = new DisposableStack();
    for (const group of ["first", "second"]) {
      const mappings = Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [`env:${group}-${index}`, "a"]),
      );
      localStorage.setItem(
        fallbackPrefix + group,
        JSON.stringify({
          state: { byProjectKey: { a: [page] }, projectKeyByThreadKey: mappings },
          version: 1,
        }),
      );
    }
    const store = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(store.getState().byProjectKey).toEqual({ a: [page] }));
    const db = await openHistoryFixture(documents);
    const saved = (await readHistoryFixture(db)) as {
      projectKeyByThreadKey: Record<string, string>;
    };
    expect(Object.keys(saved.projectKeyByThreadKey)).toHaveLength(100);
  } finally {
    await resetHistoryFixture();
  }
});

it("includes fallback history when receiving an IndexedDB notification", async () => {
  await resetHistoryFixture();
  try {
    using documents = new DisposableStack();
    const db = await openHistoryFixture(documents);
    const channel = new BroadcastChannel(storageKey);
    documents.defer(() => channel.close());
    localStorage.setItem(
      fallbackPrefix + "visit",
      JSON.stringify({ state: { byProjectKey: { b: [otherEntry] } }, version: 1 }),
    );
    await writeHistoryFixture(db, { byProjectKey: { a: [page] }, projectKeyByThreadKey: {} });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel is scoped to the origin
    channel.postMessage(null);
    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({
        a: [page],
        b: [otherEntry],
      }),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("bounds saved thread mappings while keeping live registrations", async () => {
  await resetHistoryFixture();
  const mappings = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`env:thread-${index}`, "a"]),
  );

  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    await writeHistoryFixture(db, { byProjectKey: { a: [page] }, projectKeyByThreadKey: mappings });
    const store = useBrowserHistoryStore.getState();
    const environmentId = EnvironmentId.make("env");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("thread-0") }, "a");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("pending") }, "b");
    const { "env:thread-0": _oldest, ...retained } = mappings;
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toHaveProperty("projectKeyByThreadKey", {
        ...retained,
        "env:pending": "b",
      }),
    );

    store.removeUrl("a", page.url);
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toHaveProperty("projectKeyByThreadKey", {
        "env:pending": "b",
      }),
    );
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey["env:thread-0"]).toBe("a");
  } finally {
    await resetHistoryFixture();
  }
});

async function openHistoryDocument(
  disposables: DisposableStack,
  { withoutIndexedDB = false } = {},
) {
  const source = new URL(import.meta.url);
  source.pathname = source.pathname.replace(/\.browser\.test\.ts$/, ".ts");
  source.search = "";
  const frame = document.createElement("iframe");
  disposables.defer(() => frame.remove());
  frame.srcdoc = `${withoutIndexedDB ? '<script>Object.defineProperty(window, "indexedDB", { value: { open() { throw new Error("blocked"); } } });</script>' : ""}
    <script type="module">
      import { useBrowserHistoryStore } from ${JSON.stringify(source.href)};
      window.historyStore = useBrowserHistoryStore;
    </script>`;
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    document.body.append(frame);
  });
  const store = (
    frame.contentWindow as (Window & { historyStore?: typeof useBrowserHistoryStore }) | null
  )?.historyStore;
  if (!store) throw new Error("The history document did not load.");
  return store;
}

function deleteHistoryDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(storageKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function resetHistoryFixture() {
  await resetBrowserHistoryForTests();
  localStorage.removeItem(storageKey);
  for (const key of fallbackKeys()) localStorage.removeItem(key);
  await deleteHistoryDatabase();
}

it("moves the legacy snapshot into the shared database", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    using documents = new DisposableStack();
    const first = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({ a: [page] }));
    expect(localStorage.getItem(storageKey)).toBeNull();
    first.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    await vi.waitFor(() => expect(first.getState().byProjectKey.b).toEqual([otherEntry]));

    const reopened = await openHistoryDocument(documents);
    await vi.waitFor(() =>
      expect(reopened.getState().byProjectKey).toEqual({ a: [page], b: [otherEntry] }),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("keeps a fallback write made after the migration read", async () => {
  await resetHistoryFixture();
  const first = JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 });
  const later = JSON.stringify({
    state: { byProjectKey: { a: [page], b: [otherEntry] } },
    version: 1,
  });
  localStorage.setItem(storageKey, first);
  try {
    const put = IDBObjectStore.prototype.put;
    using _put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      localStorage.setItem(storageKey, later);
      return put.call(this, value, key);
    });
    useBrowserHistoryStore.getState().recordVisit("c", oldEntry.url, oldEntry.lastVisitedAt);
    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey.c).toEqual([oldEntry]),
    );
    expect(localStorage.getItem(storageKey)).toBe(later);

    using documents = new DisposableStack();
    const reopened = await openHistoryDocument(documents);
    await vi.waitFor(() =>
      expect(reopened.getState().byProjectKey).toEqual({
        a: [page],
        b: [otherEntry],
        c: [oldEntry],
      }),
    );
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    await resetHistoryFixture();
  }
});

it("persists new visits from an open document after its history database is deleted", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    using documents = new DisposableStack();
    const first = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({ a: [page] }));
    first.getState().removeUrl("a", page.url);
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({}));

    await deleteHistoryDatabase();
    first.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    await vi.waitFor(() => expect(first.getState().byProjectKey.b).toEqual([otherEntry]));

    const reopened = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(reopened.getState().byProjectKey).toEqual({ b: [otherEntry] }));
  } finally {
    await resetHistoryFixture();
  }
});

it("keeps overlapping visits from independent documents", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    using documents = new DisposableStack();
    const [first, second] = await Promise.all([
      openHistoryDocument(documents),
      openHistoryDocument(documents),
    ]);
    first.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    second.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    const expected = { a: [page, oldEntry], b: [otherEntry] };
    await vi.waitFor(() => {
      expect(first.getState().byProjectKey).toEqual(expected);
      expect(second.getState().byProjectKey).toEqual(expected);
    });

    // A fresh document should read the committed visits even after the legacy seed is gone.
    localStorage.removeItem(storageKey);
    const reopened = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(reopened.getState().byProjectKey).toEqual(expected));
  } finally {
    await resetHistoryFixture();
  }
});

it("replaces a fallback snapshot when keeping both records would exceed quota", async () => {
  await resetHistoryFixture();
  try {
    const store = useBrowserHistoryStore.getState();
    const setItem = Storage.prototype.setItem;
    {
      using _transaction = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });
      store.recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
      await vi.waitFor(() => expect(fallbackKeys()).toHaveLength(1));
      using _quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key.startsWith(fallbackPrefix) && this.getItem(key) === null)
          throw new DOMException("Only one snapshot fits", "QuotaExceededError");
        setItem.call(this, key, value);
      });
      store.setTitleForUrl("a", oldEntry.url, "Kept within quota");
      await vi.waitFor(() =>
        expect(JSON.parse(localStorage.getItem(fallbackKeys()[0]!) ?? "null")).toMatchObject({
          state: { byProjectKey: { a: [{ ...oldEntry, title: "Kept within quota" }] } },
        }),
      );
      expect(fallbackKeys()).toHaveLength(1);
    }
  } finally {
    await resetHistoryFixture();
  }
});

it("keeps visits saved while IndexedDB could not open", async () => {
  await resetHistoryFixture();
  try {
    using documents = new DisposableStack();
    const db = await openHistoryFixture(documents);
    await writeHistoryFixture(db, { byProjectKey: { a: [page] }, projectKeyByThreadKey: {} });
    const offline = await openHistoryDocument(documents, { withoutIndexedDB: true });
    offline.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    await vi.waitFor(() => expect(fallbackKeys()).toHaveLength(1));
    expect(offline.getState().byProjectKey).toEqual({ b: [otherEntry] });

    const online = await openHistoryDocument(documents);
    await vi.waitFor(() =>
      expect(online.getState().byProjectKey).toEqual({ a: [page], b: [otherEntry] }),
    );
    expect(fallbackKeys()).toEqual([]);
  } finally {
    await resetHistoryFixture();
  }
});

it.each(["IndexedDB", "localStorage"])(
  "keeps a deletion saved to %s after an older tab writes",
  async (backend) => {
    await resetHistoryFixture();
    try {
      using fixture = new DisposableStack();
      const db = await openHistoryFixture(fixture);
      const store = useBrowserHistoryStore.getState();
      store.recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
      store.recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
      await vi.waitFor(() =>
        expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({
          a: [oldEntry],
          b: [otherEntry],
        }),
      );

      {
        using transaction =
          backend === "localStorage"
            ? vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
                throw new DOMException("Storage unavailable", "SecurityError");
              })
            : undefined;
        store.removeUrl("a", oldEntry.url);
        await vi.waitFor(() =>
          expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({ b: [otherEntry] }),
        );
        if (transaction) expect(fallbackKeys()).toHaveLength(1);
      }

      const recovered = await openHistoryDocument(fixture);
      await vi.waitFor(() => {
        expect(fallbackKeys()).toEqual([]);
        expect(recovered.getState().byProjectKey).toEqual({ b: [otherEntry] });
      });
      const saved = await readHistoryFixture(db);
      expect(saved).toHaveProperty("byProjectKey", { b: [otherEntry] });
      expect(JSON.stringify(saved)).not.toContain(oldEntry.url);

      localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { byProjectKey: { a: [oldEntry] } }, version: 1 }),
      );
      const reloaded = await openHistoryDocument(fixture);
      await vi.waitFor(() => {
        expect(localStorage.getItem(storageKey)).toBeNull();
        expect(reloaded.getState().byProjectKey).toEqual({ b: [otherEntry] });
      });

      const revisit = { ...oldEntry, lastVisitedAt: page.lastVisitedAt };
      reloaded.getState().recordVisit("a", revisit.url, revisit.lastVisitedAt);
      await vi.waitFor(async () =>
        expect(await readHistoryFixture(db)).toHaveProperty("byProjectKey", {
          a: [revisit],
          b: [otherEntry],
        }),
      );
    } finally {
      await resetHistoryFixture();
    }
  },
);

it.each(["localStorage", "IndexedDB"] as const)(
  "keeps unsaved changes when %s recovers",
  async (recoveredStorage) => {
    await resetHistoryFixture();
    try {
      using fixture = new DisposableStack();
      const db = await openHistoryFixture(fixture);
      const store = useBrowserHistoryStore.getState();
      store.recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
      await vi.waitFor(() =>
        expect(useBrowserHistoryStore.getState().byProjectKey.a).toEqual([oldEntry]),
      );

      using transaction = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });
      {
        using _write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        });
        for (const at of [0, 1, otherEntry.lastVisitedAt])
          store.recordVisit("a", otherEntry.url, at);
        await vi.waitFor(() =>
          expect(useBrowserHistoryStore.getState().byProjectKey.a).toEqual([otherEntry, oldEntry]),
        );
        store.removeUrl("a", oldEntry.url);
        await vi.waitFor(() =>
          expect(useBrowserHistoryStore.getState().byProjectKey.a).toEqual([otherEntry]),
        );
      }

      const expected = {
        a: [{ url: page.url, lastVisitedAt: page.lastVisitedAt }, otherEntry],
      };
      if (recoveredStorage === "IndexedDB") {
        transaction.mockRestore();
      } else {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ state: { byProjectKey: { a: [oldEntry] } }, version: 1 }),
        );
      }
      store.recordVisit("a", page.url, page.lastVisitedAt);
      await vi.waitFor(() =>
        expect(useBrowserHistoryStore.getState().byProjectKey).toEqual(expected),
      );
      if (recoveredStorage === "IndexedDB") {
        expect(await readHistoryFixture(db)).toMatchObject({ byProjectKey: expected });
      } else {
        const keys = fallbackKeys();
        expect(keys).toHaveLength(1);
        expect(JSON.parse(localStorage.getItem(keys[0]!)!)).toMatchObject({
          state: { byProjectKey: expected },
        });
      }
    } finally {
      await resetHistoryFixture();
    }
  },
);

it.each([
  {
    name: "imports a fallback title for the same untitled IndexedDB visit",
    indexedTitle: undefined,
  },
  {
    name: "keeps a concurrent IndexedDB title ahead of a fallback title",
    indexedTitle: "Concurrent title",
  },
])("$name", async ({ indexedTitle }) => {
  await resetHistoryFixture();
  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    const store = useBrowserHistoryStore.getState();
    store.recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toHaveProperty("byProjectKey.a", [oldEntry]),
    );
    localStorage.setItem(
      storageKey,
      JSON.stringify({ state: { byProjectKey: { b: [otherEntry] } }, version: 1 }),
    );
    {
      using _transaction = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
        throw new DOMException("Storage unavailable", "SecurityError");
      });
      store.setTitleForUrl("a", oldEntry.url, "Recovered title");
      await vi.waitFor(() => expect(fallbackKeys()).toHaveLength(1));
    }
    if (indexedTitle)
      await writeHistoryFixture(db, {
        byProjectKey: { a: [{ ...oldEntry, title: indexedTitle }] },
        projectKeyByThreadKey: {},
      });
    const expected = [{ ...oldEntry, title: indexedTitle ?? "Recovered title" }];
    const recovered = await openHistoryDocument(fixture);
    await vi.waitFor(() => expect(recovered.getState().byProjectKey.a).toEqual(expected));
    expect(await readHistoryFixture(db)).toHaveProperty("byProjectKey", {
      a: expected,
      b: [otherEntry],
    });
  } finally {
    await resetHistoryFixture();
  }
});

it.each(["empty", "revisited"] as const)(
  "recovers unsaved history when IndexedDB reopens %s",
  async (status) => {
    await resetHistoryFixture();
    try {
      using fixture = new DisposableStack();
      const db = await openHistoryFixture(fixture);
      const store = useBrowserHistoryStore.getState();
      store.recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
      await vi.waitFor(async () =>
        expect(await readHistoryFixture(db)).toHaveProperty("byProjectKey.a", [oldEntry]),
      );
      const revisit = { ...oldEntry, lastVisitedAt: 10 };
      {
        using _transaction = vi
          .spyOn(IDBDatabase.prototype, "transaction")
          .mockImplementation(() => {
            throw new DOMException("Storage unavailable", "SecurityError");
          });
        using _write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        });
        if (status === "empty") {
          store.setTitleForUrl("a", oldEntry.url, "Only in memory");
          await vi.waitFor(() =>
            expect(useBrowserHistoryStore.getState().byProjectKey.a).toEqual([
              { ...oldEntry, title: "Only in memory" },
            ]),
          );
        } else {
          store.removeUrl("a", oldEntry.url);
          await vi.waitFor(() =>
            expect(useBrowserHistoryStore.getState().byProjectKey.a).toBeUndefined(),
          );
        }
      }
      await writeHistoryFixture(db, {
        byProjectKey: status === "empty" ? {} : { a: [revisit] },
        projectKeyByThreadKey: {},
      });
      store.recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
      await vi.waitFor(async () =>
        expect(await readHistoryFixture(db)).toHaveProperty("byProjectKey", {
          a: status === "empty" ? [{ ...oldEntry, title: "Only in memory" }] : [revisit],
          b: [otherEntry],
        }),
      );
    } finally {
      await resetHistoryFixture();
    }
  },
);
