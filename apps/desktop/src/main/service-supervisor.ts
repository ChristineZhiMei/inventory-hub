import { app, utilityProcess } from "electron";
import { appendFileSync, existsSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { DesktopRuntimeConfig } from "./config";
import type {
  LocalPrintPreferences,
  LocalPrintSettings,
  ServiceStatus,
} from "../shared/contracts";

const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

type StatusListener = (status: ServiceStatus) => void;
type ExitListener = (exitCode: number) => void;
type PrintPreferenceListener = (preferences: LocalPrintPreferences) => void;

export class CoreServiceSupervisor {
  private child: Electron.UtilityProcess | null = null;
  private expectedStop = false;
  private currentStatus: ServiceStatus;
  private readonly statusListeners = new Set<StatusListener>();
  private exitListener: ExitListener | undefined;
  private printPreferenceListener: PrintPreferenceListener | undefined;

  constructor(private readonly config: DesktopRuntimeConfig) {
    this.currentStatus = this.makeStatus(config.mode === "remote" ? "remote" : "stopped", 0);
  }

  get status(): ServiceStatus {
    return this.currentStatus;
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onUnexpectedExit(listener: ExitListener): void {
    this.exitListener = listener;
  }

  onPrintPreferencesRequested(listener: PrintPreferenceListener): void {
    this.printPreferenceListener = listener;
  }

  async start(attempt = 1): Promise<void> {
    if (this.config.mode === "remote") {
      this.updateStatus("remote", 0);
      return;
    }
    if (this.child) return;

    this.updateStatus(attempt > 1 ? "restarting" : "starting", attempt);
    await assertPortAvailable("127.0.0.1", this.config.servicePort);
    const entry = this.resolveServiceEntry();
    this.expectedStop = false;

    const child = utilityProcess.fork(entry, [], {
      // In a packaged build app.getAppPath() points at app.asar, which is a file,
      // not a valid process working directory. Using Resources keeps utilityProcess
      // startup valid while the entry module can still live inside app.asar.
      cwd: app.isPackaged ? dirname(app.getAppPath()) : app.getAppPath(),
      env: {
        ...process.env,
        APP_MODE: "desktop",
        APP_ORIGIN: this.config.appOrigins.join(","),
        DATABASE_PATH: join(this.config.databaseDir, "inventory.sqlite"),
        MEDIA_ROOT: this.config.mediaDir,
        PORT: String(this.config.servicePort),
        IH_HOST: "127.0.0.1",
        IH_PORT: String(this.config.servicePort),
        IH_DATA_DIR: this.config.dataDir,
        IH_MEDIA_ROOT: this.config.mediaDir,
        IH_WEB_DIST_PATH: this.config.webDistPath,
        IH_LAN_ENABLED: String(this.config.lanEnabled),
        // The core stays on loopback HTTP. The LAN HTTPS gateway adds Secure to
        // Set-Cookie without breaking the local Electron/Vite session.
        IH_SECURE_COOKIES: "false",
        IH_TRUST_PROXY: String(this.config.lanEnabled),
        ...(this.config.lanOrigin ? { IH_LAN_ORIGIN: this.config.lanOrigin } : {}),
        INVENTORY_HUB_PARENT_PID: String(process.pid),
      },
      stdio: "pipe",
      serviceName: "Inventory Hub Core",
    });
    this.child = child;
    this.pipeServiceLogs(child);
    child.on("message", (message) => {
      const payload = ((message as { data?: unknown })?.data ?? message) as Record<string, unknown>;
      if (
        payload?.type === "inventory-hub:set-print-preferences" &&
        payload.preferences &&
        typeof payload.preferences === "object"
      ) {
        this.printPreferenceListener?.(payload.preferences as LocalPrintPreferences);
      }
    });

    child.once("exit", (code) => {
      const wasExpected = this.expectedStop;
      const wasReady = this.currentStatus.phase === "ready";
      if (this.child === child) this.child = null;
      if (!wasExpected) {
        this.appendServiceLog("supervisor", `Core service exited with code ${code}\n`);
        this.updateStatus("failed", attempt, `Core service exited with code ${code}`);
        // start() owns failures before readiness. Scheduling from both here and
        // start() would create overlapping utility processes during a restart.
        if (wasReady) this.exitListener?.(code);
      }
    });

    try {
      await this.waitForReady(child);
      if (this.child !== child) throw new Error("Core service exited during startup");
      this.updateStatus("ready", attempt);
    } catch (error) {
      this.expectedStop = true;
      child.kill();
      if (this.child === child) this.child = null;
      this.appendServiceLog("supervisor", `Core service startup failed: ${String(error)}\n`);
      this.updateStatus("failed", attempt, String(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      if (this.config.mode !== "remote") this.updateStatus("stopped", 0);
      return;
    }

    this.expectedStop = true;
    this.updateStatus("stopping", this.currentStatus.attempt);
    const child = this.child;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

    try {
      child.postMessage({ type: "inventory-hub:shutdown" });
    } catch (error) {
      this.appendServiceLog("supervisor", `Unable to request graceful shutdown: ${String(error)}\n`);
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      delay(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!graceful) {
      child.kill();
      await Promise.race([exited, delay(2_000)]);
    }

    if (this.child === child) this.child = null;
    this.updateStatus("stopped", 0);
  }

  registerMediaSelection(selection: { token: string; path: string; expiresAt: number }): void {
    if (!this.child || this.currentStatus.phase !== "ready") {
      throw new Error("CORE_SERVICE_NOT_READY");
    }
    this.child.postMessage({
      type: "inventory-hub:media-selection",
      token: selection.token,
      path: selection.path,
      expiresAt: selection.expiresAt,
    });
  }

  registerLocalPrintSettings(settings: LocalPrintSettings): void {
    if (!this.child || this.currentStatus.phase !== "ready") {
      throw new Error("CORE_SERVICE_NOT_READY");
    }
    this.child.postMessage({
      type: "inventory-hub:native-print-settings",
      settings,
    });
  }

  private resolveServiceEntry(): string {
    const override = process.env.INVENTORY_HUB_SERVICE_ENTRY;
    const candidates = [
      override ? resolve(override) : undefined,
      join(app.getAppPath(), "node_modules", "@inventory-hub", "core", "dist", "standalone.js"),
      join(process.resourcesPath, "service", "standalone.js"),
      join(app.getAppPath(), "..", "..", "packages", "core", "dist", "standalone.js"),
      join(app.getAppPath(), "..", "server", "dist", "index.js"),
    ].filter((candidate): candidate is string => Boolean(candidate));

    const entry = candidates.find((candidate) => existsSync(candidate));
    if (!entry) {
      throw new Error(
        `Core service build was not found. Checked: ${candidates.join(", ")}. Run the core build first or set INVENTORY_HUB_SERVICE_ENTRY.`,
      );
    }
    return entry;
  }

  private async waitForReady(child: Electron.UtilityProcess): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    const serviceUrl = new URL(this.config.serviceOrigin);
    const servicePort = Number(serviceUrl.port);
    while (Date.now() < deadline) {
      if (this.child !== child) {
        throw new Error("Core service stopped before becoming ready");
      }
      if (await probePort(serviceUrl.hostname, servicePort)) return;
      await delay(250);
    }
    throw new Error(`Core service did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s`);
  }

  private pipeServiceLogs(child: Electron.UtilityProcess): void {
    const append = (source: "stdout" | "stderr", chunk: unknown) => {
      this.appendServiceLog(source, String(chunk).replaceAll(/\r?\n/g, "\n"));
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
  }

  private appendServiceLog(source: "stdout" | "stderr" | "supervisor", message: string): void {
    appendFileSync(
      join(this.config.logDir, "core-service.log"),
      `${new Date().toISOString()} [${source}] ${message}`,
    );
  }

  private updateStatus(phase: ServiceStatus["phase"], attempt: number, message?: string): void {
    this.currentStatus = this.makeStatus(phase, attempt, message);
    for (const listener of this.statusListeners) listener(this.currentStatus);
  }

  private makeStatus(
    phase: ServiceStatus["phase"],
    attempt: number,
    message?: string,
  ): ServiceStatus {
    return {
      phase,
      origin: this.config.serviceOrigin,
      attempt,
      ...(message ? { message } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
}

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1_500);
    socket.once("connect", () => {
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("timeout", () => socket.destroy());
    socket.once("error", () => resolveProbe(false));
    socket.once("close", () => resolveProbe(false));
  });
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectUnavailable) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        rejectUnavailable(new Error(`PORT_IN_USE: ${host}:${port} is already occupied`));
        return;
      }
      rejectUnavailable(new Error(`PORT_CHECK_FAILED: ${host}:${port}: ${error.message}`));
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) rejectUnavailable(new Error(`PORT_CHECK_FAILED: ${host}:${port}: ${error.message}`));
        else resolveAvailable();
      });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
