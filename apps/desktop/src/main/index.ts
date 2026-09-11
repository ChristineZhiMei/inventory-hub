import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  Tray,
  type Session,
} from "electron";
import { join } from "node:path";
import { DesktopConfigStore, type DesktopRuntimeConfig } from "./config";
import { registerDesktopIpc } from "./ipc";
import { LanCertificatePortal, LanHttpsGateway } from "./lan-gateway";
import { applyAndPublishPrintPreferences } from "./native-print-settings";
import { SafeStorageRemoteCredentialStore } from "./remote-credential-store";
import { registerRemotePrintIpc } from "./remote-ipc";
import { RemotePrintExecutor } from "./remote-print-executor";
import { CoreServiceSupervisor } from "./service-supervisor";
import { WebReleaseManager } from "./web-release-manager";

const MAX_RESTARTS_PER_WINDOW = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1_000;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: DesktopRuntimeConfig | null = null;
let desktopConfigStore: DesktopConfigStore | null = null;
let coreService: CoreServiceSupervisor | null = null;
let lanGateway: LanHttpsGateway | null = null;
let certificatePortal: LanCertificatePortal | null = null;
let remotePrintExecutor: RemotePrintExecutor | null = null;
let unregisterIpc: (() => void) | null = null;
let webReleaseManager: WebReleaseManager | null = null;
let webUpdateTimer: NodeJS.Timeout | null = null;
let restartInProgress = false;
let restartAttempts: number[] = [];
let quitRequested = false;
let cleanupComplete = false;
let cleanupInProgress = false;

app.setName("Inventory Hub");
app.enableSandbox();

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  registerApplicationEvents();
}

function registerApplicationEvents(): void {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(bootstrap).catch((error) => {
    if (webReleaseManager?.status.pending) {
      webReleaseManager.rollbackPendingActivation();
      scheduleRelaunch();
      return;
    }
    // Keep the main loop responsive while the error is visible. A synchronous
    // error box can block SIGTERM/app.quit indefinitely in unattended launches.
    void dialog
      .showMessageBox({
        type: "error",
        title: "Inventory Hub 启动失败",
        message: "Inventory Hub 启动失败",
        detail: humanizeError(error),
        buttons: ["退出"],
        defaultId: 0,
        noLink: true,
      })
      .catch((dialogError) => appendDiagnostic("Unable to show startup error", dialogError))
      .finally(() => app.quit());
  });

  app.on("activate", () => {
    if (mainWindow) showMainWindow();
    else if (config) createMainWindow(config);
  });

  app.on("window-all-closed", () => {
    // Desktop mode deliberately keeps the local service and LAN access alive in the tray.
  });

  app.on("before-quit", (event) => {
    quitRequested = true;
    if (cleanupComplete || (!coreService && !remotePrintExecutor && !lanGateway && !certificatePortal)) return;
    event.preventDefault();
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    if (webUpdateTimer) clearInterval(webUpdateTimer);
    const forcedExit = setTimeout(() => process.exit(1), 15_000);
    const cleanupTasks = [coreService?.stop(), remotePrintExecutor?.stop(), lanGateway?.stop(), certificatePortal?.stop()].filter(
      (task): task is Promise<void> => Boolean(task),
    );
    void Promise.allSettled(cleanupTasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") appendDiagnostic("Shutdown task failed", result.reason);
      }
      clearTimeout(forcedExit);
      cleanupComplete = true;
      unregisterIpc?.();
      app.exit(0);
      // Chromium can keep a defunct utility child registered after the Node
      // service has closed. Do not leave the database host process lingering.
      setTimeout(() => process.exit(0), 500);
    });
  });

  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());
}

async function bootstrap(): Promise<void> {
  app.setAppLogsPath();
  const store = new DesktopConfigStore();
  desktopConfigStore = store;
  webReleaseManager = new WebReleaseManager({
    userDataPath: app.getPath("userData"),
    bundledPath: join(process.resourcesPath, "web"),
    bundledVersion: app.getVersion(),
    desktopVersion: app.getVersion(),
  });
  webReleaseManager.prepareStartup();
  config = store.loadRuntimeConfig(webReleaseManager.getActiveWebPath());
  store.ensureRuntimeDirectories(config);

  coreService = new CoreServiceSupervisor(config);
  coreService.onUnexpectedExit(() => scheduleServiceRestart());
  coreService.onPrintPreferencesRequested((preferences) => {
    if (!mainWindow || !coreService || mainWindow.isDestroyed()) return;
    void applyAndPublishPrintPreferences({
      window: mainWindow,
      configStore: store,
      service: coreService,
      preferences,
    }).catch((error) => appendDiagnostic("Unable to apply print preferences", error));
  });
  if (config.mode === "desktop") {
    await coreService.start();
    if (config.lanEnabled) {
      if (!config.lanOrigin || !config.tlsCertPath || !config.tlsKeyPath) {
        throw new Error("LAN_HTTPS_CONFIGURATION_INCOMPLETE");
      }
      lanGateway = new LanHttpsGateway({
        bindHost: config.bindHost,
        lanOrigin: config.lanOrigin,
        serviceOrigin: config.serviceOrigin,
        webOrigin: config.webUrl,
        tlsCertPath: config.tlsCertPath,
        tlsKeyPath: config.tlsKeyPath,
      });
      await lanGateway.start();
      if (config.certificateInstallUrl && config.caCertPath && config.caFingerprint) {
        certificatePortal = new LanCertificatePortal({
          bindHost: config.bindHost,
          installOrigin: new URL(config.certificateInstallUrl).origin,
          appOrigin: config.lanOrigin,
          caCertPath: config.caCertPath,
          caFingerprint: config.caFingerprint,
        });
        await certificatePortal.start();
      }
    }
  }

  configureSessionSecurity(session.defaultSession, config.webUrl);
  mainWindow = createMainWindow(config);
  if (config.mode === "remote") {
    remotePrintExecutor = new RemotePrintExecutor({
      remoteUrl: config.remoteUrl!,
      credentialStore: new SafeStorageRemoteCredentialStore(),
      getWindow: () => mainWindow,
    });
    await remotePrintExecutor.start();
    unregisterIpc = registerRemotePrintIpc({
      getMainWindow: () => mainWindow,
      config,
      executor: remotePrintExecutor,
    });
  } else {
    unregisterIpc = registerDesktopIpc({
      getMainWindow: () => mainWindow,
      config,
      configStore: store,
      service: coreService,
      webReleases: webReleaseManager,
      applyWebRelease: () => {
        webReleaseManager?.activatePending();
        scheduleRelaunch();
      },
      restoreBundledWebRelease: () => {
        webReleaseManager?.restoreBundled();
        scheduleRelaunch();
      },
    });
  }
  createTray();
  await loadApplication(mainWindow, config.webUrl);
  if (config.mode === "desktop") {
    webReleaseManager.armHealthTimeout(scheduleRelaunch);
    setTimeout(() => void webReleaseManager?.checkForUpdate(), 5_000);
    webUpdateTimer = setInterval(
      () => void webReleaseManager?.checkForUpdate(),
      4 * 60 * 60 * 1_000,
    );
  }
  if (config.mode === "desktop") {
    await applyAndPublishPrintPreferences({
      window: mainWindow,
      configStore: store,
      service: coreService!,
    }).catch((error) => appendDiagnostic("Unable to publish print settings", error));
  }
}

function createMainWindow(runtime: DesktopRuntimeConfig): BrowserWindow {
  const preloadName = runtime.mode === "desktop" ? "index.js" : "remote.js";
  const window = new BrowserWindow({
    title: "Inventory Hub",
    icon: join(app.getAppPath(), "assets", "icon.png"),
    width: 1360,
    height: 880,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: "#f8fafc",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      preload: join(__dirname, "..", "preload", preloadName),
    },
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!quitRequested) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  const trustedOrigin = new URL(runtime.webUrl).origin;
  window.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== trustedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => {
    appendDiagnostic(`Renderer process ended (${details.reason})`, details.exitCode);
  });
  return window;
}

async function loadApplication(window: BrowserWindow, targetUrl: string): Promise<void> {
  let retries = 0;
  while (!window.isDestroyed()) {
    try {
      await window.loadURL(targetUrl);
      return;
    } catch (error) {
      retries += 1;
      if (retries >= 20) throw error;
      await delay(250);
    }
  }
}

function configureSessionSecurity(targetSession: Session, pageUrl: string): void {
  const pageOrigin = new URL(pageUrl).origin;
  const development = Boolean(process.env.INVENTORY_HUB_DESKTOP_DEV_URL);
  const connectSources = development
    ? `'self' ${pageOrigin} ws://127.0.0.1:14237 http://127.0.0.1:18473`
    : `'self' ${pageOrigin}`;
  const scriptSources = development ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self'";
  const policy = [
    "default-src 'self'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "frame-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    let responseOrigin = "";
    try {
      responseOrigin = new URL(details.url).origin;
    } catch {
      // Non-URL responses are never part of the trusted web application.
    }
    if (responseOrigin !== pageOrigin) {
      callback(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
}

function createTray(): void {
  if (tray) return;
  const iconPath = join(app.getAppPath(), "assets", "icon.png");
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip("Inventory Hub");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Inventory Hub", click: showMainWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", showMainWindow);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function scheduleServiceRestart(): void {
  if (quitRequested || restartInProgress || !coreService) return;
  const now = Date.now();
  restartAttempts = restartAttempts.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS);
  if (restartAttempts.length >= MAX_RESTARTS_PER_WINDOW) {
    const detail = coreService.status.message ? `\n\n最后错误：${coreService.status.message}` : "";
    dialog.showErrorBox(
      "Inventory Hub 服务已停止",
      `核心服务在 10 分钟内连续异常退出，已停止自动重启。请从日志目录查看 core-service.log。${detail}`,
    );
    return;
  }

  restartAttempts.push(now);
  const attempt = restartAttempts.length;
  restartInProgress = true;
  void (async () => {
    let failed = false;
    try {
      await delay(attempt * 1_000);
      await coreService?.start(attempt + 1);
      if (mainWindow && !mainWindow.isDestroyed() && config) {
        await loadApplication(mainWindow, config.webUrl);
        if (config.mode === "desktop" && desktopConfigStore && coreService) {
          await applyAndPublishPrintPreferences({
            window: mainWindow,
            configStore: desktopConfigStore,
            service: coreService,
          }).catch((error) => appendDiagnostic("Unable to republish print settings", error));
        }
      }
    } catch (error) {
      failed = true;
      appendDiagnostic("Core service restart failed", error);
    } finally {
      restartInProgress = false;
    }
    if (failed) scheduleServiceRestart();
  })();
}

function appendDiagnostic(context: string, error: unknown): void {
  console.error(`[Inventory Hub] ${context}:`, error);
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PORT_IN_USE")) {
    return `${message}\n\n请关闭占用该端口的程序，或在 IH_PORT 中配置另一个非默认端口后重试。`;
  }
  return `${message}\n\n日志目录：${app.getPath("logs")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function scheduleRelaunch(): void {
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 300);
}
