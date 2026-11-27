import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageArchiveDay,
  UsageDay,
  UsageReadError,
  type UsageArchiveCopy,
  type UsageArchivePage,
  type UsageBucket,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { keepsUsageRecord } from "./usageAggregation.ts";
import type { UsageService } from "./UsageService.ts";
import type { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const DAY = 86_400_000;
const StoredDay = Schema.Struct({
  revision: UsageArchiveDay.fields.revision,
  day: UsageDay,
  source: UsageArchiveDay.fields.source,
  buckets: UsageArchiveDay.fields.buckets,
  modelFilter: UsageArchiveDay.fields.modelFilter,
});
const payloadSchema = Schema.fromJsonString(StoredDay);
const encodeDay = Schema.encodeSync(payloadSchema);
const decodeDay = Schema.decodeUnknownSync(payloadSchema);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const pair = Schema.encodeSync(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])));
const fail = (cause: unknown) =>
  new UsageReadError({
    reason: "scanFailed",
    detail: "Could not update the usage archive.",
    cause,
  });
const sourceKey = (source: UsageSource) => JSON.stringify(source.fingerprint);
const dayAt = (ms: number) => UsageDay.make(iso(ms).slice(0, 10));
const numberFields = [
  "costUsd",
  "cacheSavingsUsd",
  "fastCostUsd",
  "ultrafastCostUsd",
  "speedPremiumUsd",
  "records",
  "unpricedRecords",
  "unpricedTokens",
] as const;

function archiveWindow(input: UsageSummaryInput, readAt: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const hourly = input.resolution === "hour";
  const since = Date.parse(input.sinceTime ?? ""),
    until = Date.parse(input.untilTime ?? "");
  const sources = new Map<string, { source: UsageSource; sessions: Set<string> }>();
  const grouped = new Map<string, { bucket: UsageBucket; sessions: Set<string> }>();
  const add = (chunk: UsageArchiveDay) => {
    const key = sourceKey(chunk.source);
    let source = sources.get(key);
    if (!source) {
      source = { source: chunk.source, sessions: new Set() };
      sources.set(key, source);
    }
    const checkFilter =
      input.modelFilter && JSON.stringify(input.modelFilter) !== JSON.stringify(chunk.modelFilter);
    if (chunk.source.status === "partial") source.source = chunk.source;
    for (const b of chunk.buckets) {
      if (checkFilter && !keepsUsageRecord(input.modelFilter, b)) continue;
      const ms = Date.parse(b.hourStart ?? "");
      if (!Number.isFinite(ms) || (hourly && (ms < since || ms >= until))) continue;
      const day = UsageDay.make(formatter.format(ms));
      if (day < input.sinceDay || day > input.untilDay) continue;
      const hourStart = hourly
        ? iso(since + Math.floor((ms - since) / 3_600_000) * 3_600_000)
        : undefined;
      const id = JSON.stringify([key, day, hourStart, b.model, b.costSource]);
      const { archiveSessions = [], hourStart: _hour, ...base } = b;
      let cell = grouped.get(id);
      if (!cell) {
        cell = {
          bucket: {
            ...base,
            day,
            ...(hourStart ? { hourStart } : {}),
            totals: { ...b.totals },
            ...(b.categoryCostUsd ? { categoryCostUsd: { ...b.categoryCostUsd } } : {}),
          },
          sessions: new Set(),
        };
        grouped.set(id, cell);
      } else {
        const prev = cell.bucket;
        const totals = { ...prev.totals };
        for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += b.totals[k];
        const merged = { ...prev, totals };
        for (const k of numberFields) merged[k] = (prev[k] ?? 0) + (b[k] ?? 0);
        if (b.categoryCostUsd) {
          const category = { ...b.categoryCostUsd };
          for (const k of Object.keys(category) as Array<keyof typeof category>)
            category[k] += prev.categoryCostUsd?.[k] ?? 0;
          merged.categoryCostUsd = category;
        }
        cell.bucket = merged;
      }
      for (const session of archiveSessions) {
        source.sessions.add(session);
        cell.sessions.add(session);
      }
    }
  };
  const finish = (): UsageSummary => ({
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt,
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets: [...grouped.values()].map((c) => ({ ...c.bucket, sessions: c.sessions.size })),
    sources: [...sources.values()].map((s) => ({ ...s.source, distinctSessions: s.sessions.size })),
    pricing: { status: "cached", source: "usage-archive", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  });
  return { add, finish };
}

export function makeUsageArchive(
  sql: SqlClient.SqlClient,
  usage: Pick<UsageService["Service"], "archiveSummary">,
  environment: {
    getEnvironmentId: ServerEnvironment["Service"]["getEnvironmentId"];
    getDescriptor: Effect.Effect<{ environmentId: EnvironmentId; label: string }>;
  },
) {
  const saveDay = Effect.fn("UsageArchive.saveDay")(function* (
    origin: EnvironmentId,
    chunk: UsageArchiveDay,
  ) {
    let entry = chunk;
    if (chunk.source.status === "partial") {
      const [old] = yield* sql<{
        payload: string;
      }>`SELECT payload FROM usage_archive WHERE origin=${origin} AND day=${chunk.day} AND source=${sourceKey(chunk.source)}`;
      if (old) {
        const key = (b: UsageBucket) => JSON.stringify([b.hourStart, b.model, b.costSource]);
        const cells = new Map(decodeDay(old.payload).buckets.map((b) => [key(b), b]));
        for (const b of chunk.buckets) {
          const saved = cells.get(key(b));
          if (!saved || b.records >= saved.records) cells.set(key(b), b);
        }
        entry = { ...chunk, buckets: [...cells.values()] };
      }
    }
    const payload = encodeDay(entry);
    yield* sql`INSERT INTO usage_archive(origin,day,source,read_at,payload)
      VALUES(${origin},${chunk.day},${sourceKey(chunk.source)},${chunk.readAt},${payload})
      ON CONFLICT(origin,day,source) DO UPDATE SET seq=CASE WHEN usage_archive.payload != excluded.payload THEN (SELECT COALESCE(MAX(seq),0)+1 FROM usage_archive) ELSE usage_archive.seq END,
        read_at=excluded.read_at,payload=excluded.payload
      WHERE usage_archive.read_at < excluded.read_at`;
  });
  const status = sql<{
    origin: string;
    label: string;
    read_at: string;
    cursor: number;
    firstDay: string | null;
  }>`SELECT s.*,(SELECT MIN(day) FROM usage_archive a WHERE a.origin=s.origin) AS firstDay FROM usage_archive_sync s ORDER BY origin`.pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        environmentId: EnvironmentId.make(r.origin),
        label: r.label,
        readAt: r.read_at,
        cursor: r.cursor,
        ...(r.firstDay ? { firstDay: UsageDay.make(r.firstDay) } : {}),
      })),
    ),
    Effect.mapError(fail),
  );
  const capture = Effect.fn("UsageArchive.capture")(function* () {
    const { environmentId, label } = yield* environment.getDescriptor;
    const [previous] = yield* sql<{
      read_at: string;
      full_at: string | null;
      retry_at: string | null;
    }>`SELECT read_at,full_at,retry_at FROM usage_archive_sync WHERE origin=${environmentId}`;
    const digest = yield* Digest.Digest;
    const began = iso(yield* Clock.currentTimeMillis);
    const retryPending = previous?.retry_at != null;
    const catchUp = !retryPending || began >= previous.retry_at!;
    const watermark = catchUp ? previous?.full_at : previous?.read_at;
    const sinceDay = watermark
      ? dayAt(Math.max(0, Date.parse(watermark) - DAY))
      : UsageDay.make("1970-01-01");
    const summary = yield* usage.archiveSummary(sinceDay);
    const cells = new Map<string, { source: UsageSource; day: UsageDay; buckets: UsageBucket[] }>();
    const sources = new Map(
      summary.sources
        .filter((s) => (s.status === "ok" || s.status === "partial") && !s.refreshing)
        .map((s) => [JSON.stringify([s.fingerprint.provider, s.fingerprint.resolvedHomePath]), s]),
    );
    const hashes = new Map<string, string>();
    for (const b of summary.buckets) {
      const source = sources.get(pair([b.provider, b.sourcePath ?? ""]));
      if (!source) continue;
      const key = sourceKey(source) + b.day;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          day: b.day,
          source: {
            ...source,
            scannedFiles: 0,
            skippedFiles: 0,
            distinctSessions: 0,
            malformedRecords: 0,
            message: null,
          },
          buckets: [],
        };
        cells.set(key, cell);
      }
      const sessions: string[] = [];
      for (const id of b.archiveSessions ?? []) {
        let hash = hashes.get(id);
        if (!hash) {
          hash = Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(id)));
          hashes.set(id, hash);
        }
        sessions.push(hash);
      }
      cell.buckets.push({ ...b, archiveSessions: sessions });
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const cell of cells.values())
          yield* saveDay(environmentId, {
            ...cell,
            readAt: began,
            ...(summary.modelFilter ? { modelFilter: summary.modelFilter } : {}),
          });
        const complete =
          catchUp &&
          !summary.sources.some(
            (s) => s.refreshing || s.status === "failed" || s.status === "partial",
          );
        const retry = complete
          ? null
          : catchUp
            ? iso(Date.parse(began) + 15 * 60_000)
            : (previous?.retry_at ?? null);
        yield* sql`INSERT INTO usage_archive_sync(origin,label,read_at,full_at,retry_at)
        VALUES(${environmentId},${label},${began},${complete ? began : (previous?.full_at ?? null)},${retry})
        ON CONFLICT(origin) DO UPDATE SET read_at=excluded.read_at,full_at=excluded.full_at,retry_at=excluded.retry_at,label=excluded.label
        WHERE excluded.read_at>=usage_archive_sync.read_at`;
      }),
    );
  }, Effect.mapError(fail));
  const changes = Effect.fn("UsageArchive.changes")(function* (input: {
    cursor: number;
    capture: boolean;
    origin?: EnvironmentId;
  }) {
    const self = yield* environment.getDescriptor;
    const environmentId = input.origin ?? self.environmentId;
    const local = environmentId === self.environmentId;
    if (input.capture && local) yield* capture();
    const [head] = yield* sql<{
      read_at: string;
      label: string;
      cursor: number;
    }>`SELECT read_at,label,cursor FROM usage_archive_sync WHERE origin=${environmentId}`;
    const seq = local ? sql`seq` : sql`json_extract(payload,'$.revision')`;
    const rows = yield* sql<{
      revision: number;
      payload: string;
      read_at: string;
    }>`SELECT ${seq} AS revision,payload,read_at FROM usage_archive WHERE origin=${environmentId} AND ${seq}>${input.cursor} AND ${seq}<=${local ? Number.MAX_SAFE_INTEGER : (head?.cursor ?? 0)} ORDER BY ${seq} LIMIT 13`;
    const page: (typeof rows)[number][] = [];
    let size = 0;
    for (const row of rows) {
      if (page.length >= 12 || (page.length && size + row.payload.length > 512 * 1024)) break;
      page.push(row);
      size += row.payload.length;
    }
    return {
      environmentId,
      label: head?.label ?? self.label,
      readAt: head?.read_at ?? page.at(-1)?.read_at ?? iso(0),
      from: input.cursor,
      cursor: page.at(-1)?.revision ?? input.cursor,
      more: rows.length > page.length,
      days: page.map((row) => ({
        ...decodeDay(row.payload),
        readAt: row.read_at,
        revision: row.revision,
      })),
    };
  }, Effect.mapError(fail));
  const receive = Effect.fn("UsageArchive.receive")(function* (page: UsageArchivePage) {
    if (page.environmentId === (yield* environment.getEnvironmentId) || page.cursor < page.from)
      return yield* fail("Invalid usage archive origin or cursor");
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [prev] = yield* sql<{
          cursor: number;
          read_at: string;
        }>`SELECT cursor,read_at FROM usage_archive_sync WHERE origin=${page.environmentId}`;
        if ((prev?.cursor ?? 0) !== page.from) return prev?.cursor ?? 0;
        for (const cell of page.days) yield* saveDay(page.environmentId, cell);
        yield* sql`INSERT INTO usage_archive_sync(origin,label,read_at,cursor) VALUES(${page.environmentId},${page.label},${page.more ? (prev?.read_at ?? iso(0)) : page.readAt},${page.cursor})
        ON CONFLICT(origin) DO UPDATE SET label=excluded.label,read_at=excluded.read_at,cursor=excluded.cursor`;
        return page.cursor;
      }),
    );
  }, Effect.mapError(fail));
  const read = Effect.fn("UsageArchive.read")(function* (
    input: UsageSummaryInput,
    onlyLocal = false,
  ) {
    const own = yield* environment.getEnvironmentId;
    const since = Date.parse(input.sinceDay + "T00:00:00Z"),
      until = Date.parse(input.untilDay + "T00:00:00Z");
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until)
      return yield* fail("Invalid usage window");
    if (input.resolution === "hour") {
      const start = Date.parse(input.sinceTime ?? ""),
        end = Date.parse(input.untilTime ?? "");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > DAY)
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Expected a valid 24-hour usage window.",
        });
    }
    const entries = (yield* status).filter((entry) => (entry.environmentId === own) === onlyLocal);
    const result: UsageArchiveCopy[] = [];
    for (const entry of entries) {
      const collector = yield* Effect.try({
        try: () => archiveWindow(input, entry.readAt),
        catch: fail,
      });
      let day = "",
        source = "";
      while (true) {
        const rows = yield* sql<{
          day: string;
          source: string;
          payload: string;
          read_at: string;
        }>`SELECT day,source,payload,read_at FROM usage_archive
          WHERE origin=${entry.environmentId} AND day BETWEEN ${dayAt(since - DAY)} AND ${dayAt(until + DAY)}
          AND (day,source)>(${day},${source}) ORDER BY day,source LIMIT 32`;
        for (const row of rows) {
          yield* Effect.try({
            try: () => collector.add({ ...decodeDay(row.payload), readAt: row.read_at }),
            catch: fail,
          });
        }
        if (rows.length < 32) break;
        const last = rows[rows.length - 1]!;
        day = last.day;
        source = last.source;
      }
      result.push({ ...entry, summary: collector.finish() });
    }
    return result;
  }, Effect.mapError(fail));
  const payments = sql<{
    provider_month: string;
    cents: number;
    updated_at: string;
  }>`SELECT * FROM usage_subscription_payments`.pipe(
    Effect.map((rows) =>
      Object.fromEntries(
        rows.map((r) => [r.provider_month, { cents: r.cents, updatedAt: r.updated_at }]),
      ),
    ),
    Effect.mapError(fail),
  );
  const updatePayments = Effect.fn("UsageArchive.updatePayments")(function* (
    patch: Readonly<Record<string, number | null>>,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.forEach(
        Object.entries(patch),
        ([key, cents]) =>
          cents === null
            ? sql`DELETE FROM usage_subscription_payments WHERE provider_month=${key}`
            : sql`INSERT INTO usage_subscription_payments(provider_month,cents,updated_at) VALUES(${key},${cents},${at})
      ON CONFLICT(provider_month) DO UPDATE SET cents=excluded.cents,updated_at=excluded.updated_at`,
        { discard: true },
      ),
    );
  }, Effect.mapError(fail));
  return { status, capture, changes, receive, read, payments, updatePayments };
}
