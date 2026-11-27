// @effect-diagnostics globalDate:off -- This fixture anchors a calendar year across leap day.
import { describe, expect, it } from "vite-plus/test";
import {
  UsageDay,
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
} from "@t3tools/contracts";
import { paymentPatch, subscriptionUsage, usagePeriod } from "./usagePayments.ts";
const day = UsageDay.make("2026-11-21"),
  provider = "codex",
  first = EnvironmentId.make("a"),
  second = EnvironmentId.make("b");
const sample = (id: typeof first, tokens: number) => ({
  environmentId: id,
  label: id,
  summary: {
    sinceDay: day,
    untilDay: day,
    timeZone: "UTC",
    readAt: "2026-11-28T00:00:00Z",
    contractVersion: USAGE_CONTRACT_VERSION,
    scanDurationMs: 0,
    pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
    sources: [
      {
        fingerprint: { hostId: id, resolvedHomePath: id, volumeId: id, provider },
        status: "ok",
        distinctSessions: 1,
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        message: null,
      },
    ],
    buckets: [
      {
        day,
        provider,
        model: "m",
        sourcePath: id,
        totals: {
          uncachedInputTokens: tokens,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
        },
        costSource: "modelPriced",
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
  } satisfies UsageSummary,
});
describe("monthly payments", () => {
  it("allocates a single monthly payment across machines and keeps days without activity", () => {
    const sources = [sample(first, 30), sample(second, 70)];
    const book = { "2026-11/codex": { cents: 3000, updatedAt: "2026-11-01T00:00:00.000Z" } };
    const w = { sinceDay: day, untilDay: UsageDay.make("2026-11-27"), timeZone: "UTC" };
    const all = subscriptionUsage(book, w, sources, null);
    expect(all.paid).toBe(30);
    expect(all.costUsd).toBe(7);
    expect(all.unassigned).toBe(6);
    expect(subscriptionUsage(book, w, sources, new Set([first])).costUsd).toBeCloseTo(0.3);
    expect(subscriptionUsage(book, w, sources, new Set([second])).costUsd).toBeCloseTo(0.7);
  });
  it("distinguishes zero and deletion and rejects subcent input", () => {
    const earlier = paymentPatch("2026-11", { codex: "0" })!,
      later = paymentPatch("2026-11", { codex: "" })!;
    expect(earlier["2026-11/codex"]).toBe(0);
    expect(later["2026-11/codex"]).toBeNull();
    expect(paymentPatch("2026-11", { codex: "12,34" })?.["2026-11/codex"]).toBe(1234);
    expect(paymentPatch("2026-11", { codex: "5.001" })).toBeNull();
  });
  it("uses each month's own rate when a period crosses a month boundary", () => {
    const book = {
      "2026-10/codex": { cents: 3100, updatedAt: "2026-10-01T00:00:00.000Z" },
      "2026-11/codex": { cents: 6000, updatedAt: "2026-11-01T00:00:00.000Z" },
    };
    const result = subscriptionUsage(
      book,
      {
        sinceDay: UsageDay.make("2026-10-30"),
        untilDay: UsageDay.make("2026-11-02"),
        timeZone: "UTC",
      },
      [],
      null,
    );
    expect(result.paid).toBe(91);
    expect(result.costUsd).toBe(6);
  });
  it("charges exactly one calendar day across the spring DST transition", () => {
    const result = subscriptionUsage(
      { "2026-03/codex": { cents: 3100, updatedAt: "2026-03-01T00:00:00.000Z" } },
      {
        sinceDay: UsageDay.make("2026-03-08"),
        untilDay: UsageDay.make("2026-03-09"),
        timeZone: "America/New_York",
        resolution: "hour",
        sinceTime: "2026-03-08T05:00:00Z",
        untilTime: "2026-03-09T04:00:00Z",
      },
      [],
      null,
    );
    expect(result.hourly).toHaveLength(23);
    expect(result.costUsd).toBeCloseTo(1);
    expect(result.hourly.reduce((sum, h) => sum + h.costUsd, 0)).toBeCloseTo(1);
  });
  it("uses a rolling calendar year through leap day", () => {
    const w = usagePeriod("year", new Date("2024-03-12T12:00:00Z"));
    expect(w.sinceDay).toBe("2023-03-13");
  });
});
