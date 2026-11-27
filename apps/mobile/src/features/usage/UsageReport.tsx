import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { useAtomValue } from "@effect/atom-react";
import { useGT, useLocale } from "gt-react-native";
import {
  UsageDay,
  type UsageSummaryInput,
  type UsageProviderKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  formatTokens,
  formatUsd,
  formatPercent,
  enumerateDays,
  enumerateHourStarts,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { usagePieSlices, type DailyTotals } from "@t3tools/shared/usageMerge";
import {
  usagePeriod,
  moveUsageDay,
  validUsageDay,
  subscriptionUsage,
  paymentPatch,
} from "@t3tools/shared/usagePayments";
import { AppText as Text } from "../../components/ui/AppText";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { usagePayments } from "../../state/UsageArchiveCoordinator";
import { PROVIDER_ORDER, PROVIDER_LABEL, useProviderColors } from "./usageProviders";
import { UsageDailyChart } from "./UsageDailyChart";
import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { AsyncResult, Atom } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";
import { environmentPresentations } from "../../state/presentation";

export function CumulativeChart({
  days,
  daily,
  metric,
  height,
}: {
  days: readonly string[];
  daily: readonly DailyTotals[];
  metric: UsageChartMetric;
  height: number;
}) {
  const colors = useProviderColors(),
    data = buildChartDays(days, daily, metric);
  const peak = data.reduce((n, d) => n + d.total, 0);
  if (!peak) return null;
  const base = days.map(() => 0);
  return (
    <Svg width="100%" height={height} viewBox={"0 0 300 " + height} preserveAspectRatio="none">
      {PROVIDER_ORDER.map((provider, p) => {
        let running = 0;
        const point = (i: number, v: number) =>
          `${(300 * i) / Math.max(1, days.length - 1)},${height * (1 - v / peak)}`;
        const bottom = base.map((v, i) => point(i, v)).reverse();
        const top = data.map((d, i) => {
          running += d.values[p]?.value ?? 0;
          base[i] = (base[i] ?? 0) + running;
          return point(i, base[i]!);
        });
        return (
          <Path
            key={provider}
            d={"M" + top.join(" L") + " L" + bottom.join(" L") + " Z"}
            fill={colors[provider]}
            fillOpacity={0.7}
            stroke={colors[provider]}
            strokeWidth={1}
          />
        );
      })}
    </Svg>
  );
}
export function Action({
  label,
  press,
  disabled = false,
}: {
  label: string;
  press: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={press}
      className="self-start rounded-lg bg-grouped-card px-3 py-2"
    >
      <Text className={disabled ? "text-foreground-muted" : "text-foreground"}>{label}</Text>
    </Pressable>
  );
}
export function Field({
  label,
  value,
  change,
  numeric = false,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  numeric?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={change}
        keyboardType={numeric ? "decimal-pad" : "default"}
        className="rounded-lg border border-border px-3 py-2 text-foreground"
      />
    </View>
  );
}
function PaymentEditor({ month: initial, close }: { month: string; close: () => void }) {
  const gt = useGT(),
    { book, id, label } = useAtomValue(usagePayments.state),
    [destination] = useState(id),
    [month, setMonth] = useState(initial),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const save = async () => {
    const patch: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(draft)) {
      const [m, p] = key.split("/");
      if (!m || !p) return;
      const changes = paymentPatch(m, { [p]: value });
      if (!changes) {
        setError(true);
        return;
      }
      Object.assign(patch, changes);
    }
    setBusy(true);
    const saved = destination
      ? await usagePayments.save(destination, patch).catch(() => false)
      : false;
    setBusy(false);
    if (saved) close();
    else setError(true);
  };
  return (
    <View className="gap-3">
      <Text className="text-lg font-t3-semibold text-foreground">
        {gt("Monthly payments")} · {label ?? destination}
      </Text>
      <Text>{gt("Enter amounts in USD. Empty means unknown. Zero means a free month.")}</Text>
      <Field label={gt("Payment month (YYYY-MM)")} value={month} change={setMonth} />
      {/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) &&
        PROVIDER_ORDER.map((p) => {
          const key = month + "/" + p,
            cents = book[key]?.cents;
          return (
            <Field
              key={p}
              label={PROVIDER_LABEL[p]}
              numeric
              value={draft[key] ?? (cents == null ? "" : (cents / 100).toFixed(2))}
              change={(v) => setDraft({ ...draft, [key]: v })}
            />
          );
        })}
      {error && <Text>{gt("Check the amounts and connection, then try again.")}</Text>}
      <View className="flex-row gap-2">
        <Action
          label={gt("Save payments")}
          press={() => void save()}
          disabled={busy || !Object.keys(draft).length}
        />
        <Action label={gt("Cancel")} press={close} disabled={busy} />
      </View>
    </View>
  );
}
type Share = { provider: UsageProviderKind; value: number };
function Shares({
  title,
  rows,
  format,
}: {
  title: string;
  rows: readonly Share[];
  format: (n: number) => string;
}) {
  const colors = useProviderColors(),
    total = rows.reduce((n, r) => n + r.value, 0),
    circ = 2 * Math.PI * 54;
  return (
    <View className="gap-2 rounded-2xl bg-grouped-card p-4">
      <Text className="font-t3-semibold text-foreground">{title}</Text>
      <View className="items-center">
        <Svg width={138} height={138} viewBox="0 0 140 140">
          {usagePieSlices(rows, total).map(({ row: r, start: offset, fraction }) => {
            const length = circ * fraction,
              start = circ * offset;
            return (
              <Circle
                key={r.provider}
                cx={70}
                cy={70}
                r={54}
                fill="none"
                stroke={colors[r.provider]}
                strokeWidth={20}
                strokeDasharray={[length, circ - length]}
                strokeDashoffset={-start}
                transform="rotate(-90 70 70)"
              />
            );
          })}
        </Svg>
        <Text className="font-t3-semibold text-foreground">{format(total)}</Text>
      </View>
      {rows.map((r) => (
        <View key={r.provider} className="flex-row items-center gap-2">
          <View style={{ backgroundColor: colors[r.provider] }} className="size-2 rounded-full" />
          <Text className="flex-1 text-foreground">{PROVIDER_LABEL[r.provider]}</Text>
          <Text>
            {format(r.value)} · {formatPercent(total ? r.value / total : 0)}
          </Text>
        </View>
      ))}
    </View>
  );
}
const receipts = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].flatMap(([id, p]) =>
    p.connection.phase === "connected" && p.serverConfig?.environment.capabilities.usageArchive
      ? AsyncResult.getOrElse(
          get(serverEnvironment.archiveReceipts({ environmentId: id, input: {} })),
          () => [],
        )
          .filter((c) => c.environmentId !== id)
          .map((c) => ({ ...c, destination: p.entry.target.label }))
      : [],
  ),
);
export function MobileUsageSync({
  environments,
}: {
  environments: readonly EnvironmentUsageStatus[];
}) {
  const gt = useGT(),
    locale = useLocale(),
    copies = useAtomValue(receipts);
  return (
    <View className="gap-3">
      <Text className="text-lg text-foreground">{gt("Usage synchronization")}</Text>
      {environments.map((e) => (
        <View key={e.environmentId}>
          <Text>
            {e.label} · {e.isConnected ? gt("Online") : gt("Offline")}
          </Text>
          {copies
            .filter((c) => c.environmentId === e.environmentId)
            .map((c) => (
              <Text key={c.destination}>
                {c.destination} · {new Date(c.readAt).toLocaleString(locale)}
              </Text>
            ))}
        </View>
      ))}
    </View>
  );
}
export function MobileUsageReport({
  report,
  window: summary,
  selection,
}: {
  report: boolean;
  window: UsageSummaryInput;
  selection: ReadonlySet<EnvironmentId> | null;
}) {
  const gt = useGT(),
    locale = useLocale(),
    [w, setWindow] = useState(() => usagePeriod("year")),
    [preset, setPreset] = useState("year"),
    [from, setFrom] = useState<string>(w.sinceDay),
    [to, setTo] = useState<string>(w.untilDay),
    [basis, setBasis] = useState<"api" | "subscription">("api"),
    [edit, setEdit] = useState(false),
    [mode, setMode] = useState<"interval" | "cumulative">("cumulative");
  const selected = report ? w : summary,
    sub = !report || basis === "subscription",
    { book, writers, id, targets, label } = useAtomValue(usagePayments.state);
  const dailyWindow: UsageSummaryInput = {
    savedHistory: true,
    sinceDay: selected.sinceDay,
    untilDay: selected.untilDay,
    timeZone: selected.timeZone,
  };
  const data = useUsage(dailyWindow, selection),
    money = (v: number) => formatUsd(v, locale);
  const bill = subscriptionUsage(
    book,
    selected,
    data.environments.flatMap((e) =>
      e.summary ? [{ environmentId: e.environmentId, label: e.label, summary: e.summary }] : [],
    ),
    selection,
  );
  const isHourly = selected.resolution === "hour",
    days = isHourly
      ? enumerateHourStarts(selected.sinceTime!, selected.untilTime!)
      : enumerateDays(selected.sinceDay, selected.untilDay),
    daily = isHourly ? bill.hourly.map((r) => ({ ...r, day: r.hourStart })) : bill.daily;
  const valid =
    validUsageDay(from) && validUsageDay(to) && from <= to && to <= makeWindow(1).untilDay;
  if (edit)
    return <PaymentEditor month={selected.untilDay.slice(0, 7)} close={() => setEdit(false)} />;
  return (
    <View className="gap-4">
      {report && (
        <>
          <SegmentedControl
            options={[
              { value: "api", label: gt("API cost") },
              { value: "subscription", label: gt("Subscription") },
            ]}
            selected={basis}
            onSelect={setBasis}
          />
          <View className="flex-row flex-wrap gap-1">
            {(
              [
                ["7", gt("7 days")],
                ["30", gt("30 days")],
                ["90", gt("90 days")],
                ["year", gt("Last year")],
                ["custom", gt("Custom")],
              ] as const
            ).map(([v, label]) => (
              <Action
                key={v}
                label={label}
                disabled={preset === v}
                press={() => {
                  setPreset(v);
                  if (v !== "custom") {
                    const r = usagePeriod(v);
                    setWindow(r);
                    setFrom(r.sinceDay);
                    setTo(r.untilDay);
                  }
                }}
              />
            ))}
          </View>
          {preset === "custom" && (
            <>
              <Field
                label={gt("Number of days")}
                numeric
                value={valid ? String((Date.parse(to) - Date.parse(from)) / 86400000 + 1) : ""}
                change={(v) =>
                  setFrom(/^\d+$/.test(v) && Number(v) > 0 ? moveUsageDay(to, 1 - Number(v)) : "")
                }
              />
              <Field label={gt("From (YYYY-MM-DD)")} value={from} change={setFrom} />
              <Field label={gt("Until (YYYY-MM-DD)")} value={to} change={setTo} />
              <Action
                label={gt("Apply")}
                disabled={!valid}
                press={() =>
                  setWindow({ ...w, sinceDay: UsageDay.make(from), untilDay: UsageDay.make(to) })
                }
              />
              <Action
                label={gt("All history")}
                press={() => {
                  const r = { ...makeWindow(1), sinceDay: UsageDay.make("1970-01-01") };
                  setWindow(r);
                  setFrom(r.sinceDay);
                  setTo(r.untilDay);
                }}
              />
            </>
          )}
        </>
      )}
      <Text>
        {selected.sinceDay} – {selected.untilDay}
      </Text>
      {sub && (
        <>
          <Text>
            {gt("Payment environment")} · {label ?? gt("Select an environment")}
          </Text>
          {targets.length > 1 && (
            <View className="flex-row flex-wrap gap-2">
              {targets.map((t) => (
                <Action
                  key={t.id}
                  label={t.label}
                  disabled={t.id === id}
                  press={() => usagePayments.select(t.id)}
                />
              ))}
            </View>
          )}
          <Action
            label={gt("Monthly payments")}
            disabled={!writers.length}
            press={() => setEdit(true)}
          />
          <Text>
            {gt("Full payments for the included months")} ·{" "}
            {bill.providers.size ? money(bill.paid) : gt("Not entered")}
          </Text>
          <Text>
            {gt("Subscription cost for the period")} ·{" "}
            {bill.providers.size ? money(bill.costUsd) : gt("Not entered")}
          </Text>
          <Text>{gt("Monthly payments are prorated by calendar day.")}</Text>
          {bill.missing.size > 0 && (
            <Text>
              {gt("Missing monthly payments")} · {[...bill.missing].join(", ")}
            </Text>
          )}
        </>
      )}
      {!data.environments.some((e) => e.canReadDiagnostics) ? (
        <Text>{gt("Connect an environment to see usage.")}</Text>
      ) : data.isPending ? (
        <Text>{gt("Scanning provider transcripts…")}</Text>
      ) : report ? (
        <>
          <Shares
            title={gt("Tokens by provider")}
            rows={data.merged.providers.map((p) => ({
              provider: p.provider,
              value: p.totalTokens,
            }))}
            format={formatTokens}
          />
          {!sub || bill.providers.size ? (
            <Shares
              title={sub ? gt("Subscription by provider") : gt("API cost by provider")}
              rows={
                sub
                  ? [...bill.providers].map(([provider, p]) => ({ provider, value: p.costUsd }))
                  : data.merged.providers.map((p) => ({ provider: p.provider, value: p.costUsd }))
              }
              format={money}
            />
          ) : (
            <Text>{gt("No payments entered for this period.")}</Text>
          )}
          {sub &&
            [...bill.providers].map(([provider, amount]) => (
              <View key={provider} className="gap-1">
                <Text className="font-t3-semibold text-foreground">{PROVIDER_LABEL[provider]}</Text>
                <Text>
                  {gt("Full payments for the included months")} · {money(amount.paid)}
                </Text>
                <Text>
                  {gt("Subscription cost for the period")} · {money(amount.costUsd)}
                </Text>
              </View>
            ))}
        </>
      ) : (
        <>
          <SegmentedControl
            selected={mode}
            onSelect={setMode}
            options={[
              { value: "interval", label: isHourly ? gt("Hourly") : gt("Daily") },
              { value: "cumulative", label: gt("Cumulative") },
            ]}
          />
          {mode === "cumulative" ? (
            <CumulativeChart days={days} daily={daily} metric="cost" height={180} />
          ) : (
            <UsageDailyChart days={days} daily={daily} metric="cost" height={180} />
          )}
          <Text>{gt("Subscription by model")}</Text>
          {bill.models.map((m) => (
            <Text key={m.provider + "/" + m.model}>
              {m.model} · {money(m.costUsd)}
            </Text>
          ))}
          {bill.unassigned > 0 && (
            <Text>
              {gt("No attributable usage")} · {money(bill.unassigned)}
            </Text>
          )}
        </>
      )}
    </View>
  );
}
