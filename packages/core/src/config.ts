import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type AppMode = "development" | "desktop" | "server";

export interface InventoryConfig {
  appMode: AppMode;
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  mediaRoot: string;
  appOrigins: string[];
  setupToken: string | undefined;
  sessionSecret: string;
  secureCookies: boolean;
  staticRoot: string | undefined;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  protocol: "http" | "https";
  trustedProxy: boolean;
  lanOrigin: string | undefined;
  simulatePrinting: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export type InventoryConfigInput = Partial<InventoryConfig>;

const parsePort = (value: string | undefined): number => {
  const port = value ? Number(value) : 18473;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("PORT 必须是 1024 到 65535 之间的整数");
  }
  return port;
};

const parseAppMode = (value: unknown): AppMode => {
  const mode = value ?? "development";
  if (mode !== "development" && mode !== "desktop" && mode !== "server") throw new Error("APP_MODE 必须是 development、desktop 或 server");
  return mode;
};

const parseLogLevel = (value: unknown): InventoryConfig["logLevel"] => {
  const level = value ?? "info";
  if (!new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).has(String(level))) throw new Error("LOG_LEVEL 无效");
  return level as InventoryConfig["logLevel"];
};

export const loadConfig = (input: InventoryConfigInput = {}): InventoryConfig => {
  const dataDir = resolve(input.dataDir ?? process.env.IH_DATA_DIR ?? process.env.INVENTORY_DATA_DIR ?? resolve(process.cwd(), ".inventory-hub"));
  const mediaRoot = resolve(input.mediaRoot ?? process.env.IH_MEDIA_ROOT ?? process.env.MEDIA_ROOT ?? resolve(dataDir, "media-root"));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const appMode = parseAppMode(input.appMode ?? process.env.IH_APP_MODE ?? process.env.APP_MODE);
  const originText = process.env.IH_APP_ORIGIN ?? process.env.APP_ORIGIN;
  const origins = input.appOrigins ?? (originText ? originText.split(",").map((v) => v.trim()).filter(Boolean) : []);
  const tlsCertPath = input.tlsCertPath ?? process.env.IH_TLS_CERT_PATH ?? process.env.TLS_CERT_PATH;
  const tlsKeyPath = input.tlsKeyPath ?? process.env.IH_TLS_KEY_PATH ?? process.env.TLS_KEY_PATH;
  const lanOrigin = parseLanOrigin(input.lanOrigin ?? process.env.IH_LAN_ORIGIN);
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) throw new Error("TLS 证书和私钥路径必须成对提供");
  const configuredSessionSecret = input.sessionSecret ?? process.env.IH_SESSION_SECRET ?? process.env.SESSION_SECRET;
  const sessionSecret = configuredSessionSecret ?? (appMode === "server" ? undefined : loadOrCreateLocalSessionSecret(dataDir));
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("会话密钥必须至少包含 32 个字符");
  if (appMode === "server" && /^replace-/i.test(sessionSecret)) throw new Error("服务器模式必须设置真实的 IH_SESSION_SECRET，不能使用示例占位值");
  return {
    appMode,
    host: input.host ?? process.env.IH_HOST ?? process.env.HOST ?? "127.0.0.1",
    port: input.port ?? parsePort(process.env.IH_PORT ?? process.env.PORT),
    dataDir,
    databasePath: resolve(input.databasePath ?? process.env.IH_DATABASE_PATH ?? process.env.DATABASE_PATH ?? resolve(dataDir, "inventory.sqlite")),
    mediaRoot,
    appOrigins: origins,
    setupToken: input.setupToken ?? process.env.IH_SETUP_TOKEN ?? process.env.SETUP_TOKEN,
    sessionSecret,
    secureCookies: input.secureCookies ?? (process.env.IH_SECURE_COOKIES ?? process.env.SECURE_COOKIES ? (process.env.IH_SECURE_COOKIES ?? process.env.SECURE_COOKIES) === "true" : Boolean(tlsCertPath)),
    staticRoot: input.staticRoot ?? process.env.IH_WEB_DIST_PATH ?? process.env.STATIC_ROOT,
    tlsCertPath,
    tlsKeyPath,
    protocol: tlsCertPath && tlsKeyPath ? "https" : "http",
    trustedProxy: input.trustedProxy ?? (process.env.IH_TRUST_PROXY ? process.env.IH_TRUST_PROXY === "true" : appMode === "server"),
    lanOrigin,
    simulatePrinting: input.simulatePrinting ?? (process.env.IH_PRINT_MODE ?? process.env.PRINT_MODE) !== "native",
    logLevel: parseLogLevel(input.logLevel ?? process.env.IH_LOG_LEVEL ?? process.env.LOG_LEVEL),
  };
};

function loadOrCreateLocalSessionSecret(dataDir: string): string {
  const secretPath = resolve(dataDir, "session-secret");
  const readSecret = (): string => {
    const value = readFileSync(secretPath, "utf8").trim();
    if (value.length < 32) throw new Error("本地会话密钥文件无效");
    chmodSync(secretPath, 0o600);
    return value;
  };

  try {
    return readSecret();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("hex");
  try {
    writeFileSync(secretPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readSecret();
  }
}

function parseLanOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("IH_LAN_ORIGIN 必须是无路径、无凭据的 HTTPS 地址");
  }
  return url.origin;
}
