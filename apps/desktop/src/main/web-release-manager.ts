import { BrowserWindow, dialog, net } from "electron";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { WebReleaseStatus, WebReleaseSummary } from "../shared/contracts";

const PACKAGE_FORMAT = "inventory-hub-web-package";
const PACKAGE_FORMAT_VERSION = 1;
const DESKTOP_API_VERSION = 1;
const CORE_API_VERSION = 1;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 300 * 1024 * 1024;
const MAX_FILE_COUNT = 5_000;
const RELEASES_URL = "https://api.github.com/repos/ChristineZhiMei/inventory-hub/releases?per_page=30";
const PACKAGE_ASSET_PATTERN = /^inventory-hub-web-(\d+\.\d+\.\d+)\.ihweb$/;
const METADATA_ASSET_PATTERN = /^inventory-hub-web-(\d+\.\d+\.\d+)\.json$/;

interface WebPackageFile {
  path: string;
  size: number;
  sha256: string;
  content: string;
}

interface WebPackageManifest {
  format: typeof PACKAGE_FORMAT;
  formatVersion: number;
  uiVersion: string;
  createdAt: string;
  minDesktopVersion: string;
  desktopApiVersion: number;
  coreApiVersion: number;
  releaseNotes?: string;
  clientDownloadUrl?: string;
  fileCount: number;
  payloadSha256: string;
}

interface WebPackageEnvelope {
  manifest: WebPackageManifest;
  files: WebPackageFile[];
}

interface PersistedWebReleaseState {
  activeVersion?: string;
  previousVersion?: string;
  pendingVersion?: string;
  activationAttempts?: number;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

interface AvailableRelease extends WebReleaseSummary {
  packageUrl: string;
  packageSize: number;
}

type StatusListener = (status: WebReleaseStatus) => void;

export class WebReleaseManager {
  private readonly root: string;
  private readonly statePath: string;
  private readonly bundledPath: string;
  private readonly bundledVersion: string;
  private readonly desktopVersion: string;
  private state: PersistedWebReleaseState;
  private available: AvailableRelease | undefined;
  private phase: WebReleaseStatus["phase"] = "idle";
  private message: string | undefined;
  private downloadProgress: number | undefined;
  private readonly listeners = new Set<StatusListener>();
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(options: {
    userDataPath: string;
    bundledPath: string;
    bundledVersion: string;
    desktopVersion: string;
  }) {
    this.root = join(options.userDataPath, "web-releases");
    this.statePath = join(options.userDataPath, "config", "web-releases.json");
    this.bundledPath = options.bundledPath;
    this.bundledVersion = normalizeVersion(options.bundledVersion);
    this.desktopVersion = normalizeVersion(options.desktopVersion);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.state = this.readState();
  }

  prepareStartup(): void {
    if (!this.state.pendingVersion) return;
    const attempts = (this.state.activationAttempts ?? 0) + 1;
    if (attempts > 1) {
      this.rollbackPendingActivation();
      return;
    }
    this.state.activationAttempts = attempts;
    this.writeState();
  }

  getActiveWebPath(): string {
    const version = this.state.activeVersion;
    if (!version) return this.bundledPath;
    const path = this.versionPath(version);
    if (existsSync(join(path, "index.html"))) return path;
    this.state = {};
    this.writeState();
    return this.bundledPath;
  }

  get status(): WebReleaseStatus {
    const currentVersion = this.state.activeVersion ?? this.bundledVersion;
    const pending = this.state.pendingVersion
      ? this.readInstalledSummary(this.state.pendingVersion)
      : undefined;
    return {
      phase: this.phase,
      currentVersion,
      bundledVersion: this.bundledVersion,
      source: this.state.activeVersion ? "imported" : "bundled",
      ...(this.available ? { available: publicSummary(this.available) } : {}),
      ...(pending ? { pending } : {}),
      ...(this.downloadProgress !== undefined ? { downloadProgress: this.downloadProgress } : {}),
      ...(this.message ? { message: this.message } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async selectAndImport(owner: BrowserWindow): Promise<WebReleaseStatus> {
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 Inventory Hub 界面资源包",
      buttonLabel: "导入资源包",
      properties: ["openFile"],
      filters: [{ name: "Inventory Hub 界面资源包", extensions: ["ihweb"] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return this.status;
    return this.importPackage(path);
  }

  async checkForUpdate(): Promise<WebReleaseStatus> {
    this.setStatus("checking");
    try {
      const response = await net.fetch(RELEASES_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Inventory-Hub/${this.desktopVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        bypassCustomProtocolHandlers: true,
      });
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
      const releases = (await response.json()) as GitHubRelease[];
      this.available = await this.resolveLatestRelease(releases);
      if (!this.available) this.setStatus("idle", "当前已是最新界面版本");
      else if (!this.available.compatible) {
        this.setStatus("incompatible", `界面 ${this.available.version} 需要更新客户端`);
      } else this.setStatus("available", `发现界面更新 ${this.available.version}`);
    } catch (error) {
      this.setStatus("failed", humanizeReleaseError(error));
    }
    return this.status;
  }

  async downloadAvailable(): Promise<WebReleaseStatus> {
    if (!this.available) await this.checkForUpdate();
    if (!this.available) throw new Error("WEB_RELEASE_NOT_AVAILABLE");
    if (!this.available.compatible) throw new Error("WEB_RELEASE_REQUIRES_DESKTOP_UPDATE");
    if (this.available.packageSize > MAX_PACKAGE_BYTES) throw new Error("WEB_RELEASE_PACKAGE_TOO_LARGE");
    this.setStatus("downloading", `正在下载界面 ${this.available.version}`, 0);
    const response = await net.fetch(this.available.packageUrl, {
      headers: { "User-Agent": `Inventory-Hub/${this.desktopVersion}` },
      bypassCustomProtocolHandlers: true,
    });
    if (!response.ok) throw new Error(`WEB_RELEASE_DOWNLOAD_FAILED_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PACKAGE_BYTES) throw new Error("WEB_RELEASE_PACKAGE_TOO_LARGE");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("WEB_RELEASE_PACKAGE_TOO_LARGE");
    this.setStatus("importing", `正在校验界面 ${this.available.version}`, 100);
    return this.importBuffer(bytes);
  }

  activatePending(): void {
    const version = this.state.pendingVersion;
    if (!version) throw new Error("WEB_RELEASE_NOT_READY");
    const summary = this.readInstalledSummary(version);
    if (!summary?.compatible) throw new Error("WEB_RELEASE_REQUIRES_DESKTOP_UPDATE");
    const previousVersion = this.state.activeVersion;
    this.state = {
      activeVersion: version,
      ...(previousVersion ? { previousVersion } : {}),
      pendingVersion: version,
      activationAttempts: 0,
    };
    this.writeState();
    this.setStatus("applying", `正在应用界面 ${version}`);
  }

  restoreBundled(): void {
    this.state = {
      ...(this.state.activeVersion ? { previousVersion: this.state.activeVersion } : {}),
      pendingVersion: this.bundledVersion,
      activationAttempts: 0,
    };
    this.writeState();
    this.setStatus("applying", "正在恢复内置界面");
  }

  markReady(): void {
    if (!this.state.pendingVersion) return;
    if (this.state.pendingVersion === this.bundledVersion) this.state = {};
    else {
      delete this.state.pendingVersion;
      delete this.state.activationAttempts;
    }
    this.writeState();
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.setStatus("idle");
  }

  armHealthTimeout(onFailure: () => void): void {
    if (!this.state.pendingVersion) return;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined;
      this.rollbackPendingActivation();
      onFailure();
    }, 15_000);
  }

  rollbackPendingActivation(): void {
    const fallback = this.state.previousVersion;
    this.state = fallback && existsSync(join(this.versionPath(fallback), "index.html"))
      ? { activeVersion: fallback }
      : {};
    this.writeState();
    this.setStatus("failed", "新版界面未能正常启动，已恢复上一版本");
  }

  private importPackage(path: string): WebReleaseStatus {
    const stats = statSync(path);
    if (!stats.isFile() || extname(path).toLowerCase() !== ".ihweb") {
      throw new Error("WEB_RELEASE_INVALID_FILE");
    }
    if (stats.size > MAX_PACKAGE_BYTES) throw new Error("WEB_RELEASE_PACKAGE_TOO_LARGE");
    this.setStatus("importing", "正在校验界面资源包");
    return this.importBuffer(readFileSync(path));
  }

  private importBuffer(buffer: Buffer): WebReleaseStatus {
    let envelope: WebPackageEnvelope;
    try {
      const expanded = gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES });
      envelope = JSON.parse(expanded.toString("utf8")) as WebPackageEnvelope;
    } catch (error) {
      this.setStatus("failed", "资源包损坏或格式不受支持");
      throw new Error(`WEB_RELEASE_INVALID_PACKAGE: ${String(error)}`);
    }
    const summary = this.validateEnvelope(envelope);
    if (!summary.compatible) {
      this.setStatus("incompatible", `界面 ${summary.version} 需要客户端 ${summary.minDesktopVersion} 或更高版本`);
      throw new Error("WEB_RELEASE_REQUIRES_DESKTOP_UPDATE");
    }
    const target = this.versionPath(summary.version);
    const staging = join(this.root, `.staging-${summary.version}-${randomBytes(6).toString("hex")}`);
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    try {
      for (const file of envelope.files) {
        const destination = resolve(staging, file.path);
        if (!destination.startsWith(`${staging}${sep}`)) throw new Error("WEB_RELEASE_INVALID_PATH");
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, Buffer.from(file.content, "base64"), { mode: 0o600 });
      }
      writeFileSync(join(staging, ".inventory-hub-web.json"), `${JSON.stringify(envelope.manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    this.state.pendingVersion = summary.version;
    this.state.activationAttempts = 0;
    this.writeState();
    this.setStatus("ready", `界面 ${summary.version} 已准备好`);
    return this.status;
  }

  private validateEnvelope(envelope: WebPackageEnvelope): WebReleaseSummary {
    const manifest = envelope?.manifest;
    if (
      manifest?.format !== PACKAGE_FORMAT ||
      manifest.formatVersion !== PACKAGE_FORMAT_VERSION ||
      !Array.isArray(envelope.files) ||
      envelope.files.length === 0 ||
      envelope.files.length > MAX_FILE_COUNT ||
      envelope.files.length !== manifest.fileCount
    ) throw new Error("WEB_RELEASE_INVALID_MANIFEST");
    const version = normalizeVersion(manifest.uiVersion);
    const minDesktopVersion = normalizeVersion(manifest.minDesktopVersion);
    const seen = new Set<string>();
    let expandedBytes = 0;
    for (const file of envelope.files) {
      if (!safeRelativePath(file.path) || seen.has(file.path)) throw new Error("WEB_RELEASE_INVALID_PATH");
      seen.add(file.path);
      const content = Buffer.from(file.content, "base64");
      expandedBytes += content.byteLength;
      if (content.byteLength !== file.size || createHash("sha256").update(content).digest("hex") !== file.sha256) {
        throw new Error("WEB_RELEASE_FILE_CHECKSUM_MISMATCH");
      }
    }
    if (expandedBytes > MAX_EXPANDED_BYTES || !seen.has("index.html")) throw new Error("WEB_RELEASE_INVALID_CONTENTS");
    if (digestFileIndex(envelope.files) !== manifest.payloadSha256) throw new Error("WEB_RELEASE_PAYLOAD_CHECKSUM_MISMATCH");
    return {
      version,
      minDesktopVersion,
      compatible:
        compareVersions(this.desktopVersion, minDesktopVersion) >= 0 &&
        manifest.desktopApiVersion === DESKTOP_API_VERSION &&
        manifest.coreApiVersion === CORE_API_VERSION,
      ...(manifest.releaseNotes ? { releaseNotes: manifest.releaseNotes } : {}),
      ...(manifest.clientDownloadUrl ? { clientDownloadUrl: manifest.clientDownloadUrl } : {}),
    };
  }

  private async resolveLatestRelease(releases: GitHubRelease[]): Promise<AvailableRelease | undefined> {
    const current = this.state.activeVersion ?? this.bundledVersion;
    const candidates = releases
      .filter((release) => !release.draft && !release.prerelease)
      .flatMap((release) => {
        const packageAsset = release.assets.find((asset) => PACKAGE_ASSET_PATTERN.test(asset.name));
        if (!packageAsset) return [];
        const version = PACKAGE_ASSET_PATTERN.exec(packageAsset.name)?.[1];
        const metadataAsset = release.assets.find((asset) => METADATA_ASSET_PATTERN.exec(asset.name)?.[1] === version);
        return version && metadataAsset ? [{ version, packageAsset, metadataAsset }] : [];
      })
      .filter((candidate) => compareVersions(candidate.version, current) > 0)
      .sort((left, right) => compareVersions(right.version, left.version));
    for (const candidate of candidates) {
      const response = await net.fetch(candidate.metadataAsset.browser_download_url, {
        headers: { "User-Agent": `Inventory-Hub/${this.desktopVersion}` },
        bypassCustomProtocolHandlers: true,
      });
      if (!response.ok) continue;
      const manifest = (await response.json()) as WebPackageManifest;
      if (normalizeVersion(manifest.uiVersion) !== candidate.version) continue;
      return {
        version: candidate.version,
        minDesktopVersion: normalizeVersion(manifest.minDesktopVersion),
        compatible:
          compareVersions(this.desktopVersion, manifest.minDesktopVersion) >= 0 &&
          manifest.desktopApiVersion === DESKTOP_API_VERSION &&
          manifest.coreApiVersion === CORE_API_VERSION,
        packageUrl: candidate.packageAsset.browser_download_url,
        packageSize: candidate.packageAsset.size,
        ...(manifest.releaseNotes ? { releaseNotes: manifest.releaseNotes } : {}),
        ...(manifest.clientDownloadUrl ? { clientDownloadUrl: manifest.clientDownloadUrl } : {}),
      };
    }
    return undefined;
  }

  private readInstalledSummary(version: string): WebReleaseSummary | undefined {
    if (version === this.bundledVersion) return { version, minDesktopVersion: this.desktopVersion, compatible: true };
    try {
      const manifest = JSON.parse(readFileSync(join(this.versionPath(version), ".inventory-hub-web.json"), "utf8")) as WebPackageManifest;
      return {
        version,
        minDesktopVersion: normalizeVersion(manifest.minDesktopVersion),
        compatible: true,
        ...(manifest.releaseNotes ? { releaseNotes: manifest.releaseNotes } : {}),
        ...(manifest.clientDownloadUrl ? { clientDownloadUrl: manifest.clientDownloadUrl } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private versionPath(version: string): string {
    return join(this.root, normalizeVersion(version));
  }

  private setStatus(phase: WebReleaseStatus["phase"], message?: string, downloadProgress?: number): void {
    this.phase = phase;
    this.message = message;
    this.downloadProgress = downloadProgress;
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }

  private readState(): PersistedWebReleaseState {
    if (!existsSync(this.statePath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedWebReleaseState;
      return {
        ...(value.activeVersion ? { activeVersion: normalizeVersion(value.activeVersion) } : {}),
        ...(value.previousVersion ? { previousVersion: normalizeVersion(value.previousVersion) } : {}),
        ...(value.pendingVersion ? { pendingVersion: normalizeVersion(value.pendingVersion) } : {}),
        ...(Number.isInteger(value.activationAttempts) ? { activationAttempts: value.activationAttempts } : {}),
      };
    } catch {
      return {};
    }
  }

  private writeState(): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
}

function publicSummary(release: AvailableRelease): WebReleaseSummary {
  return {
    version: release.version,
    minDesktopVersion: release.minDesktopVersion,
    compatible: release.compatible,
    ...(release.releaseNotes ? { releaseNotes: release.releaseNotes } : {}),
    ...(release.clientDownloadUrl ? { clientDownloadUrl: release.clientDownloadUrl } : {}),
  };
}

function normalizeVersion(value: string): string {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`INVALID_VERSION: ${value}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function safeRelativePath(path: string): boolean {
  if (!path || path.length > 240 || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
  return !path.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function digestFileIndex(files: WebPackageFile[]): string {
  const index = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
    .join("");
  return createHash("sha256").update(index).digest("hex");
}

function humanizeReleaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Failed to fetch") || message.includes("ERR_INTERNET")) return "当前无法连接 GitHub";
  return `检查界面更新失败：${message}`;
}
