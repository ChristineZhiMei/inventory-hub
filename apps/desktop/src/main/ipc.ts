import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { homedir } from "node:os";
import { parse } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { accessSync, constants, lstatSync, realpathSync, statfsSync } from "node:fs";
import type { DesktopConfigStore, DesktopRuntimeConfig } from "./config";
import { listPrinterSummaries, printLabel } from "./printing";
import { applyAndPublishPrintPreferences } from "./native-print-settings";
import type { CoreServiceSupervisor } from "./service-supervisor";
import type {
  DesktopEnvironment,
  LanConfigurationResult,
  ManagedPathKind,
  MediaDirectoryValidation,
  LocalPrintPreferences,
  PrintLabelRequest,
  SelectedDirectory,
} from "../shared/contracts";
import type { WebReleaseManager } from "./web-release-manager";

const SELECTION_LIFETIME_MS = 10 * 60 * 1_000;

interface DirectoryGrant {
  path: string;
  senderId: number;
  expiresAt: number;
}

export function registerDesktopIpc(options: {
  getMainWindow: () => BrowserWindow | null;
  config: DesktopRuntimeConfig;
  configStore: DesktopConfigStore;
  service: CoreServiceSupervisor;
  webReleases: WebReleaseManager;
  applyWebRelease: () => void;
  restoreBundledWebRelease: () => void;
}): () => void {
  const {
    getMainWindow,
    config,
    configStore,
    service,
    webReleases,
    applyWebRelease,
    restoreBundledWebRelease,
  } = options;
  const grants = new Map<string, DirectoryGrant>();
  const channels: string[] = [];

  const handle = <T extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args: T) => {
      assertTrustedSender(event, getMainWindow(), config.webUrl);
      return listener(event, ...args);
    });
  };

  handle("desktop:get-environment", (): DesktopEnvironment => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mode: config.mode,
    serviceOrigin: config.serviceOrigin,
    lanEnabled: config.lanEnabled,
    ...(config.lanOrigin ? { lanOrigin: config.lanOrigin } : {}),
    ...(config.certificateInstallUrl ? { certificateInstallUrl: config.certificateInstallUrl } : {}),
    ...(config.caFingerprint ? { caFingerprint: config.caFingerprint } : {}),
    ...(config.lanAddresses ? { lanAddresses: config.lanAddresses } : {}),
    userDataPath: app.getPath("userData"),
  }));
  handle("desktop:get-service-status", () => service.status);
  handle("desktop:get-web-release-status", () => webReleases.status);
  handle("desktop:check-web-release-update", () => webReleases.checkForUpdate());
  handle("desktop:select-web-release-package", async () => {
    const window = getMainWindow();
    if (!window) throw new Error("WINDOW_UNAVAILABLE");
    return webReleases.selectAndImport(window);
  });
  handle("desktop:download-web-release-update", () => webReleases.downloadAvailable());
  handle("desktop:apply-web-release", () => {
    applyWebRelease();
    return { restartScheduled: true };
  });
  handle("desktop:restore-bundled-web-release", () => {
    restoreBundledWebRelease();
    return { restartScheduled: true };
  });
  handle("desktop:open-web-release-client-download", async (_event, value: string) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/ChristineZhiMei/inventory-hub/")) {
      throw new Error("INVALID_CLIENT_DOWNLOAD_URL");
    }
    await shell.openExternal(url.toString());
  });
  handle("desktop:report-web-release-ready", () => webReleases.markReady());
  handle("desktop:set-lan-enabled", async (_event, enabled: boolean): Promise<LanConfigurationResult> => {
    if (typeof enabled !== "boolean") throw new Error("INVALID_LAN_ENABLED_VALUE");
    if (enabled && !config.lanEnabled) {
      const ports = configStore.getLanPorts();
      await assertPortAvailable("0.0.0.0", ports.certificate);
      await assertPortAvailable("0.0.0.0", ports.https);
    }
    configStore.setLanEnabled(enabled);
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 500);
    return { enabled, restartScheduled: true };
  });

  handle("desktop:select-media-directory", async (event): Promise<SelectedDirectory | null> => {
    const window = getMainWindow();
    if (!window) throw new Error("WINDOW_UNAVAILABLE");
    const result = await dialog.showOpenDialog(window, {
      title: "选择 Inventory Hub 图片存储目录",
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"],
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;
    if (selectedPath === parse(selectedPath).root || selectedPath === homedir()) {
      throw new Error("MEDIA_DIRECTORY_TOO_BROAD");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SELECTION_LIFETIME_MS;
    grants.set(token, { path: selectedPath, senderId: event.sender.id, expiresAt });
    service.registerMediaSelection({ token, path: selectedPath, expiresAt });
    return { token, displayPath: selectedPath, expiresAt: new Date(expiresAt).toISOString() };
  });

  handle(
    "desktop:validate-media-directory",
    (event, selectionToken: string): MediaDirectoryValidation => {
      if (typeof selectionToken !== "string" || selectionToken.length < 32 || selectionToken.length > 128) {
        throw new Error("INVALID_SELECTION_TOKEN");
      }
      const path = getGrantedPath(grants, selectionToken, event.sender.id);
      try {
        const stats = lstatSync(path);
        if (!stats.isDirectory()) return { valid: false, displayPath: path, reason: "INVALID_PATH" };
        if (stats.isSymbolicLink() || realpathSync(path) !== path) {
          return { valid: false, displayPath: path, reason: "SYMLINK_NOT_ALLOWED" };
        }
        accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
        const filesystem = statfsSync(path);
        return {
          valid: true,
          displayPath: path,
          freeBytes: filesystem.bavail * filesystem.bsize,
        };
      } catch {
        return { valid: false, displayPath: path, reason: "NOT_WRITABLE" };
      }
    },
  );

  handle(
    "desktop:open-managed-path",
    async (event, kind: ManagedPathKind, selectionToken?: string): Promise<void> => {
      const allowedKinds = new Set<ManagedPathKind>(["userData", "database", "logs", "selectedMedia"]);
      if (!allowedKinds.has(kind)) throw new Error("INVALID_MANAGED_PATH_KIND");
      let path: string;
      if (kind === "selectedMedia") {
        if (!selectionToken) throw new Error("SELECTION_TOKEN_REQUIRED");
        path = getGrantedPath(grants, selectionToken, event.sender.id);
      } else {
        path = kind === "userData" ? config.dataDir : kind === "database" ? config.databaseDir : config.logDir;
      }
      const failure = await shell.openPath(path);
      if (failure) throw new Error(`OPEN_PATH_FAILED: ${failure}`);
    },
  );

  handle("desktop:get-print-preferences", (): LocalPrintPreferences =>
    configStore.getPrintPreferences(),
  );

  handle(
    "desktop:set-print-preferences",
    async (_event, preferences: LocalPrintPreferences): Promise<LocalPrintPreferences> => {
      if (!preferences || typeof preferences !== "object")
        throw new Error("INVALID_PRINT_PREFERENCES");
      if (!preferences.printerId) throw new Error("PRINTER_REQUIRED");
      if (!new Set(["40x30", "50x30"]).has(preferences.paper))
        throw new Error("INVALID_PRINT_PAPER");
      if (!new Set(["Enter", "Tab"]).has(preferences.terminator))
        throw new Error("INVALID_SCANNER_TERMINATOR");
      const window = getMainWindow();
      if (!window) throw new Error("WINDOW_UNAVAILABLE");
      const printers = await listPrinterSummaries(window);
      if (!printers.some((printer) => printer.name === preferences.printerId))
        throw new Error("PRINTER_NOT_FOUND");
      const settings = await applyAndPublishPrintPreferences({
        window,
        configStore,
        service,
        preferences,
      });
      return {
        ...(settings.printerId ? { printerId: settings.printerId } : {}),
        paper: settings.paper,
        terminator: settings.terminator,
      };
    },
  );

  handle("desktop:print-label", async (_event, request: PrintLabelRequest) => {
    const window = getMainWindow();
    if (!window) throw new Error("WINDOW_UNAVAILABLE");
    return printLabel(window, request);
  });

  const unsubscribeStatus = service.onStatus((status) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send("desktop:service-status", status);
  });
  const unsubscribeWebRelease = webReleases.onStatus((status) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("desktop:web-release-status", status);
    }
  });

  return () => {
    unsubscribeStatus();
    unsubscribeWebRelease();
    for (const channel of channels) ipcMain.removeHandler(channel);
    grants.clear();
  };
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  trustedPageUrl: string,
): void {
  if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("UNTRUSTED_IPC_SENDER");
  }
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || new URL(senderUrl).origin !== new URL(trustedPageUrl).origin) {
    throw new Error("UNTRUSTED_IPC_ORIGIN");
  }
}

function getGrantedPath(grants: Map<string, DirectoryGrant>, token: string, senderId: number): string {
  const grant = grants.get(token);
  if (!grant || grant.senderId !== senderId || grant.expiresAt < Date.now()) {
    grants.delete(token);
    throw new Error("MEDIA_SELECTION_EXPIRED");
  }
  return grant.path;
}

function assertPortAvailable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "EADDRINUSE" ? `LAN_PORT_IN_USE: ${port}` : `LAN_PORT_CHECK_FAILED: ${port}`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}
