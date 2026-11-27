// @effect-diagnostics globalDate:off -- Billing windows use native calendar arithmetic alongside the viewer-zone windows in usageFormat.
import {
  UsageDay,
  type EnvironmentId,
  type UsagePayment,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { enumerateDays, enumerateHourStarts, makeWindow } from "./usageFormat.ts";
import {
  ownedUsageCells,
  type EnvironmentUsage,
  type DailyTotals,
  type HourlyTotals,
} from "./usageMerge.ts";

export type PaymentBook = Readonly<Record<string, UsagePayment>>;
const DAY = 86_400_000;
export function validUsageDay(text: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(text + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}
export function moveUsageDay(day: string, delta: number) {
  const time = Date.parse(day + "T00:00:00Z") + delta * DAY;
  if (!Number.isFinite(time) || time < Date.parse("0001-01-01") || time > Date.parse("9999-12-31"))
    return "";
  return new Date(time).toISOString().slice(0, 10);
}
export function usagePeriod(preset: "7" | "30" | "90" | "year", now = new Date()) {
  if (preset !== "year") return makeWindow(Number(preset), now);
  const window = makeWindow(1, now);
  const after = new Date(moveUsageDay(window.untilDay, 1) + "T00:00:00Z");
  after.setUTCFullYear(after.getUTCFullYear() - 1);
  return { ...window, sinceDay: UsageDay.make(after.toISOString().slice(0, 10)) };
}
export function paymentPatch(month: string, values: Readonly<Record<string, string>>) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;
  const patch: Record<string, number | null> = {};
  for (const [provider, draft] of Object.entries(values)) {
    const value = draft.trim().replace(",", ".");
    if (value !== "" && !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
    const [whole = "", fraction = ""] = value.split(".");
    const cents = value === "" ? null : Number(whole + fraction.padEnd(2, "0"));
    if (cents !== null && !Number.isSafeInteger(cents)) return null;
    patch[month + "/" + provider] = cents;
  }
  return patch;
}
export function subscriptionUsage(
  book: PaymentBook,
  window: UsageSummaryInput,
  environments: readonly EnvironmentUsage[],
  selection: ReadonlySet<EnvironmentId> | null,
  hidden: ReadonlySet<UsageProviderKind> = new Set(),
  target?: { provider: UsageProviderKind; model: string },
) {
  const cellMap = new Map<string, ReturnType<typeof ownedUsageCells>>();
  const missing = new Set<string>();
  for (const cell of ownedUsageCells(environments)) {
    if (hidden.has(cell.provider) || (target && target.provider !== cell.provider)) continue;
    const id = cell.day + "/" + cell.provider;
    const group = cellMap.get(id) ?? [];
    group.push(cell);
    cellMap.set(id, group);
    if (
      (!target || target.model === cell.model) &&
      (selection === null || selection.has(cell.environmentId)) &&
      book[cell.day.slice(0, 7) + "/" + cell.provider]?.cents == null
    )
      missing.add(cell.day.slice(0, 7) + "/" + cell.provider);
  }
  const dayCosts = new Map<
    string,
    Map<UsageProviderKind, { costUsd: number; totalTokens: number }>
  >();
  const models = new Map<string, { provider: UsageProviderKind; model: string; costUsd: number }>();
  const providers = new Map<UsageProviderKind, { paid: number; costUsd: number }>();
  const hourly: HourlyTotals[] = [];
  const fractions = new Map<string, number>();
  const hourDays = new Map<string, Map<string, number>>();
  if (window.resolution === "hour" && window.sinceTime && window.untilTime) {
    const localDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: window.timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    // A local service day may have 23 or 25 hours. Cache day lengths over this small rolling window.
    const dayMinutes = new Map<string, number>();
    const begin = Date.parse(window.sinceTime),
      end = Date.parse(window.untilTime);
    for (let t = begin - 26 * 3600000; t < end + 26 * 3600000; t += 60000) {
      const d = localDay.format(t);
      dayMinutes.set(d, (dayMinutes.get(d) ?? 0) + 1);
    }
    for (const hour of enumerateHourStarts(window.sinceTime, window.untilTime)) {
      const parts = new Map<string, number>(),
        at = Date.parse(hour);
      for (let t = at; t < Math.min(at + 3600000, end); t += 60000) {
        const day = localDay.format(t),
          fraction = 1 / dayMinutes.get(day)!;
        parts.set(day, (parts.get(day) ?? 0) + fraction);
        fractions.set(day, (fractions.get(day) ?? 0) + fraction);
      }
      hourDays.set(hour, parts);
    }
  }
  let unassigned = 0,
    paid = 0,
    costUsd = 0;
  for (const [key, entry] of Object.entries(book)) {
    const [month, providerName] = key.split("/");
    const provider = providerName as UsageProviderKind;
    if (
      entry.cents === null ||
      !month ||
      hidden.has(provider) ||
      (target && target.provider !== provider) ||
      month < window.sinceDay.slice(0, 7) ||
      month > window.untilDay.slice(0, 7)
    )
      continue;
    const end = new Date(month + "-01T00:00:00Z");
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    const last = end.toISOString().slice(0, 10),
      dailyRate = entry.cents / 100 / end.getUTCDate();
    const p = providers.get(provider) ?? { paid: 0, costUsd: 0 };
    providers.set(provider, p);
    p.paid += entry.cents / 100;
    paid += entry.cents / 100;
    for (const day of enumerateDays(
      month + "-01" > window.sinceDay ? month + "-01" : window.sinceDay,
      last < window.untilDay ? last : window.untilDay,
    )) {
      const cells = cellMap.get(day + "/" + provider) ?? [],
        tokens = cells.reduce((n, c) => n + c.tokens, 0);
      const fraction = window.resolution === "hour" ? (fractions.get(day) ?? 0) : 1;
      let weight = 0;
      for (const cell of cells) {
        if (
          !tokens ||
          (target && target.model !== cell.model) ||
          (selection !== null && !selection.has(cell.environmentId))
        )
          continue;
        const share = cell.tokens / tokens;
        weight += share;
        const key = provider + "/" + cell.model;
        const model = models.get(key) ?? { provider, model: cell.model, costUsd: 0 };
        model.costUsd += dailyRate * share * fraction;
        models.set(key, model);
      }
      if (!tokens && selection === null && !target) {
        weight = 1;
        unassigned += dailyRate * fraction;
      }
      const daily = dayCosts.get(day) ?? new Map();
      dayCosts.set(day, daily);
      daily.set(provider, { costUsd: dailyRate * weight, totalTokens: 0 });
      p.costUsd += dailyRate * weight * fraction;
      costUsd += dailyRate * weight * fraction;
    }
  }
  const daily: DailyTotals[] = [...dayCosts].map(([day, byProvider]) => ({
    day,
    byProvider,
    totalTokens: 0,
    costUsd: [...byProvider.values()].reduce((n, p) => n + p.costUsd, 0),
  }));
  for (const [hourStart, parts] of hourDays) {
    const byProvider = new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>();
    for (const [day, fraction] of parts)
      for (const [p, v] of dayCosts.get(day) ?? []) {
        byProvider.set(p, {
          costUsd: (byProvider.get(p)?.costUsd ?? 0) + v.costUsd * fraction,
          totalTokens: 0,
        });
      }
    hourly.push({
      day: parts.keys().next().value ?? "",
      hourStart,
      byProvider,
      totalTokens: 0,
      costUsd: [...byProvider.values()].reduce((n, p) => n + p.costUsd, 0),
    });
  }
  return {
    daily,
    hourly,
    providers,
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
    paid,
    costUsd,
    unassigned,
    missing,
  };
}
