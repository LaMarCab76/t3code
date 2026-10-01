// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real HTTP streams and isolated filesystem/process fixtures exercise the native updater boundary.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ForkUpdateBackend,
  acknowledgeForkUpdate,
  downloadVerifiedArchive,
} from "./ForkUpdateBackend.ts";
import {
  decodeForkManifest,
  forkAssetUrl,
  isCompleteForkRelease,
  isNewerForkVersion,
  selectForkArchitecture,
} from "./forkManifest.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "0.0.44-preview.20261001.8";
function manifestFixture() {
  const file = (arch: string, extension: string) => ({
    name: `T3-Code-${version}-${arch}.${extension}`,
    size: 1234,
    sha256: "a".repeat(64),
  });
  return decodeForkManifest({
    schemaVersion: 1,
    repository: "LaMarCab76/t3code",
    appId: "com.t3tools.t3code",
    version,
    commit: "b".repeat(40),
    files: {
      arm64: { zip: file("arm64", "zip"), dmg: file("arm64", "dmg") },
      x64: { zip: file("x64", "zip"), dmg: file("x64", "dmg") },
    },
  });
}
describe("fork update feed", () => {
  it("selects the real host architecture, including Intel under Rosetta", () => {
    expect(selectForkArchitecture("arm64", false)).toBe("arm64");
    expect(selectForkArchitecture("x64", true)).toBe("arm64");
    expect(selectForkArchitecture("x64", false)).toBe("x64");
    expect(() => selectForkArchitecture("other", false)).toThrow();
  });
  it("compares preview versions numerically without downgrade", () => {
    expect(isNewerForkVersion("0.0.44-preview.20261001.10", version)).toBe(true);
    expect(isNewerForkVersion(version, version)).toBe(false);
    expect(isNewerForkVersion("0.0.44-preview.20260930.99", version)).toBe(false);
  });
  it("requires complete, published assets from this fork", () => {
    const manifest = manifestFixture();
    const tag = `fork-v${version}`;
    const assets = Object.values(manifest.files).flatMap((files) =>
      Object.values(files).map((file) => ({
        name: file.name,
        size: file.size,
        browser_download_url: forkAssetUrl(tag, file.name),
      })),
    );
    const release = { draft: false, tag_name: tag, assets, html_url: "", body: null };
    expect(isCompleteForkRelease(release, manifest)).toBe(true);
    expect(isCompleteForkRelease({ ...release, draft: true }, manifest)).toBe(false);
    expect(isCompleteForkRelease({ ...release, assets: assets.slice(1) }, manifest)).toBe(false);
    expect(
      isCompleteForkRelease(
        { ...release, assets: assets.map((asset) => ({ ...asset, size: 1 })) },
        manifest,
      ),
    ).toBe(false);
    expect(isCompleteForkRelease({ ...release, tag_name: "old-release" }, manifest)).toBe(false);
    expect(() => decodeForkManifest({ version })).toThrow();
    expect(() => decodeForkManifest({ ...manifest, repository: "pingdotgg/t3code" })).toThrow();
  });
});

describe("verified update downloads", () => {
  it("accepts matching bytes and removes corrupt or interrupted partial files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-download-"));
    const content = Buffer.from("a small update fixture");
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === "/broken") {
        response.writeHead(200, { "Content-Length": content.length + 100 });
        response.write(content);
        response.destroy();
      } else {
        response.end(content);
      }
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const url = `http://127.0.0.1:${address.port}`;
    const destination = NodePath.join(directory, "update.zip");
    const input = {
      url,
      destination,
      size: content.length,
      sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
      onProgress: () => {},
    };
    try {
      await downloadVerifiedArchive(input);
      expect(await NodeFSP.readFile(destination)).toEqual(content);
      await NodeFSP.rm(destination);
      for (const patch of [
        { sha256: "0".repeat(64) },
        { size: content.length + 1 },
        { size: content.length - 1 },
        { url: `${url}/broken` },
      ]) {
        await expect(downloadVerifiedArchive({ ...input, ...patch })).rejects.toThrow();
        await expect(NodeFSP.stat(`${destination}.partial`)).rejects.toThrow();
        await expect(NodeFSP.stat(destination)).rejects.toThrow();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

async function installFixture(
  mode: "success" | "launch-failure" | "replace-failure",
  waitForParent = false,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 fork install "));
  const app = NodePath.join(directory, "Installed app.app");
  const candidate = NodePath.join(directory, "New app.app");
  const backup = NodePath.join(directory, "Backup app.app");
  const cache = NodePath.join(directory, "cache");
  const job = NodePath.join(cache, "jobs", "fixture");
  await NodeFSP.mkdir(job, { recursive: true });
  for (const bundle of [app, candidate]) {
    await NodeFSP.mkdir(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(bundle, "version"), bundle === app ? "old" : "new");
  }
  const token = "fixture-token";
  const release = NodePath.join(job, "release");
  await run("/usr/bin/mkfifo", [release]);
  await NodeFSP.writeFile(
    NodePath.join(job, "transaction.json"),
    JSON.stringify({ version, token }),
  );
  await NodeFSP.writeFile(
    NodePath.join(candidate, "Contents", "MacOS", "fixture"),
    mode === "launch-failure"
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\nreceipt=\${1#--t3-fork-update-receipt=}\nprintf '%s' '${version} ${token}' > "$receipt"\nread -r release < '${release}'\n`,
    { mode: 0o700 },
  );
  const noop = NodePath.join(directory, "noop");
  await NodeFSP.writeFile(noop, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let script = await NodeFSP.readFile(
    new URL("../../resources/fork-install.sh", import.meta.url),
    "utf8",
  );
  script = script
    .replaceAll("/usr/bin/codesign", `"${noop}"`)
    .replaceAll("/usr/bin/open", `"${noop}"`);
  if (mode === "replace-failure") {
    const move = NodePath.join(directory, "move");
    await NodeFSP.writeFile(
      move,
      '#!/bin/sh\ncase "$1" in *"New app.app") exit 1;; esac\nexec /bin/mv "$@"\n',
      { mode: 0o700 },
    );
    script = script.replace('/bin/mv "$candidate" "$app"', `"${move}" "$candidate" "$app"`);
  }
  const scriptPath = NodePath.join(job, "install.sh");
  await NodeFSP.writeFile(scriptPath, script);
  const parent = waitForParent ? NodeChildProcess.spawn("/bin/sleep", ["30"]) : null;
  const parentStarted = parent?.pid
    ? (await run("/bin/ps", ["-p", String(parent.pid), "-o", "lstart="])).stdout.replace(/\n$/, "")
    : "";
  const helper = NodeChildProcess.spawn(
    "/bin/sh",
    [
      scriptPath,
      app,
      candidate,
      backup,
      job,
      String(parent?.pid ?? 2147483647),
      parentStarted,
      "fixture",
      version,
      token,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  helper.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  helper.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const waiting = new Promise<void>((resolve, reject) => {
    helper.stdout.once("data", () => resolve());
    helper.once("error", reject);
  });
  const completion = new Promise<[number | null]>((resolve, reject) => {
    helper.once("exit", (code) => resolve([code]));
    helper.once("error", reject);
  });
  try {
    await waiting;
    if (parent) {
      expect(await NodeFSP.readFile(NodePath.join(app, "version"), "utf8")).toBe("old");
      parent.kill("SIGTERM");
    }
    const [code] = await completion;
    expect(code, output).toBe(mode === "success" ? 0 : 1);
    expect(await NodeFSP.readFile(NodePath.join(app, "version"), "utf8")).toBe(
      mode === "success" ? "new" : "old",
    );
    expect(await NodeFSP.readFile(NodePath.join(job, "status"), "utf8")).toBe(
      mode === "success" ? "complete\n" : "rolled-back\n",
    );
    if (mode === "success")
      expect(await NodeFSP.readFile(NodePath.join(backup, "version"), "utf8")).toBe("old");
    await acknowledgeForkUpdate(cache, version, [
      `--t3-fork-update-receipt=${NodePath.join(job, "receipt")}`,
      `--t3-fork-update-token=${token}`,
    ]);
    expect(await NodeFSP.readFile(NodePath.join(job, "receipt"), "utf8")).toBe(
      `${version} ${token}`,
    );
  } finally {
    parent?.kill("SIGTERM");
    // Keep the simulated app alive through startup, then release it without
    // sleeps or looking up processes to terminate.
    const pipe = await NodeFSP.open(
      release,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
    ).catch(() => null);
    if (pipe) {
      await pipe.write("exit\n");
      await pipe.close();
    }
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "independent Mac install helper",
  () => {
    it("waits for its known parent and replaces the isolated bundle", () =>
      installFixture("success", true));
    it("restores the original when launching fails", () => installFixture("launch-failure"));
    it("restores the original when replacing fails", () => installFixture("replace-failure"));
  },
);

it.skipIf(HostProcessPlatform.defaultValue() === "win32" || process.getuid?.() === 0)(
  "leaves an unwritable installation intact and offers a manual installer",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-permissions-"));
    const app = NodePath.join(directory, "installed.app");
    await NodeFSP.writeFile(app, "original");
    const { assertWritableInstallation } = await import("./ForkUpdateBackend.ts");
    try {
      await NodeFSP.chmod(directory, 0o500);
      await expect(
        assertWritableInstallation(app, "https://github.com/LaMarCab76/t3code/releases"),
      ).rejects.toThrow("Update manually using the installer");
      expect(await NodeFSP.readFile(app, "utf8")).toBe("original");
    } finally {
      await NodeFSP.chmod(directory, 0o700);
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it("acknowledges only the expected startup and reports a rollback once after restart", async () => {
  const cache = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-recovery-"));
  const job = NodePath.join(cache, "jobs", "fixture");
  await NodeFSP.mkdir(job, { recursive: true });
  const receipt = NodePath.join(job, "receipt");
  await NodeFSP.writeFile(
    NodePath.join(job, "transaction.json"),
    JSON.stringify({ version, token: "correct" }),
  );
  await NodeFSP.writeFile(NodePath.join(job, "status"), "rolled-back\n");
  const { readForkRecoveryNotice } = await import("./ForkUpdateBackend.ts");
  try {
    await acknowledgeForkUpdate(cache, version, [
      `--t3-fork-update-receipt=${receipt}`,
      "--t3-fork-update-token=wrong",
    ]);
    await expect(NodeFSP.stat(receipt)).rejects.toThrow();
    expect(await readForkRecoveryNotice(cache, "0.0.44-preview.20261001.7")).toContain(
      "original app was restored",
    );
    expect(await readForkRecoveryNotice(cache, "0.0.44-preview.20261001.7")).toBeNull();
    await acknowledgeForkUpdate(cache, version, [
      `--t3-fork-update-receipt=${receipt}`,
      "--t3-fork-update-token=correct",
    ]);
    expect(await NodeFSP.readFile(receipt, "utf8")).toBe(`${version} correct`);
  } finally {
    await NodeFSP.rm(cache, { recursive: true, force: true });
  }
});

it("detects a complete newer release and ignores old or incomplete releases, including cached checks", async () => {
  const manifest = manifestFixture();
  const tag = `fork-v${version}`;
  const assets = Object.values(manifest.files).flatMap((files) =>
    Object.values(files).map((file) => ({
      name: file.name,
      size: file.size,
      browser_download_url: forkAssetUrl(tag, file.name),
    })),
  );
  assets.push({
    name: "fork-update.json",
    size: 2000,
    browser_download_url: forkAssetUrl(tag, "fork-update.json"),
  });
  const release = { draft: false, tag_name: tag, assets, html_url: "", body: "A new version" };
  const requests: string[] = [];
  let apiChecks = 0;
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    requests.push(url);
    if (url.startsWith("https://api.github.com/repos/LaMarCab76/t3code/releases")) {
      apiChecks += 1;
      if (apiChecks === 2) {
        expect(options?.headers).toMatchObject({ "If-None-Match": "fixture-etag" });
        return new Response(null, { status: 304 });
      }
      return Response.json(
        [
          { ...release, tag_name: "fork-v0.0.44-preview.20261001.99", assets: [] },
          { ...release, draft: true },
          { ...release, tag_name: "fork-v0.0.44-preview.20260930.1", assets: [] },
          release,
        ],
        { headers: { etag: "fixture-etag" } },
      );
    }
    if (url === forkAssetUrl(tag, "fork-update.json")) return Response.json(manifest);
    throw new Error(`Unexpected request: ${url}`);
  });
  const available: string[] = [];
  const backend = new ForkUpdateBackend({
    currentVersion: "0.0.44-preview.20261001.7",
    arch: "arm64",
    resourcesPath: "/fixture",
    installationPath: "/fixture/app",
    cachePath: "/fixture/cache",
    quit: () => {},
  });
  backend.on("update-available", (info: { version: string }) => available.push(info.version));
  try {
    await backend.checkForUpdates();
    await backend.checkForUpdates();
    expect(available).toEqual([version, version]);
    expect(requests.filter((url) => url.endsWith("fork-update.json"))).toHaveLength(1);
    expect(requests.some((url) => url.includes("pingdotgg"))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
