import * as Schema from "effect/Schema";
import { compareSemverVersions } from "@t3tools/shared/semver";

export const FORK_UPDATE_REPOSITORY = "LaMarCab76/t3code";
export const FORK_MANIFEST_NAME = "fork-update.json";
export const FORK_APP_ID = "com.t3tools.t3code";
const Asset = Schema.Struct({
  name: Schema.String,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const ForkUpdateManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repository: Schema.Literal(FORK_UPDATE_REPOSITORY),
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-preview\.\d{8}\.\d+$/)),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  appId: Schema.Literal(FORK_APP_ID),
  files: Schema.Struct({
    arm64: Schema.Struct({ zip: Asset, dmg: Asset }),
    x64: Schema.Struct({ zip: Asset, dmg: Asset }),
  }),
});
export type ForkUpdateManifest = typeof ForkUpdateManifest.Type;
export const decodeForkManifest = Schema.decodeUnknownSync(ForkUpdateManifest);
export interface ForkReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly browser_download_url: string;
}
export interface ForkRelease {
  readonly draft: boolean;
  readonly tag_name: string;
  readonly html_url: string;
  readonly body: string | null;
  readonly assets: readonly ForkReleaseAsset[];
}
export function forkAssetUrl(tag: string, name: string): string {
  return `https://github.com/${FORK_UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}
/** Old releases and partially uploaded releases cannot enter the feed. */
export function isCompleteForkRelease(release: ForkRelease, manifest: ForkUpdateManifest): boolean {
  if (release.draft || release.tag_name !== `fork-v${manifest.version}`) return false;
  return Object.entries(manifest.files).every(([arch, files]) =>
    Object.entries(files).every(
      ([extension, file]) =>
        file.name === `T3-Code-${manifest.version}-${arch}.${extension}` &&
        release.assets.some(
          (asset) =>
            asset.name === file.name &&
            asset.size === file.size &&
            asset.browser_download_url === forkAssetUrl(release.tag_name, file.name),
        ),
    ),
  );
}
export function isNewerForkVersion(version: string, current: string): boolean {
  return compareSemverVersions(version, current) > 0;
}
export function selectForkArchitecture(processArch: string, translated: boolean): "arm64" | "x64" {
  if (processArch === "arm64" || translated) return "arm64";
  if (processArch === "x64") return "x64";
  throw new Error("This Mac architecture is not supported by the fork updater.");
}
