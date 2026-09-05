import { app } from "electron";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureLanCertificateBundle } from "./lan-certificate";

const DEFAULT_SERVICE_PORT = 18_473;

interface PersistedDesktopConfig {
  servicePort: number;
  remoteUrl?: string;
  lanEnabled?: boolean;
  lanHost?: string;
  lanPort?: number;
  certificatePort?: number;
  lanOrigin?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  caCertPath?: string;
  caFingerprint?: string;
  managedLanCertificate?: boolean;
}

export interface DesktopRuntimeConfig {
  mode: "desktop" | "remote";
  servicePort: number;
  serviceOrigin: string;
  appOrigins: string[];
  webUrl: string;
  bindHost: string;
  lanEnabled: boolean;
  lanPort?: number;
  certificatePort?: number;
  databaseDir: string;
  dataDir: string;
  mediaDir: string;
  logDir: string;
  webDistPath: string;
  remoteUrl?: string;
  lanOrigin?: string;
  certificateInstallUrl?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  caCertPath?: string;
  caFingerprint?: string;
  lanAddresses?: string[];
}

function parsePort(value: string | undefined, name = "IH_PORT"): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1024 and 65535; received ${value}`);
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
    let persisted = this.readPersisted();
    const remoteUrl = parseRemoteUrl(
      process.env.INVENTORY_HUB_REMOTE_URL ?? persisted.remoteUrl,
    );
    const servicePort = parsePort(process.env.IH_PORT) ?? persisted.servicePort;
    const lanEnabled = !remoteUrl && (process.env.IH_LAN_ENABLED ?? String(persisted.lanEnabled ?? false)) === "true";
    const bindHost = lanEnabled ? process.env.IH_HOST ?? persisted.lanHost ?? "0.0.0.0" : "127.0.0.1";
    const lanPort = lanEnabled
      ? parsePort(process.env.IH_LAN_PORT, "IH_LAN_PORT") ?? persisted.lanPort ?? auxiliaryPort(servicePort, 2)
      : undefined;
    const certificatePort = lanEnabled
      ? parsePort(process.env.IH_CERTIFICATE_PORT, "IH_CERTIFICATE_PORT") ?? persisted.certificatePort ?? auxiliaryPort(servicePort, 1)
      : undefined;
    if (lanEnabled && (lanPort === servicePort || certificatePort === servicePort || certificatePort === lanPort)) {
      throw new Error("LAN HTTPS、证书安装和本机服务必须使用不同端口");
    }
    const usesManagedCertificate = lanEnabled
      && !process.env.IH_TLS_CERT_PATH
      && !process.env.IH_TLS_KEY_PATH
      && (persisted.managedLanCertificate || !persisted.tlsCertPath || !persisted.tlsKeyPath);
    if (usesManagedCertificate) {
      const bundle = ensureLanCertificateBundle(app.getPath("userData"));
      persisted = {
        ...persisted,
        lanEnabled: true,
        lanHost: bindHost,
        lanPort: lanPort!,
        certificatePort: certificatePort!,
        lanOrigin: `https://${bundle.primaryAddress}:${lanPort}`,
        tlsCertPath: bundle.tlsCertPath,
        tlsKeyPath: bundle.tlsKeyPath,
        caCertPath: bundle.caCertPath,
        caFingerprint: bundle.caFingerprint,
        managedLanCertificate: true,
      };
      this.save(persisted);
    }
    const lanOrigin = lanEnabled
      ? parseLanOrigin(process.env.IH_LAN_ORIGIN ?? persisted.lanOrigin, lanPort!)
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
    const serviceOrigin = remoteUrl ?? `http://127.0.0.1:${servicePort}`;
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
      ...(lanPort ? { lanPort } : {}),
      ...(certificatePort ? { certificatePort } : {}),
      databaseDir: join(userData, "database"),
      dataDir: userData,
      mediaDir: join(userData, "media"),
      logDir: app.getPath("logs"),
      webDistPath: join(process.resourcesPath, "web"),
    };
    if (remoteUrl) config.remoteUrl = remoteUrl;
    if (lanOrigin) config.lanOrigin = lanOrigin;
    if (lanOrigin && certificatePort) {
      config.certificateInstallUrl = `http://${new URL(lanOrigin).hostname}:${certificatePort}/install`;
    }
    if (tlsCertPath) config.tlsCertPath = tlsCertPath;
    if (tlsKeyPath) config.tlsKeyPath = tlsKeyPath;
    if (persisted.caCertPath) config.caCertPath = persisted.caCertPath;
    if (persisted.caFingerprint) config.caFingerprint = persisted.caFingerprint;
    if (persisted.managedLanCertificate) {
      config.lanAddresses = ensureLanCertificateBundle(userData).addresses;
    }
    return config;
  }

  ensureRuntimeDirectories(config: DesktopRuntimeConfig): void {
    if (config.mode === "remote") return;
    for (const path of [config.databaseDir, config.dataDir, config.mediaDir, config.logDir]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  }

  setLanEnabled(enabled: boolean): void {
    if (process.env.IH_LAN_ENABLED !== undefined) {
      throw new Error("LAN_CONFIGURATION_MANAGED_BY_ENVIRONMENT");
    }
    const persisted = this.readPersisted();
    if (!enabled) {
      this.save({ ...persisted, lanEnabled: false });
      return;
    }
    const servicePort = parsePort(process.env.IH_PORT) ?? persisted.servicePort;
    const lanPort = persisted.lanPort ?? auxiliaryPort(servicePort, 2);
    const certificatePort = persisted.certificatePort ?? auxiliaryPort(servicePort, 1);
    const bundle = ensureLanCertificateBundle(app.getPath("userData"));
    this.save({
      ...persisted,
      lanEnabled: true,
      lanHost: "0.0.0.0",
      lanPort,
      certificatePort,
      lanOrigin: `https://${bundle.primaryAddress}:${lanPort}`,
      tlsCertPath: bundle.tlsCertPath,
      tlsKeyPath: bundle.tlsKeyPath,
      caCertPath: bundle.caCertPath,
      caFingerprint: bundle.caFingerprint,
      managedLanCertificate: true,
    });
  }

  getLanPorts(): { https: number; certificate: number } {
    const persisted = this.readPersisted();
    const servicePort = parsePort(process.env.IH_PORT) ?? persisted.servicePort;
    return {
      https: persisted.lanPort ?? auxiliaryPort(servicePort, 2),
      certificate: persisted.certificatePort ?? auxiliaryPort(servicePort, 1),
    };
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
        ...(parsed.lanPort ? { lanPort: parsed.lanPort } : {}),
        ...(parsed.certificatePort ? { certificatePort: parsed.certificatePort } : {}),
        ...(parsed.lanOrigin ? { lanOrigin: parsed.lanOrigin } : {}),
        ...(parsed.tlsCertPath ? { tlsCertPath: parsed.tlsCertPath } : {}),
        ...(parsed.tlsKeyPath ? { tlsKeyPath: parsed.tlsKeyPath } : {}),
        ...(parsed.caCertPath ? { caCertPath: parsed.caCertPath } : {}),
        ...(parsed.caFingerprint ? { caFingerprint: parsed.caFingerprint } : {}),
        ...(typeof parsed.managedLanCertificate === "boolean" ? { managedLanCertificate: parsed.managedLanCertificate } : {}),
      };
    } catch (error) {
      throw new Error(`Desktop configuration is invalid: ${String(error)}`);
    }
  }
}

function parseLanOrigin(value: string | undefined, lanPort: number): string {
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
  if (url.port !== String(lanPort)) {
    throw new Error(`IH_LAN_ORIGIN must use the configured LAN HTTPS port ${lanPort}`);
  }
  return url.origin;
}

function auxiliaryPort(servicePort: number, offset: number): number {
  const port = servicePort + offset;
  if (port > 65_535) throw new Error("本机服务端口过高，无法分配局域网辅助端口");
  return port;
}
