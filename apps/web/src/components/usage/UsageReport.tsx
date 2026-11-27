import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT, useLocale } from "gt-react";
import {
  UsageDay,
  EnvironmentId,
  type UsageSummaryInput,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  enumerateDays,
  enumerateHourStarts,
  formatUsd,
  formatTokens,
  formatPercent,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import {
  moveUsageDay,
  validUsageDay,
  usagePeriod,
  subscriptionUsage,
  paymentPatch,
} from "@t3tools/shared/usagePayments";
import { usagePieSlices, type MergedUsage } from "@t3tools/shared/usageMerge";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { usagePayments } from "../../state/UsageArchiveCoordinator";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { UsageProviderChart } from "./UsageProviderChart";

function Payments({ month: initialMonth, close }: { month: string; close: () => void }) {
  const gt = useGT(),
    { book, writers, id, label } = useAtomValue(usagePayments.state);
  const [destination] = useState(id);
  const [month, setMonth] = useState(initialMonth),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    const patch: Record<string, NonNullable<ReturnType<typeof paymentPatch>>[string]> = {};
    for (const [key, value] of Object.entries(draft)) {
      const [m, p] = key.split("/");
      if (!m || !p) return;
      const change = paymentPatch(m, { [p]: value });
      if (!change) {
        setError(gt("Enter a nonnegative USD amount with up to two decimal places."));
        return;
      }
      Object.assign(patch, change);
    }
    setBusy(true);
    const saved = destination
      ? await usagePayments.save(destination, patch).catch(() => false)
      : false;
    setBusy(false);
    if (saved) close();
    else setError(gt("Some payments could not be saved. Reconnect and try again."));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {gt("Monthly payments")} · {label ?? destination}
          </DialogTitle>
          <DialogDescription>
            {gt(
              "Enter the total paid in USD for each provider. Leave it empty for an unknown payment or enter zero for a free month.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex items-center justify-between gap-4">
            {gt("Payment month")}
            <Input
              nativeInput
              type="month"
              value={month}
              disabled={busy}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          {PROVIDER_ORDER.map((p) => {
            const key = month + "/" + p,
              cents = book[key]?.cents;
            return (
              <label key={p} className="grid grid-cols-2 items-center gap-4 border-b py-2">
                <span>{PROVIDER_PRESENTATION[p].label}</span>
                <Input
                  nativeInput
                  inputMode="decimal"
                  disabled={!month || busy}
                  placeholder={gt("Not entered")}
                  value={draft[key] ?? (cents == null ? "" : (cents / 100).toFixed(2))}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            );
          })}
          {error && <p role="alert">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {gt("Cancel")}
          </Button>
          <Button
            disabled={busy || destination !== id || !writers.length || !Object.keys(draft).length}
            onClick={() => void save()}
          >
            {gt("Save payments")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RangeControls({
  window,
  change,
  first,
}: {
  window: UsageSummaryInput;
  change: (w: UsageSummaryInput) => void;
  first: string;
}) {
  const gt = useGT(),
    [preset, setPreset] = useState<string>(
      () =>
        (["7", "30", "90", "year"] as const).find((v) => {
          const range = usagePeriod(v);
          return range.sinceDay === window.sinceDay && range.untilDay === window.untilDay;
        }) ?? "custom",
    ),
    [from, setFrom] = useState<string>(window.sinceDay),
    [to, setTo] = useState<string>(window.untilDay);
  const labels = {
    "7": gt("7 days"),
    "30": gt("30 days"),
    "90": gt("90 days"),
    year: gt("Last year"),
    custom: gt("Custom"),
  };
  const valid =
    validUsageDay(from) && validUsageDay(to) && from <= to && to <= makeWindow(1).untilDay;
  const days = valid ? (Date.parse(to) - Date.parse(from)) / 86400000 + 1 : "";
  const apply = (a: string, b: string) =>
    change({ ...makeWindow(1), sinceDay: UsageDay.make(a), untilDay: UsageDay.make(b) });
  return (
    <div className="flex flex-col items-start gap-3">
      <ToggleGroup
        variant="segmented"
        aria-label={gt("Report period")}
        value={[preset]}
        onValueChange={([v]) => {
          if (!v) return;
          setPreset(v);
          if (v === "7" || v === "30" || v === "90" || v === "year") {
            const w = usagePeriod(v);
            change(w);
            setFrom(w.sinceDay);
            setTo(w.untilDay);
          }
        }}
      >
        {Object.entries(labels).map(([v, label]) => (
          <Toggle key={v} value={v}>
            {label}
          </Toggle>
        ))}
      </ToggleGroup>
      {preset === "custom" && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) apply(from, to);
          }}
        >
          <label>
            {gt("Number of days")}
            <Input
              nativeInput
              type="number"
              min="1"
              value={days}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                setFrom(Number.isInteger(n) && n > 0 ? moveUsageDay(to, 1 - n) : "");
              }}
            />
          </label>
          <label>
            {gt("From")}
            <Input nativeInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            {gt("Until")}
            <Input nativeInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button type="submit" disabled={!valid}>
            {gt("Apply")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const last = makeWindow(1).untilDay;
              setFrom(first);
              setTo(last);
              apply(first, last);
            }}
          >
            {gt("All history")}
          </Button>
        </form>
      )}
    </div>
  );
}

type Share = { provider: UsageProviderKind; value: number };
function Donut({
  title,
  rows,
  format,
}: {
  title: string;
  rows: readonly Share[];
  format: (v: number) => string;
}) {
  const gt = useGT(),
    [selected, setSelected] = useState<UsageProviderKind | null>(null);
  const total = rows.reduce((a, r) => a + r.value, 0),
    active = rows.find((r) => r.provider === selected);
  return (
    <section className="rounded-xl border p-4">
      <h3 className="font-medium">{title}</h3>
      <div className="relative mx-auto my-3 size-40 max-w-full">
        <svg className="size-full" viewBox="0 0 160 160" role="img" aria-label={title}>
          <circle cx="80" cy="80" r="62" fill="none" stroke="var(--border)" strokeWidth="24" />
          {usagePieSlices(rows, total).map(({ row: r, start, fraction }) => {
            const portion = 100 * fraction,
              begin = start * 100;
            return (
              <circle
                key={r.provider}
                cx="80"
                cy="80"
                r="62"
                transform="rotate(-90 80 80)"
                fill="none"
                pathLength="100"
                stroke={PROVIDER_PRESENTATION[r.provider].color}
                strokeWidth="24"
                strokeDasharray={`${portion} ${100 - portion}`}
                strokeDashoffset={-begin}
                opacity={!active || active.provider === r.provider ? 1 : 0.35}
              >
                <title>
                  {PROVIDER_PRESENTATION[r.provider].label} · {format(r.value)}
                </title>
              </circle>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <b>{format(active?.value ?? total)}</b>
          <small>{active ? PROVIDER_PRESENTATION[active.provider].label : gt("Total")}</small>
        </div>
      </div>
      {rows.map((r) => (
        <button
          type="button"
          className="flex w-full items-center gap-2 py-1 text-sm"
          key={r.provider}
          aria-pressed={active?.provider === r.provider}
          onClick={() => setSelected(active?.provider === r.provider ? null : r.provider)}
        >
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: PROVIDER_PRESENTATION[r.provider].color }}
          />
          {PROVIDER_PRESENTATION[r.provider].label}
          <span className="ms-auto">{formatPercent(total ? r.value / total : 0)}</span>
        </button>
      ))}
    </section>
  );
}

const receiptsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].flatMap(([id, p]) => {
    if (
      p.connection.phase !== "connected" ||
      !p.serverConfig?.environment.capabilities.usageArchive
    )
      return [];
    return AsyncResult.getOrElse(
      get(serverEnvironment.archiveReceipts({ environmentId: id, input: {} })),
      () => [],
    ).map((r) => ({ ...r, destinationId: id, destination: p.entry.target.label }));
  }),
);
export function UsageSyncStatus({
  environments,
}: {
  environments: readonly EnvironmentUsageStatus[];
}) {
  const gt = useGT(),
    locale = useLocale(),
    receipts = useAtomValue(receiptsAtom);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{gt("Usage synchronization")}</h2>
      <p className="text-sm text-muted-foreground">
        {gt(
          "Connected environments save usage after a turn ends. Saved copies are available when the source is offline.",
        )}
      </p>
      {environments.map((env) => (
        <div className="border-b py-2" key={env.environmentId}>
          <div className="flex justify-between gap-4">
            <b>{env.label}</b>
            <span>{env.isConnected ? gt("Online") : gt("Offline")}</span>
          </div>
          {receipts
            .filter(
              (r) => r.environmentId === env.environmentId && r.destinationId !== env.environmentId,
            )
            .map((r) => (
              <p className="text-xs text-muted-foreground" key={r.destination}>
                {gt("Saved on {environment} · {date}", {
                  environment: r.destination,
                  date: new Date(r.readAt).toLocaleString(locale),
                })}
              </p>
            ))}
        </div>
      ))}
    </section>
  );
}

interface ReportProps {
  report: boolean;
  window: UsageSummaryInput;
  setWindow: (w: UsageSummaryInput) => void;
  environments: readonly EnvironmentUsageStatus[];
  selection: ReadonlySet<EnvironmentId> | null;
  hidden: ReadonlySet<UsageProviderKind>;
  merged: MergedUsage;
  ready: boolean;
  hour12: boolean;
}
export function UsageReport(props: ReportProps) {
  const gt = useGT(),
    locale = useLocale(),
    [basis, setBasis] = useState<"api" | "subscription">(props.report ? "api" : "subscription"),
    [editing, setEditing] = useState(false);
  const { book, writers, id, targets } = useAtomValue(usagePayments.state);
  const hourly = props.window.resolution === "hour";
  return (
    <UsageReportBody
      {...props}
      basis={basis}
      setBasis={setBasis}
      payments={
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground">
            {gt("Payment environment")}{" "}
            <select
              aria-label={gt("Payment environment")}
              value={id ?? ""}
              onChange={(e) => usagePayments.select(EnvironmentId.make(e.target.value))}
            >
              {!id && <option value="">{gt("Select an environment")}</option>}
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!writers.length}
            onClick={() => setEditing(true)}
          >
            {gt("Monthly payments")}
          </Button>
        </div>
      }
      book={book}
      dailySource={hourly ? <HourlySubscription {...props} book={book} /> : null}
      money={(n) => formatUsd(n, locale)}
    >
      {editing && (
        <Payments month={props.window.untilDay.slice(0, 7)} close={() => setEditing(false)} />
      )}
    </UsageReportBody>
  );
}
type Book = import("@t3tools/shared/usagePayments").PaymentBook;
function HourlySubscription(props: ReportProps & { book: Book }) {
  const dayWindow: UsageSummaryInput = {
    savedHistory: true,
    sinceDay: props.window.sinceDay,
    untilDay: props.window.untilDay,
    timeZone: props.window.timeZone,
  };
  const full = useUsage(dayWindow);
  return (
    full.shown && (
      <SubscriptionPanel {...props} environments={full.environments} book={props.book} />
    )
  );
}
function SubscriptionPanel(props: ReportProps & { book: Book }) {
  const gt = useGT(),
    locale = useLocale(),
    money = (v: number) => formatUsd(v, locale);
  const [focus, setFocus] = useState<{ provider: UsageProviderKind; model: string } | null>(null);
  const sources = props.environments.flatMap((e) =>
    e.summary ? [{ environmentId: e.environmentId, label: e.label, summary: e.summary }] : [],
  );
  const bill = subscriptionUsage(props.book, props.window, sources, props.selection, props.hidden);
  const lookup = new Map(props.merged.providers.map((p) => [p.provider, p]));
  const providers = PROVIDER_ORDER.filter(
    (p) => !props.hidden.has(p) && (lookup.has(p) || bill.providers.has(p)),
  );
  const rows = providers.flatMap((p) =>
    bill.providers.has(p) ? [{ provider: p, value: bill.providers.get(p)!.costUsd }] : [],
  );
  const hourly = props.window.resolution === "hour";
  const range = props.window;
  const detail = focus
    ? subscriptionUsage(props.book, range, sources, props.selection, props.hidden, focus)
    : null;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <small>{gt("Full payments for the included months")}</small>
          <p className="text-2xl font-semibold">
            {bill.providers.size ? money(bill.paid) : gt("Not entered")}
          </p>
        </div>
        <div>
          <small>{gt("Subscription cost for the period")}</small>
          <p className="text-2xl font-semibold">
            {bill.providers.size ? money(bill.costUsd) : gt("Not entered")}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {gt(
          "Monthly payments are prorated by calendar day. Each day is allocated to models and environments by their share of the provider’s tokens.",
        )}
      </p>
      {bill.missing.size > 0 && (
        <p role="status">
          {gt("Partial cost. Missing monthly payments: {payments}", {
            payments: [...bill.missing].join(", "),
          })}
        </p>
      )}
      {props.report ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Donut
              title={gt("Tokens by provider")}
              rows={providers.map((p) => ({ provider: p, value: lookup.get(p)?.totalTokens ?? 0 }))}
              format={formatTokens}
            />
            {rows.length ? (
              <Donut title={gt("Subscription by provider")} rows={rows} format={money} />
            ) : (
              <p>{gt("No payments entered for this period.")}</p>
            )}
          </div>
          <table className="w-full text-start text-sm">
            <thead>
              <tr>
                <th>{gt("Provider")}</th>
                <th>{gt("Tokens")}</th>
                <th>{gt("Full payments")}</th>
                <th>{gt("Period cost")}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p}>
                  <td>{PROVIDER_PRESENTATION[p].label}</td>
                  <td>{formatTokens(lookup.get(p)?.totalTokens ?? 0)}</td>
                  <td>{bill.providers.has(p) ? money(bill.providers.get(p)!.paid) : "-"}</td>
                  <td>{bill.providers.has(p) ? money(bill.providers.get(p)!.costUsd) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <>
          {bill.providers.size > 0 && (
            <UsageProviderChart
              providers={[...bill.providers.keys()]}
              days={enumerateDays(range.sinceDay, range.untilDay)}
              daily={bill.daily}
              hours={hourly ? enumerateHourStarts(range.sinceTime!, range.untilTime!) : []}
              hourly={bill.hourly}
              metric="cost"
              referenceTime={range.untilTime}
              resolution={hourly ? "hour" : "day"}
              timeZone={range.timeZone}
              hour12={props.hour12}
            />
          )}
          <h3>{gt("Subscription by model")}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>{gt("Model")}</th>
                <th>{gt("Tokens")}</th>
                <th>{gt("Attributed cost")}</th>
                <th>{gt("Per 1M tokens")}</th>
              </tr>
            </thead>
            <tbody>
              {props.merged.models.map((m) => {
                const row = bill.models.find(
                  (r) => r.provider === m.provider && r.model === m.model,
                );
                return (
                  <tr key={m.provider + "/" + m.model}>
                    <td>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setFocus({ provider: m.provider, model: m.model })}
                      >
                        {m.model}
                      </Button>
                    </td>
                    <td>{formatTokens(m.totalTokens)}</td>
                    <td>{row ? money(row.costUsd) : "-"}</td>
                    <td>
                      {row && m.totalTokens ? money((row.costUsd * 1e6) / m.totalTokens) : "-"}
                    </td>
                  </tr>
                );
              })}
              {bill.unassigned > 0 && (
                <tr>
                  <td>{gt("No attributable usage")}</td>
                  <td>0</td>
                  <td>{money(bill.unassigned)}</td>
                  <td>-</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {focus && detail && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setFocus(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{focus.model}</DialogTitle>
              <DialogDescription>
                {PROVIDER_PRESENTATION[focus.provider].label} · {gt("Attributed cost")} ·{" "}
                {detail.providers.size ? money(detail.costUsd) : gt("Not entered")}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <UsageProviderChart
                providers={[focus.provider]}
                days={enumerateDays(range.sinceDay, range.untilDay)}
                daily={detail.daily}
                hours={hourly ? enumerateHourStarts(range.sinceTime!, range.untilTime!) : []}
                hourly={detail.hourly}
                metric="cost"
                referenceTime={range.untilTime}
                resolution={hourly ? "hour" : "day"}
                timeZone={range.timeZone}
                hour12={props.hour12}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
function UsageReportBody(
  props: ReportProps & {
    basis: "api" | "subscription";
    setBasis: (v: "api" | "subscription") => void;
    payments: React.ReactNode;
    book: Book;
    dailySource: React.ReactNode;
    money: (n: number) => string;
    children: React.ReactNode;
  },
) {
  const gt = useGT(),
    { merged, report, window, basis } = props;
  const receipts = useAtomValue(receiptsAtom);
  const first =
    [
      ...receipts.flatMap((r) =>
        r.firstDay && (!props.selection || props.selection.has(r.environmentId))
          ? [r.firstDay]
          : [],
      ),
      ...Object.entries(props.book).flatMap(([k, v]) =>
        v.cents !== null ? [k.slice(0, 7) + "-01"] : [],
      ),
    ].sort()[0] ?? "1970-01-01";
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {report ? gt("Usage report") : gt("Subscription cost")}
        </h2>
        <div className="flex gap-2">
          {report && (
            <ToggleGroup
              variant="segmented"
              aria-label={gt("Cost basis")}
              value={[basis]}
              onValueChange={([v]) => {
                if (v === "api" || v === "subscription") props.setBasis(v);
              }}
            >
              <Toggle value="api">{gt("API cost")}</Toggle>
              <Toggle value="subscription">{gt("Subscription")}</Toggle>
            </ToggleGroup>
          )}
          {basis === "subscription" && props.payments}
        </div>
      </div>
      {report && <RangeControls window={window} change={props.setWindow} first={first} />}
      <p className="text-xs text-muted-foreground">
        {window.sinceDay} – {window.untilDay}
      </p>
      {!props.environments.some((e) => e.canReadDiagnostics) ? (
        <p>{gt("Connect an environment to see usage.")}</p>
      ) : !props.ready ? (
        <p>{gt("Scanning provider transcripts…")}</p>
      ) : basis === "subscription" ? (
        (props.dailySource ?? <SubscriptionPanel {...props} />)
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Donut
              title={gt("Tokens by provider")}
              rows={merged.providers.map((p) => ({ provider: p.provider, value: p.totalTokens }))}
              format={formatTokens}
            />
            <Donut
              title={gt("API cost by provider")}
              rows={merged.providers.map((p) => ({ provider: p.provider, value: p.costUsd }))}
              format={props.money}
            />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>{gt("Provider")}</th>
                <th>{gt("Tokens")}</th>
                <th>{gt("API estimate")}</th>
              </tr>
            </thead>
            <tbody>
              {merged.providers.map((p) => (
                <tr key={p.provider}>
                  <td>{PROVIDER_PRESENTATION[p.provider].label}</td>
                  <td>{formatTokens(p.totalTokens)}</td>
                  <td>{props.money(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {props.children}
    </section>
  );
}
