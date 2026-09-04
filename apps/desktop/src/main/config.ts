import { app } from "electron";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_SERVICE_PORT = 18_473;

interface PersistedDesktopConfig {
  servicePort: number;
  remoteUrl?: string;
  lanEnabled?: boolean;
  lanHost?: string;
  lanOrigin?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

export interface DesktopRuntimeConfig {
  mode: "desktop" | "remote";
  servicePort: number;
  serviceOrigin: string;
  appOrigins: string[];
  webUrl: string;
  bindHost: string;
  lanEnabled: boolean;
  databaseDir: string;
  dataDir: string;
  mediaDir: string;
  logDir: string;
  webDistPath: string;
  remoteUrl?: string;
  lanOrigin?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`IH_PORT must be an integer between 1024 and 65535; received ${value}`);
  }
  return port;
}

function parseRemoteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("INVENTORY_HUB_REMOTE_URL must be an HTTPS URL without embedded credentials");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export class DesktopConfigStore {
  private readonly configPath: string;

  constructor() {
    this.configPath = join(app.getPath("userData"), "config", "desktop.json");
  }

  loadRuntimeConfig(): DesktopRuntimeConfig {
    const persisted = this.readPersisted();
    const remoteUrl = parseRemoteUrl(
      process.env.INVENTORY_HUB_REMOTE_URL ?? persisted.remoteUrl,
    );
    const servicePort = parsePort(process.env.IH_PORT) ?? persisted.servicePort;
    const lanEnabled = (process.env.IH_LAN_ENABLED ?? String(persisted.lanEnabled ?? false)) === "true";
    const bindHost = lanEnabled ? process.env.IH_HOST ?? persisted.lanHost ?? "0.0.0.0" : "127.0.0.1";
    const lanOrigin = lanEnabled
      ? parseLanOrigin(process.env.IH_LAN_ORIGIN ?? persisted.lanOrigin, servicePort)
      : undefined;
    const tlsCertPath = lanEnabled ? process.env.IH_TLS_CERT_PATH ?? persisted.tlsCertPath : undefined;
    const tlsKeyPath = lanEnabled ? process.env.IH_TLS_KEY_PATH ?? persisted.tlsKeyPath : undefined;
    if (lanEnabled && (!tlsCertPath || !tlsKeyPath || !existsSync(tlsCertPath) || !existsSync(tlsKeyPath))) {
      throw new Error("LAN HTTPS requires readable IH_TLS_CERT_PATH and IH_TLS_KEY_PATH files");
    }
    if (tlsCertPath && tlsKeyPath) {
      accessSync(tlsCertPath, constants.R_OK);
      accessSync(tlsKeyPath, constants.R_OK);
    }
    const userData = app.getPath("userData");
    const serviceOrigin = remoteUrl ?? `${lanEnabled ? "https" : "http"}://127.0.0.1:${servicePort}`;
    const developmentUrl = process.env.INVENTORY_HUB_DESKTOP_DEV_URL;

    if (developmentUrl) {
      const url = new URL(developmentUrl);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
        throw new Error("INVENTORY_HUB_DESKTOP_DEV_URL must use http://127.0.0.1 on a custom port");
      }
    }

    const webUrl = remoteUrl ?? developmentUrl ?? serviceOrigin;
    const appOrigins = [...new Set([new URL(webUrl).origin, serviceOrigin, ...(lanOrigin ? [lanOrigin] : [])])];
    const config: DesktopRuntimeConfig = {
      mode: remoteUrl ? "remote" : "desktop",
      servicePort,
      serviceOrigin,
      appOrigins,
      webUrl,
      bindHost,
      lanEnabled,
      databaseDir: join(userData, "database"),
      dataDir: userData,
      mediaDir: join(userData, "media"),
      logDir: app.getPath("logs"),
      webDistPath: join(process.resourcesPath, "web"),
    };
    if (remoteUrl) config.remoteUrl = remoteUrl;
    if (lanOrigin) config.lanOrigin = lanOrigin;
    if (tlsCertPath) config.tlsCertPath = tlsCertPath;
    if (tlsKeyPath) config.tlsKeyPath = tlsKeyPath;
    return config;
  }

  ensureRuntimeDirectories(config: DesktopRuntimeConfig): void {
    if (config.mode === "remote") return;
    for (const path of [config.databaseDir, config.dataDir, config.mediaDir, config.logDir]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  }

  save(config: PersistedDesktopConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.configPath);
  }

  private readPersisted(): PersistedDesktopConfig {
    if (!existsSync(this.configPath)) {
      const initial = { servicePort: DEFAULT_SERVICE_PORT };
      this.save(initial);
      return initial;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<PersistedDesktopConfig>;
      return {
        servicePort: parsePort(String(parsed.servicePort ?? DEFAULT_SERVICE_PORT)) ?? DEFAULT_SERVICE_PORT,
        ...(parsed.remoteUrl ? { remoteUrl: parsed.remoteUrl } : {}),
        ...(typeof parsed.lanEnabled === "boolean" ? { lanEnabled: parsed.lanEnabled } : {}),
        ...(parsed.lanHost ? { lanHost: parsed.lanHost } : {}),
        ...(parsed.lanOrigin ? { lanOrigin: parsed.lanOrigin } : {}),
        ...(parsed.tlsCertPath ? { tlsCertPath: parsed.tlsCertPath } : {}),
        ...(parsed.tlsKeyPath ? { tlsKeyPath: parsed.tlsKeyPath } : {}),
      };
    } catch (error) {
      throw new Error(`Desktop configuration is invalid: ${String(error)}`);
    }
  }
}

function parseLanOrigin(value: string | undefined, servicePort: number): string {
  if (!value) throw new Error("IH_LAN_ORIGIN is required when LAN access is enabled");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("IH_LAN_ORIGIN must be an HTTPS origin without a path or credentials");
  }
  if (url.port !== String(servicePort)) {
    throw new Error(`IH_LAN_ORIGIN must use the configured service port ${servicePort}`);
  }
  return url.origin;
}
