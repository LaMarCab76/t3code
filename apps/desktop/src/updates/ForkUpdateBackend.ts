// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This native updater boundary owns streaming downloads and detached OS processes; its Promise/event API is wrapped by ElectronUpdater.
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  decodeForkManifest,
  forkAssetUrl,
  FORK_APP_ID,
  FORK_MANIFEST_NAME,
  FORK_UPDATE_REPOSITORY,
  isCompleteForkRelease,
  isNewerForkVersion,
  type ForkRelease,
  type ForkUpdateManifest,
} from "./forkManifest.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const MAX_MANIFEST_SIZE = 64 * 1024;
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024;

async function fetchJson(url: string, maxBytes: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`Update request failed (${response.status}). Try again later.`);
  if (!response.body) throw new Error("The update response was empty.");
  let text = "";
  const decoder = new TextDecoder();
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error("Update metadata is too large.");
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

/** Stream to disk; a partial file is never accepted as a downloaded update. */
export async function downloadVerifiedArchive(input: {
  url: string;
  destination: string;
  size: number;
  sha256: string;
  onProgress: (percent: number) => void;
}) {
  if (input.size <= 0 || input.size > MAX_ARCHIVE_SIZE)
    throw new Error("Invalid update archive size.");
  const partial = `${input.destination}.partial`;
  const response = await fetch(input.url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body)
    throw new Error(`Update download failed (${response.status}).`);
  const file = await NodeFSP.open(partial, "w", 0o600);
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > input.size) throw new Error("Update archive is larger than its manifest.");
      hash.update(chunk);
      await file.writeFile(chunk);
      input.onProgress(Math.min(99, (bytes * 100) / input.size));
    }
    if (bytes !== input.size || hash.digest("hex") !== input.sha256)
      throw new Error("Update checksum or size does not match. Download the update again.");
    await file.close();
    await NodeFSP.rename(partial, input.destination);
  } catch (cause) {
    await file.close().catch(() => {});
    await NodeFSP.rm(partial, { force: true });
    throw cause;
  }
}

async function verifyMacBundle(
  bundle: string,
  version: string,
  arch: "arm64" | "x64",
): Promise<string> {
  const plist = NodePath.join(bundle, "Contents", "Info.plist");
  const value = async (key: string) =>
    (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim();
  if (
    (await value("CFBundleIdentifier")) !== FORK_APP_ID ||
    (await value("CFBundleShortVersionString")) !== version
  )
    throw new Error("Update app identity or version does not match its manifest.");
  const binary = await value("CFBundleExecutable");
  if (!binary || NodePath.basename(binary) !== binary)
    throw new Error("Invalid update executable.");
  const architectures = (
    await run("/usr/bin/lipo", ["-archs", NodePath.join(bundle, "Contents", "MacOS", binary)])
  ).stdout
    .trim()
    .split(/\s+/);
  if (!architectures.includes(arch === "arm64" ? "arm64" : "x86_64"))
    throw new Error("The update does not support this Mac's architecture.");
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  const signature = await run("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]);
  if (
    !signature.stderr.includes("Signature=adhoc") ||
    !signature.stderr.includes(`Identifier=${FORK_APP_ID}\n`)
  )
    throw new Error("The update does not have the expected ad hoc signature.");
  return binary;
}

export async function assertWritableInstallation(app: string, installerUrl: string) {
  try {
    await NodeFSP.access(NodePath.dirname(app), NodeFS.constants.W_OK);
  } catch {
    throw new Error(
      `This app location is not writable. Update manually using the installer at ${installerUrl}`,
    );
  }
}

export interface ForkBackendOptions {
  readonly currentVersion: string;
  readonly arch: "arm64" | "x64";
  readonly resourcesPath: string;
  readonly installationPath: string;
  readonly cachePath: string;
  readonly quit: () => void;
}

/** Provider-specific boundary; the desktop update state machine stays shared. */
export class ForkUpdateBackend extends NodeEvents.EventEmitter {
  private available: { release: ForkRelease; manifest: ForkUpdateManifest } | null = null;
  private staged: { bundle: string; binary: string; version: string } | null = null;
  private etag: string | null = null;
  private readonly options: ForkBackendOptions;
  constructor(options: ForkBackendOptions) {
    super();
    this.options = options;
  }

  async checkForUpdates() {
    this.emit("checking-for-update");
    const response = await fetch(
      `https://api.github.com/repos/${FORK_UPDATE_REPOSITORY}/releases?per_page=100`,
      {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          ...(this.etag ? { "If-None-Match": this.etag } : {}),
        },
      },
    );
    if (response.status !== 304) {
      if (!response.ok)
        throw new Error(`Could not check fork releases (${response.status}). Try again later.`);
      const releases = (await response.json()) as ForkRelease[];
      if (!Array.isArray(releases)) throw new Error("Invalid fork release list.");
      this.available = null;
      for (const release of releases) {
        const version = release.tag_name?.replace(/^fork-v/, "");
        if (
          release.draft ||
          !version ||
          !/^\d+\.\d+\.\d+-preview\.\d{8}\.\d+$/.test(version) ||
          !isNewerForkVersion(version, this.options.currentVersion)
        )
          continue;
        if (this.available && !isNewerForkVersion(version, this.available.manifest.version))
          continue;
        const asset = release.assets.find((asset) => asset.name === FORK_MANIFEST_NAME);
        if (
          !asset ||
          asset.size > MAX_MANIFEST_SIZE ||
          asset.browser_download_url !== forkAssetUrl(release.tag_name, FORK_MANIFEST_NAME)
        )
          continue;
        // Missing or malformed manifests never make an incomplete release eligible.
        try {
          const manifest = decodeForkManifest(
            await fetchJson(asset.browser_download_url, MAX_MANIFEST_SIZE),
          );
          if (isCompleteForkRelease(release, manifest)) this.available = { release, manifest };
        } catch {
          continue;
        }
      }
      this.etag = response.headers.get("etag");
    }
    if (this.available)
      this.emit("update-available", {
        version: this.available.manifest.version,
        releaseNotes: this.available.release.body ?? "",
      });
    else this.emit("update-not-available");
  }

  async downloadUpdate() {
    this.staged = null;
    if (!this.available) throw new Error("Check for updates before downloading.");
    const { manifest, release } = this.available;
    const asset = manifest.files[this.options.arch].zip;
    const directory = NodePath.join(this.options.cachePath, manifest.version, this.options.arch);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = NodePath.join(directory, asset.name);
    await downloadVerifiedArchive({
      url: forkAssetUrl(release.tag_name, asset.name),
      destination: archive,
      size: asset.size,
      sha256: asset.sha256,
      onProgress: (percent) => this.emit("download-progress", { percent }),
    });
    const entries = (
      await run("/usr/bin/unzip", ["-Z", "-1", archive], { maxBuffer: 16 * 1024 * 1024 })
    ).stdout
      .split("\n")
      .filter(Boolean);
    if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes("..")))
      throw new Error("Invalid paths in update archive.");
    const extracted = NodePath.join(directory, "extracted");
    await NodeFSP.rm(extracted, { recursive: true, force: true });
    await NodeFSP.mkdir(extracted, { mode: 0o700 });
    await run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
    const apps = (await NodeFSP.readdir(extracted)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("The update must contain exactly one app.");
    const bundle = NodePath.join(extracted, apps[0]!);
    const binary = await verifyMacBundle(bundle, manifest.version, this.options.arch);
    this.staged = { bundle, binary, version: manifest.version };
    this.emit("download-progress", { percent: 100 });
    this.emit("update-downloaded", { version: manifest.version });
  }

  async quitAndInstall() {
    if (!this.staged || !this.available) throw new Error("Download and verify the update first.");
    const app = this.options.installationPath;
    await assertWritableInstallation(
      app,
      `https://github.com/${FORK_UPDATE_REPOSITORY}/releases/tag/${this.available.release.tag_name}`,
    );
    const id = NodeCrypto.randomUUID();
    const candidate = NodePath.join(NodePath.dirname(app), `.t3-update-${id}.app`);
    const backup = NodePath.join(NodePath.dirname(app), `.t3-backup-${id}.app`);
    const job = NodePath.join(this.options.cachePath, "jobs", id);
    await NodeFSP.mkdir(job, { recursive: true, mode: 0o700 });
    try {
      await run("/usr/bin/ditto", [this.staged.bundle, candidate]);
      await verifyMacBundle(candidate, this.staged.version, this.options.arch);
      const script = NodePath.join(job, "install.sh");
      await NodeFSP.copyFile(NodePath.join(this.options.resourcesPath, "fork-install.sh"), script);
      const token = NodeCrypto.randomUUID();
      await NodeFSP.writeFile(
        NodePath.join(job, "transaction.json"),
        JSON.stringify({ app, candidate, backup, version: this.staged.version, token }),
        { mode: 0o600 },
      );
      const parentStarted = (
        await run("/bin/ps", ["-p", String(process.pid), "-o", "lstart="])
      ).stdout.replace(/\n$/, "");
      const log = await NodeFSP.open(NodePath.join(job, "helper.log"), "a", 0o600);
      const helper = NodeChildProcess.spawn(
        "/bin/sh",
        [
          script,
          app,
          candidate,
          backup,
          job,
          String(process.pid),
          parentStarted,
          this.staged.binary,
          this.staged.version,
          token,
        ],
        { detached: true, stdio: ["ignore", log.fd, log.fd] },
      );
      await new Promise<void>((resolve, reject) => {
        helper.once("spawn", resolve);
        helper.once("error", reject);
      });
      helper.unref();
      await log.close();
    } catch (cause) {
      await NodeFSP.rm(candidate, { recursive: true, force: true });
      throw cause;
    }
    this.options.quit();
  }
}

/** Acknowledge only this launch, after the regular backend/window bootstrap. */
export async function acknowledgeForkUpdate(
  cachePath: string,
  version: string,
  argv: readonly string[],
) {
  const receipt = argv
    .find((arg) => arg.startsWith("--t3-fork-update-receipt="))
    ?.slice("--t3-fork-update-receipt=".length);
  const token = argv
    .find((arg) => arg.startsWith("--t3-fork-update-token="))
    ?.slice("--t3-fork-update-token=".length);
  if (
    !receipt ||
    !token ||
    NodePath.basename(receipt) !== "receipt" ||
    !NodePath.resolve(receipt).startsWith(`${NodePath.resolve(cachePath, "jobs")}${NodePath.sep}`)
  )
    return;
  const transaction = JSON.parse(
    await NodeFSP.readFile(NodePath.join(NodePath.dirname(receipt), "transaction.json"), "utf8"),
  ) as { version: string; token: string };
  if (transaction.version !== version || transaction.token !== token) return;
  await NodeFSP.writeFile(receipt, `${version} ${token}`, { mode: 0o600 });
}

/** Surface an interrupted transaction once; retain its backup for manual recovery. */
export async function readForkRecoveryNotice(
  cachePath: string,
  currentVersion: string,
): Promise<string | null> {
  const jobs = NodePath.join(cachePath, "jobs");
  const directories = await NodeFSP.readdir(jobs).catch(() => [] as string[]);
  for (const id of directories.slice(-100).toReversed()) {
    const job = NodePath.join(jobs, id);
    if (
      await NodeFSP.stat(NodePath.join(job, "noticed")).then(
        () => true,
        () => false,
      )
    )
      continue;
    const status = await NodeFSP.readFile(NodePath.join(job, "status"), "utf8").catch(() => "");
    if (status.trim() === "complete") continue;
    const transaction = await NodeFSP.readFile(NodePath.join(job, "transaction.json"), "utf8").then(
      (text) => JSON.parse(text) as { version: string },
      () => null,
    );
    if (!transaction || transaction.version === currentVersion) continue;
    await NodeFSP.writeFile(NodePath.join(job, "noticed"), "1", { mode: 0o600 });
    return status.trim() === "rolled-back"
      ? "The previous fork update failed to start and the original app was restored. Check for updates to try again."
      : "The previous fork update was interrupted. Your app and update backup were retained. Check for updates to try again, or use Download installer.";
  }
  return null;
}
