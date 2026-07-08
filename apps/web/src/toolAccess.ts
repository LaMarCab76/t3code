import {
  DEFAULT_APP_TOOL_ACCESS_POLICY,
  type AppToolAccessPolicy,
  type ClientSettings,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

import type { Project } from "./types";
import { getActiveProfileId, projectProfileKey } from "./profiles";

export type ToolAccessKind = "skill" | "plugin" | "mcp";

export interface ToolAccessCatalogEntry {
  readonly key: string;
  readonly kind: ToolAccessKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly source: string | null;
  readonly enabled: boolean;
}

function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.badgeLabel ?? provider.driver;
}

export function toolKeyForSkill(instanceId: ProviderInstanceId, skillName: string): string {
  return `skill:${instanceId}:${skillName}`;
}

export function toolKeyForPlugin(instanceId: ProviderInstanceId, pluginName: string): string {
  return `plugin:${instanceId}:${pluginName}`;
}

export function toolKeyForMcp(instanceId: ProviderInstanceId, type: string, value: string): string {
  return `mcp:${instanceId}:${type}:${value}`;
}

function pluginNameFromSkillPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const marker = "/plugins/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const afterPlugins = normalized.slice(markerIndex + marker.length);
  const segments = afterPlugins.split("/").filter(Boolean);
  if (segments[0] === "cache" && segments[1]) {
    return segments[1];
  }
  return segments[0] ?? null;
}

function upsertEntry(
  entriesByKey: Map<string, ToolAccessCatalogEntry>,
  entry: ToolAccessCatalogEntry,
): void {
  const existing = entriesByKey.get(entry.key);
  if (!existing) {
    entriesByKey.set(entry.key, entry);
    return;
  }
  entriesByKey.set(entry.key, {
    ...existing,
    enabled: existing.enabled || entry.enabled,
    description: existing.description ?? entry.description,
    source: existing.source ?? entry.source,
  });
}

export function buildToolAccessCatalog(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ToolAccessCatalogEntry> {
  const entriesByKey = new Map<string, ToolAccessCatalogEntry>();

  for (const provider of providers) {
    const label = providerLabel(provider);
    for (const skill of provider.skills) {
      upsertEntry(entriesByKey, {
        key: toolKeyForSkill(provider.instanceId, skill.name),
        kind: "skill",
        providerInstanceId: provider.instanceId,
        providerLabel: label,
        name: skill.name,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? null,
        source: skill.scope ?? null,
        enabled: skill.enabled,
      });

      const pluginName = pluginNameFromSkillPath(skill.path);
      if (pluginName) {
        upsertEntry(entriesByKey, {
          key: toolKeyForPlugin(provider.instanceId, pluginName),
          kind: "plugin",
          providerInstanceId: provider.instanceId,
          providerLabel: label,
          name: pluginName,
          label: pluginName,
          description: null,
          source: "plugin install",
          enabled: skill.enabled,
        });
      }

      for (const dependency of skill.toolDependencies ?? []) {
        upsertEntry(entriesByKey, {
          key: toolKeyForMcp(provider.instanceId, dependency.type, dependency.value),
          kind: "mcp",
          providerInstanceId: provider.instanceId,
          providerLabel: label,
          name: dependency.value,
          label: dependency.value,
          description: dependency.description ?? null,
          source: dependency.transport ?? dependency.type,
          enabled: skill.enabled,
        });
      }
    }
  }

  return [...entriesByKey.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.providerLabel.localeCompare(right.providerLabel) ||
      left.label.localeCompare(right.label) ||
      left.key.localeCompare(right.key),
  );
}

export function normalizeToolAccessPolicy(
  policy: AppToolAccessPolicy | undefined,
  fallbackMode: AppToolAccessPolicy["mode"] = DEFAULT_APP_TOOL_ACCESS_POLICY.mode,
): AppToolAccessPolicy {
  if (!policy) {
    return { ...DEFAULT_APP_TOOL_ACCESS_POLICY, mode: fallbackMode };
  }
  return {
    mode: policy.mode,
    enabledToolKeys: [...new Set(policy.enabledToolKeys.map((key) => key.trim()).filter(Boolean))],
  };
}

export function isToolAccessPolicyCustom(policy: AppToolAccessPolicy | undefined): boolean {
  return normalizeToolAccessPolicy(policy).mode === "custom";
}

export function resolveEffectiveToolAccess(input: {
  readonly settings: Pick<
    ClientSettings,
    | "activeProfileId"
    | "profiles"
    | "globalToolAccessPolicy"
    | "profileToolAccessPolicies"
    | "projectToolAccessPolicies"
  >;
  readonly catalog: ReadonlyArray<ToolAccessCatalogEntry>;
  readonly project?: Pick<Project, "environmentId" | "workspaceRoot"> | null;
}): ReadonlySet<string> | null {
  const projectPolicy =
    input.project === undefined || input.project === null
      ? undefined
      : input.settings.projectToolAccessPolicies[projectProfileKey(input.project)];
  const normalizedProjectPolicy = normalizeToolAccessPolicy(projectPolicy, "inherit");
  if (normalizedProjectPolicy.mode === "custom") {
    return new Set(normalizedProjectPolicy.enabledToolKeys);
  }

  const activeProfileId = getActiveProfileId(input.settings);
  const profilePolicy = normalizeToolAccessPolicy(
    input.settings.profileToolAccessPolicies[activeProfileId],
    "inherit",
  );
  if (profilePolicy.mode === "custom") {
    return new Set(profilePolicy.enabledToolKeys);
  }

  const globalPolicy = normalizeToolAccessPolicy(input.settings.globalToolAccessPolicy);
  if (globalPolicy.mode === "custom") {
    return new Set(globalPolicy.enabledToolKeys);
  }

  return null;
}

function skillAccessKeys(input: {
  readonly provider: Pick<ServerProvider, "instanceId">;
  readonly skill: ServerProviderSkill;
}): ReadonlyArray<string> {
  const keys = [toolKeyForSkill(input.provider.instanceId, input.skill.name)];
  const pluginName = pluginNameFromSkillPath(input.skill.path);
  if (pluginName) {
    keys.push(toolKeyForPlugin(input.provider.instanceId, pluginName));
  }
  for (const dependency of input.skill.toolDependencies ?? []) {
    keys.push(toolKeyForMcp(input.provider.instanceId, dependency.type, dependency.value));
  }
  return keys;
}

export function filterProviderSkillsForToolAccess(input: {
  readonly provider: ServerProvider | null;
  readonly settings: Pick<
    ClientSettings,
    | "activeProfileId"
    | "profiles"
    | "globalToolAccessPolicy"
    | "profileToolAccessPolicies"
    | "projectToolAccessPolicies"
  >;
  readonly catalog: ReadonlyArray<ToolAccessCatalogEntry>;
  readonly project?: Pick<Project, "environmentId" | "workspaceRoot"> | null;
}): ReadonlyArray<ServerProviderSkill> {
  if (!input.provider) {
    return [];
  }
  const allowed = resolveEffectiveToolAccess({
    settings: input.settings,
    catalog: input.catalog,
    ...(input.project === undefined ? {} : { project: input.project }),
  });
  if (allowed === null) {
    return input.provider.skills;
  }
  return input.provider.skills.filter((skill) =>
    skillAccessKeys({ provider: input.provider!, skill }).some((key) => allowed.has(key)),
  );
}

export function updateToolAccessPolicySelection(input: {
  readonly policy: AppToolAccessPolicy | undefined;
  readonly toolKey: string;
  readonly checked: boolean;
  readonly fallbackMode?: AppToolAccessPolicy["mode"];
}): AppToolAccessPolicy {
  const policy = normalizeToolAccessPolicy(input.policy, input.fallbackMode);
  const nextKeys = new Set(policy.enabledToolKeys);
  if (input.checked) {
    nextKeys.add(input.toolKey);
  } else {
    nextKeys.delete(input.toolKey);
  }
  return {
    mode: "custom",
    enabledToolKeys: [...nextKeys].sort(),
  };
}
