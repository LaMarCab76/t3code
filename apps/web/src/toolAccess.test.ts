import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  type ClientSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";

import {
  buildToolAccessCatalog,
  filterProviderSkillsForToolAccess,
  resolveEffectiveToolAccess,
  toolKeyForPlugin,
  toolKeyForSkill,
} from "./toolAccess";

const codexInstance = ProviderInstanceId.make("codex");
const workInstance = ProviderInstanceId.make("codex_work");
const env = EnvironmentId.make("local");

function provider(input: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: codexInstance,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  };
}

function settings(patch: Partial<ClientSettings> = {}): ClientSettings {
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    ...patch,
  };
}

describe("toolAccess", () => {
  it("builds skill and plugin entries from provider skills", () => {
    const catalog = buildToolAccessCatalog([
      provider({
        skills: [
          {
            name: "gh-fix-ci",
            displayName: "Fix CI",
            path: "/Users/julius/.codex/plugins/cache/github/skills/gh-fix-ci/SKILL.md",
            enabled: true,
          },
        ],
      }),
    ]);

    expect(catalog.map((entry) => entry.key)).toEqual([
      toolKeyForPlugin(codexInstance, "github"),
      toolKeyForSkill(codexInstance, "gh-fix-ci"),
    ]);
  });

  it("uses global custom policy when neither profile nor project overrides exist", () => {
    const allowed = resolveEffectiveToolAccess({
      catalog: [],
      settings: settings({
        globalToolAccessPolicy: {
          mode: "custom",
          enabledToolKeys: [toolKeyForSkill(codexInstance, "imagegen")],
        },
      }),
    });

    expect([...(allowed ?? [])]).toEqual([toolKeyForSkill(codexInstance, "imagegen")]);
  });

  it("lets project custom policy use tools from another provider profile", () => {
    const project = { environmentId: env, workspaceRoot: "/repo/app" };
    const skillKey = toolKeyForSkill(workInstance, "deploy");
    const allowed = resolveEffectiveToolAccess({
      catalog: [],
      project,
      settings: settings({
        activeProfileId: "default",
        profiles: [
          { id: "default", name: "Default" },
          { id: "work", name: "Work" },
        ],
        profileToolAccessPolicies: {
          default: {
            mode: "custom",
            enabledToolKeys: [toolKeyForSkill(codexInstance, "imagegen")],
          },
        },
        projectToolAccessPolicies: {
          "local:/repo/app": {
            mode: "custom",
            enabledToolKeys: [skillKey],
          },
        },
      }),
    });

    expect([...(allowed ?? [])]).toEqual([skillKey]);
  });

  it("filters provider skills through plugin keys", () => {
    const snapshot = provider({
      skills: [
        {
          name: "gh-fix-ci",
          path: "/Users/julius/.codex/plugins/cache/github/skills/gh-fix-ci/SKILL.md",
          enabled: true,
        },
        {
          name: "imagegen",
          path: "/Users/julius/.codex/skills/imagegen/SKILL.md",
          enabled: true,
        },
      ],
    });

    const filtered = filterProviderSkillsForToolAccess({
      provider: snapshot,
      catalog: buildToolAccessCatalog([snapshot]),
      settings: settings({
        globalToolAccessPolicy: {
          mode: "custom",
          enabledToolKeys: [toolKeyForPlugin(codexInstance, "github")],
        },
      }),
    });

    expect(filtered.map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
  });
});
