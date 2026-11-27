# Usage and limits

Track token usage, cache hit rates, estimated API-equivalent costs, and pooled subscription quotas across all connected environments.

- **Open Usage**: Click **Usage** in the sidebar, press `mod+u` (web/desktop outside terminals), or pick **Usage** on mobile.
- **Quick shortcuts** (web/desktop on Usage): `C` (Cost), `T` (Tokens), `L` (Limits), `mod+Shift+1/2/3/4` (24h / 7d / 30d / 90d), `Esc` (back).

## Understand your usage

Usage aggregates history across Codex, Claude Code, Grok Build, OpenCode, Antigravity, Pi, Muse Code, and Cursor from your selected environments. Estimates reflect API-equivalent rates (not your subscription bill); **Premium** shows Fast/Ultrafast surcharge, and **Other** shows unsplit provider-reported costs.

- **History**: The usage report keeps recorded totals without an expiration date. Collection starts with history the providers can still supply. The underlying transcript scan cache keeps 92 days by default. Its `usageHistoryRetentionDays` setting is independent of the report archive.
- **Custom data directories**: Honors `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`, and `XDG_DATA_HOME` (Muse). Use absolute or `~/` paths. Set `T3CODE_HOST_ID` to pin a container's host identity.
- **Exclusions**: Codex and Claude Code 2.0.63+ text-generation runs (titles, commits, PR text, review guides) and Grok turns without a saved completed-turn record are not included.

## Historical reports and subscriptions

Open **Usage → Usage report** and choose a period. **Last year** shows the trailing year. **Custom** accepts an inclusive date range, a number of days, or the entire recorded history. The two charts compare each provider’s share of tokens and cost. In **Summary**, switch a chart to **Cumulative** to stack the running total from each provider.

Choose **Subscription → Monthly payments** in Summary or the report to enter the amount actually paid per provider and calendar month in USD. Choose the payment environment to use the same ledger from different clients. Payments stay on that environment and are available to sessions with permission to edit its settings. An empty amount is unknown. Zero records a free month. **Full payments** includes each affected provider-month once across machines. **Period cost** includes the fraction of the calendar month selected. Each day’s cost is allocated by the provider’s token usage across models and environments. Days with no recorded tokens stay unattributed.

**Synchronization** shows where a copy was saved and when. Clients copy usage among connected environments they can maintain and read diagnostics from. A server with a full-access link can also pull its peer’s archive while no client is open. The latest saved copy remains available when its source is offline. A machine that disconnects before a copy completes can reconcile when it reconnects.

## Inspect one thread

On web and desktop, the thread details card shows an estimated cost for the thread and its
subagents. Select it to open the usage breakdown. You can hide it in **Settings → Appearance →
Thread details**.

You can also choose **View usage** in a thread's menu, or in the menu beside a
subagent in the work log or Lineage. The **Tasks & usage** side panel combines the thread
and its subagents, including descendants on connected environments. Forks and side chats
are separate. Expand a row to inspect its tasks, or open **View tasks** to start there.
The progress count describes reported steps; different agents' lists can overlap.

Usage comes from recorded turns. Missing provider reports, unavailable children, and limits on
large families are marked as partial. Input includes cache tokens, and output includes reasoning.
Extra provider usage that may overlap child turns is flagged; its token counts are not displayed
or included in the totals.

Cost is an estimate at standard API rates for turns with one reported model. Missing cache
breakdowns are treated as uncached input. Mixed or unknown models and turns whose aggregate
cannot establish the context pricing tier stay unpriced. This estimate
can differ from Usage's transcript-based history and does not represent a subscription charge.
Subscription limits are account-wide across threads and devices. Providers do not report how
much of a subscription's quota an individual thread consumed.

## Custom model prices and filtering

- **Custom prices & model mapping**: Open the environment dropdown on **Usage → Model prices** (or click **Set price** on an unpriced model) to set USD per million input/output/cache tokens, or set **Map to** to merge a preview/alias model ID into a target model's totals.
- **Filter models**: Add `usageModelFilter` to `<t3-home>/userdata/settings.json` (applied before **Map to**):

```json
{
  "usageModelFilter": {
    "include": [{ "provider": "claude", "model": "orbit-1" }, { "model": "orbit-2" }],
    "exclude": [{ "model": "drift-9" }]
  }
}
```

## Subscription limits

**Usage → Limits** pools subscription quotas per provider across connected environments and hubs (deduplicating the same account signed in on multiple machines).

- **In chat**: Run `/usage-limits` in the composer to view the current model's snapshot without running the agent, or enable **Settings → Appearance → Thread details → Usage limits** (web/desktop).
- **Reset credits**: Click an account segment/row to inspect plan details and redeem banked Codex/Claude reset credits via **Use reset** (Claude resets unavailable on macOS Keychain logins).
- **Provider notes**:
  - **OpenCode**: OpenCode 2 servers with usage reporting show Go allowances and Console budgets for the connected workspace. Local servers can also report Go usage from a Go API key (`OPENCODE_API_KEY`).
  - **Cursor**: Reports monthly Auto + API quotas via `CURSOR_AUTH_TOKEN` or default-endpoint sign-in/`CURSOR_API_KEY`.
  - **Grok**: Reports billing-period quotas for `grok login` (not `XAI_API_KEY`).
  - **Muse Code**: Reports session/weekly limits after running in a thread (not persisted across restarts).
  - Pure API-key accounts generally do not report subscription limits.
- **Mobile widget**: Add the **Subscription usage** widget on iOS or Android to monitor Codex and Claude quotas from your home screen.

## Connect a CLIProxyAPI hub

Open **Settings → Providers → Usage providers → Add hub**, choose the environment, and enter the hub URL and management key. Pools Codex, Claude, and Grok accounts under **Usage → Limits** (including Codex **Use reset**). Configure the provider's endpoint to the same URL if you want threads to display that hub's limits.

## Connect an HTTP quota source

Open **Settings → Providers → Usage providers → Add HTTP source** with a GET endpoint (and optional bearer token) returning:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "primary",
      "label": "My coding plan",
      "providerInstanceId": "work-codex",
      "windows": [
        {
          "id": "monthly",
          "kind": "monthly",
          "label": "Monthly budget",
          "usedPercent": 35,
          "resetsAt": "2026-12-01T00:00:00Z"
        }
      ]
    }
  ]
}
```

`kind` is `session`, `weekly`, `monthly`, or `other`. Setting `providerInstanceId` binds the quota windows to that instance's thread details card.
