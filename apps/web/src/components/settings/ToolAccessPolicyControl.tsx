import type { AppToolAccessPolicy } from "@t3tools/contracts";

import {
  normalizeToolAccessPolicy,
  updateToolAccessPolicySelection,
  type ToolAccessCatalogEntry,
} from "../../toolAccess";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";

const KIND_LABELS = {
  skill: "Skills",
  plugin: "Plugins",
  mcp: "MCPs",
} as const;

type ToolPolicyScope = "global" | "profile" | "project";

function modeLabel(scope: ToolPolicyScope, mode: AppToolAccessPolicy["mode"]): string {
  if (mode === "custom") return "Custom";
  if (mode === "inherit") {
    return scope === "project" ? "Use profile" : "Use global";
  }
  return "All tools";
}

function selectableModes(scope: ToolPolicyScope): ReadonlyArray<AppToolAccessPolicy["mode"]> {
  return scope === "global" ? ["all", "custom"] : ["inherit", "all", "custom"];
}

export function ToolAccessPolicyControl({
  catalog,
  onChange,
  policy,
  scope,
}: {
  readonly catalog: ReadonlyArray<ToolAccessCatalogEntry>;
  readonly onChange: (policy: AppToolAccessPolicy) => void;
  readonly policy: AppToolAccessPolicy | undefined;
  readonly scope: ToolPolicyScope;
}) {
  const normalized = normalizeToolAccessPolicy(policy, scope === "global" ? "all" : "inherit");
  const selectedKeys = new Set(normalized.enabledToolKeys);
  const enabledCatalogKeys = catalog.filter((entry) => entry.enabled).map((entry) => entry.key);
  const customPolicyWithCurrentCatalog = (): AppToolAccessPolicy => ({
    mode: "custom",
    enabledToolKeys:
      normalized.enabledToolKeys.length > 0
        ? normalized.enabledToolKeys
        : [...new Set(enabledCatalogKeys)].sort(),
  });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={normalized.mode}
          onValueChange={(value) => {
            if (value !== "all" && value !== "custom" && value !== "inherit") {
              return;
            }
            onChange(
              value === "custom"
                ? customPolicyWithCurrentCatalog()
                : { ...normalized, mode: value },
            );
          }}
        >
          <SelectTrigger className="w-40" aria-label="Tool access mode">
            <SelectValue>{modeLabel(scope, normalized.mode)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {selectableModes(scope).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {modeLabel(scope, mode)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {normalized.mode === "custom" && catalog.length > 0 ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() =>
                onChange({
                  mode: "custom",
                  enabledToolKeys: [...new Set(enabledCatalogKeys)].sort(),
                })
              }
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onChange({ mode: "custom", enabledToolKeys: [] })}
            >
              Clear
            </Button>
          </>
        ) : null}
      </div>

      {normalized.mode === "custom" ? (
        <div className="max-h-72 overflow-auto rounded-md border border-border bg-background/50">
          {catalog.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No provider tools were reported yet.
            </div>
          ) : (
            (["plugin", "mcp", "skill"] as const).map((kind) => {
              const entries = catalog.filter((entry) => entry.kind === kind);
              if (entries.length === 0) return null;
              return (
                <div key={kind} className="border-b border-border/60 last:border-b-0">
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {KIND_LABELS[kind]}
                  </div>
                  <div className="divide-y divide-border/40">
                    {entries.map((entry) => (
                      <label
                        key={entry.key}
                        className="flex cursor-pointer items-start gap-2 px-3 py-2 text-xs hover:bg-accent/60"
                      >
                        <Checkbox
                          checked={selectedKeys.has(entry.key)}
                          disabled={!entry.enabled}
                          onCheckedChange={(checked) =>
                            onChange(
                              updateToolAccessPolicySelection({
                                policy: normalized,
                                toolKey: entry.key,
                                checked: Boolean(checked),
                              }),
                            )
                          }
                          aria-label={`Allow ${entry.label}`}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium text-foreground">
                              {entry.label}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/70">
                              {entry.providerLabel}
                            </span>
                          </span>
                          {entry.description || entry.source ? (
                            <span className="mt-0.5 block truncate text-muted-foreground">
                              {[entry.description, entry.source].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
