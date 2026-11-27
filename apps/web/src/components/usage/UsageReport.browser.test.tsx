import "../../index.css";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummary } from "@t3tools/contracts";
import { usagePeriod } from "@t3tools/shared/usagePayments";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { render } from "../../../test/render";
import { UsageReport } from "./UsageReport";

const saved = vi.hoisted(() => vi.fn(async () => true));
vi.mock(import("../../state/UsageArchiveCoordinator"), async () => {
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  return {
    usagePayments: {
      state: Atom.make({
        book: {},
        id: EnvironmentId.make("machine"),
        label: "Machine",
        targets: [{ id: EnvironmentId.make("machine"), label: "Machine" }],
        writers: [EnvironmentId.make("machine")],
      }),
      select: () => {},
      save: saved,
    },
    UsageArchiveCoordinator: () => null,
  };
});
function Fixture() {
  const [window, setWindow] = useState(() => usagePeriod("year"));
  const environmentId = EnvironmentId.make("machine");
  const summary: UsageSummary = {
    ...window,
    readAt: "2026-11-27T12:00:00Z",
    buckets: [],
    sources: [],
    contractVersion: USAGE_CONTRACT_VERSION,
    scanDurationMs: 0,
    pricing: { status: "unavailable", source: "fixture", fetchedAt: null, knownModels: 0 },
  };
  const env = {
    environmentId,
    label: "Machine",
    isConnected: true,
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary,
  };
  return (
    <UsageReport
      report
      window={window}
      setWindow={setWindow}
      environments={[env]}
      selection={null}
      hidden={new Set()}
      merged={mergeUsage([env], USAGE_CONTRACT_VERSION)}
      ready
      hour12={false}
    />
  );
}
describe("Usage report", () => {
  it("shows custom dates only on demand and edits the monthly payment through Subscription", async () => {
    await using _screen = await render(<Fixture />);
    await expect
      .element(page.getByRole("spinbutton", { name: "Number of days" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Number of days" }).fill("37");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.element(page.getByRole("spinbutton", { name: "Number of days" })).toHaveValue(37);
    await page.getByRole("button", { name: "Last year" }).click();
    await expect
      .element(page.getByRole("spinbutton", { name: "Number of days" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Subscription", exact: true }).click();
    await expect.element(page.getByLabelText("Payment environment")).toHaveValue("machine");
    await page.getByRole("button", { name: "Monthly payments" }).click();
    await page.getByLabelText("Payment month").fill("2026-11");
    await page.getByLabelText("Codex", { exact: true }).fill("30.50");
    await page.getByRole("button", { name: "Save payments" }).click();
    expect(saved).toHaveBeenCalledWith("machine", { "2026-11/codex": 3050 });
  });
});
