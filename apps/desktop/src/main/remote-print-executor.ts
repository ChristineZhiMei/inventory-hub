import { net as electronNet, type BrowserWindow } from "electron";
import { hostname } from "node:os";
import { listPrinterSummaries, printLabel } from "./printing";
import type {
  RemoteCredentialStore,
  RemoteExecutorCredential,
} from "./remote-credential-store";
import type {
  PrinterSummary,
  PrintLabelRequest,
  PrintLabelResult,
  RemotePairingRequest,
  RemotePrintExecutorStatus,
} from "../shared/contracts";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PRINT_TIMEOUT_MS = 30_000;

type RemoteFetch = (input: string, init?: RequestInit) => Promise<Response>;
type PrintOne = (window: BrowserWindow, request: PrintLabelRequest) => Promise<PrintLabelResult>;

interface ClaimedPrintItem {
  id: string;
  jobId: string;
  ordinal: number;
  attemptNo: number;
  claimToken: string;
  payload: {
    node: {
      code: string;
      name: string;
      type: "WAREHOUSE" | "BOX" | "BAG" | "ITEM";
    };
    paper?: {
      widthMm?: number;
      heightMm?: number;
      marginMm?: number;
      orientation?: string;
    };
    printerId?: string;
  };
}

export interface RemotePrintReport {
  state: "SUBMITTED" | "FAILED" | "UNKNOWN";
  evidence: string;
  osJobId?: string;
}

export interface RemotePrintExecutorOptions {
  remoteUrl: string;
  credentialStore: RemoteCredentialStore;
  getWindow: () => BrowserWindow | null;
  fetch?: RemoteFetch;
  listPrinters?: (window: BrowserWindow) => Promise<PrinterSummary[]>;
  printOne?: PrintOne;
  defaultExecutorName?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  printTimeoutMs?: number;
}

type StatusListener = (status: RemotePrintExecutorStatus) => void;

export class RemotePrintExecutor {
  private readonly remoteOrigin: string;
  private readonly credentialStore: RemoteCredentialStore;
  private readonly getWindow: () => BrowserWindow | null;
  private readonly fetchRemote: RemoteFetch;
  private readonly getPrinters: (window: BrowserWindow) => Promise<PrinterSummary[]>;
  private readonly submitPrint: PrintOne;
  private readonly defaultExecutorName: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly printTimeoutMs: number;
  private readonly statusListeners = new Set<StatusListener>();
  private credential: RemoteExecutorCredential | null = null;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private started = false;
  private claimsSuspended = false;
  private suspension: { itemId: string; message: string } | undefined;
  private lastHeartbeatAt: string | undefined;
  private currentStatus: RemotePrintExecutorStatus = {
    phase: "stopped",
    paired: false,
    updatedAt: new Date().toISOString(),
  };

  constructor(options: RemotePrintExecutorOptions) {
    const url = new URL(options.remoteUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("REMOTE_PRINT_REQUIRES_HTTPS");
    }
    this.remoteOrigin = url.origin;
    this.credentialStore = options.credentialStore;
    this.getWindow = options.getWindow;
    this.fetchRemote = options.fetch ?? ((input, init) => electronNet.fetch(input, init));
    this.getPrinters = options.listPrinters ?? listPrinterSummaries;
    this.submitPrint = options.printOne ?? printLabel;
    this.defaultExecutorName = (
      options.defaultExecutorName ?? `Inventory Hub · ${hostname()}`
    ).slice(0, 120);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.printTimeoutMs = options.printTimeoutMs ?? PRINT_TIMEOUT_MS;
  }

  get status(): RemotePrintExecutorStatus {
    return { ...this.currentStatus };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.claimsSuspended = false;
    this.suspension = undefined;
    try {
      this.credential = this.credentialStore.load(this.remoteOrigin);
    } catch (error) {
      this.credential = null;
      this.publish("attention", { message: safeErrorMessage(error) });
      return;
    }
    if (!this.credential) {
      this.publish("unpaired");
      return;
    }
    this.publish("offline", { message: "正在连接远程服务" });
    this.beginLoop();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.haltLoop();
    this.publish("stopped");
  }

  async listAvailablePrinters(): Promise<PrinterSummary[]> {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) throw new Error("WINDOW_UNAVAILABLE");
    return this.getPrinters(window);
  }

  async pair(request: RemotePairingRequest): Promise<RemotePrintExecutorStatus> {
    validatePairingRequest(request);
    await this.haltLoop();
    this.started = true;
    this.claimsSuspended = false;
    this.suspension = undefined;
    this.publish("pairing");
    try {
      const printers = await this.listAvailablePrinters();
      if (!printers.some((printer) => printer.name === request.printerId)) {
        throw new Error("PRINTER_NOT_FOUND");
      }
      const deviceId = this.credentialStore.getDeviceId();
      const executorName = request.executorName?.trim() || this.defaultExecutorName;
      const capabilities = makeCapabilities(request.printerId, printers);
      const paired = await this.request<{
        executorId: string;
        token: string;
        name: string;
      }>("/api/v1/print-executors/claim-pairing", {
        body: {
          code: request.code,
          deviceId,
          name: executorName,
          capabilities,
        },
      });
      assertPairingResponse(paired);
      const credential: RemoteExecutorCredential = {
        remoteOrigin: this.remoteOrigin,
        deviceId,
        executorId: paired.executorId,
        executorName: paired.name,
        selectedPrinterId: request.printerId,
        token: paired.token,
      };
      this.credentialStore.save(credential);
      this.credential = credential;
      this.publish("online");
      this.beginLoop();
      return this.status;
    } catch (error) {
      this.publish("attention", { message: safeErrorMessage(error) });
      throw error;
    }
  }

  async unpair(): Promise<RemotePrintExecutorStatus> {
    await this.haltLoop();
    this.credentialStore.clear();
    this.credential = null;
    this.claimsSuspended = false;
    this.suspension = undefined;
    this.lastHeartbeatAt = undefined;
    this.publish("unpaired");
    return this.status;
  }

  private beginLoop(): void {
    if (!this.started || !this.credential || this.loopPromise) return;
    const controller = new AbortController();
    this.abortController = controller;
    const running = this.runLoop(controller.signal).finally(() => {
      if (this.abortController === controller) this.abortController = null;
      if (this.loopPromise === running) this.loopPromise = null;
    });
    this.loopPromise = running;
  }

  private async haltLoop(): Promise<void> {
    const running = this.loopPromise;
    this.abortController?.abort();
    if (running) await running;
    this.abortController = null;
    this.loopPromise = null;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let lastHeartbeatTime = 0;
    while (!signal.aborted && this.started && this.credential) {
      try {
        if (Date.now() - lastHeartbeatTime >= this.heartbeatIntervalMs) {
          const printers = await this.listAvailablePrinters();
          await this.request("/api/v1/print-executors/heartbeat", {
            token: this.credential.token,
            body: { capabilities: makeCapabilities(this.credential.selectedPrinterId, printers) },
            signal,
          });
          lastHeartbeatTime = Date.now();
          this.lastHeartbeatAt = new Date(lastHeartbeatTime).toISOString();
          if (this.claimsSuspended && this.suspension) {
            this.publish("attention", {
              currentItemId: this.suspension.itemId,
              message: this.suspension.message,
            });
          } else {
            this.publish("online");
          }
        }

        if (this.claimsSuspended) {
          await abortableDelay(this.pollIntervalMs, signal);
          continue;
        }

        const claimed = await this.request<{ item: ClaimedPrintItem | null }>(
          "/api/v1/print-executors/claim",
          { token: this.credential.token, body: {}, signal },
        );
        if (!claimed.item) {
          await abortableDelay(this.pollIntervalMs, signal);
          continue;
        }
        await this.executeClaim(claimed.item, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RemoteHttpError && error.code === "UNAUTHENTICATED") {
          this.credentialStore.clear();
          this.credential = null;
          this.publish("unpaired", { message: "远程执行器授权已失效，请重新配对" });
          return;
        }
        this.publish("offline", { message: safeErrorMessage(error) });
        await abortableDelay(Math.max(this.pollIntervalMs, 5_000), signal);
      }
    }
  }

  private async executeClaim(item: ClaimedPrintItem, signal: AbortSignal): Promise<void> {
    if (!this.credential) return;
    this.publish("printing", { currentItemId: item.id });
    let report: RemotePrintReport;
    try {
      const request = toPrintRequest(item, this.credential.selectedPrinterId);
      const window = this.getWindow();
      if (!window || window.isDestroyed()) throw new RemotePrintPreflightError("WINDOW_UNAVAILABLE");
      const result = await racePrint(
        this.submitPrint(window, request),
        this.printTimeoutMs,
        signal,
      );
      if (signal.aborted) return;
      report = mapPrintResultToReport(result);
    } catch (error) {
      if (signal.aborted) return;
      report = error instanceof RemotePrintPreflightError
        ? { state: "FAILED", evidence: `打印前检查失败：${error.message}` }
        : {
            state: "UNKNOWN",
            evidence: `打印调用中断，无法确认系统是否接受：${safeErrorMessage(error)}`.slice(0, 1_000),
          };
    }

    try {
      await this.request(`/api/v1/print-executors/items/${encodeURIComponent(item.id)}/report`, {
        token: this.credential.token,
        body: {
          attemptNo: item.attemptNo,
          claimToken: item.claimToken,
          state: report.state,
          evidence: report.evidence,
          ...(report.osJobId ? { osJobId: report.osJobId } : {}),
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof RemoteHttpError && error.code === "UNAUTHENTICATED") throw error;
      this.claimsSuspended = true;
      this.suspension = {
        itemId: item.id,
        message: `打印结果回报失败，已停止继续领取：${safeErrorMessage(error)}`,
      };
      this.publish("attention", {
        currentItemId: item.id,
        message: this.suspension.message,
      });
      return;
    }

    if (report.state === "SUBMITTED") {
      this.publish("online");
      return;
    }
    this.claimsSuspended = true;
    this.suspension = { itemId: item.id, message: report.evidence };
    this.publish("attention", {
      currentItemId: item.id,
      message: this.suspension.message,
    });
  }

  private async request<T = unknown>(
    path: string,
    options: { body: Record<string, unknown>; token?: string; signal?: AbortSignal },
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await abortableRequest(
      this.fetchRemote(`${this.remoteOrigin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(options.body),
        redirect: "error",
        signal,
      }),
      signal,
    );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RemoteHttpError("INVALID_RESPONSE", `远程服务返回了无效响应（${response.status}）`);
    }
    if (!response.ok) {
      const failure = payload as { error?: { code?: unknown; message?: unknown } };
      throw new RemoteHttpError(
        typeof failure.error?.code === "string" ? failure.error.code : "HTTP_ERROR",
        typeof failure.error?.message === "string"
          ? failure.error.message
          : `远程服务请求失败（${response.status}）`,
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new RemoteHttpError("INVALID_RESPONSE", "远程服务响应缺少 data");
    }
    const envelope = payload as { data?: T };
    if (!("data" in envelope)) throw new RemoteHttpError("INVALID_RESPONSE", "远程服务响应缺少 data");
    return envelope.data as T;
  }

  private publish(
    phase: RemotePrintExecutorStatus["phase"],
    details: { currentItemId?: string; message?: string } = {},
  ): void {
    const next: RemotePrintExecutorStatus = {
      phase,
      paired: Boolean(this.credential),
      updatedAt: new Date().toISOString(),
    };
    if (this.credential) {
      next.executorId = this.credential.executorId;
      next.executorName = this.credential.executorName;
      next.selectedPrinterId = this.credential.selectedPrinterId;
    }
    if (this.lastHeartbeatAt) next.lastHeartbeatAt = this.lastHeartbeatAt;
    if (details.currentItemId) next.currentItemId = details.currentItemId;
    if (details.message) next.message = details.message.slice(0, 1_000);
    this.currentStatus = next;
    for (const listener of this.statusListeners) listener(this.status);
  }
}

export function mapPrintResultToReport(result: PrintLabelResult): RemotePrintReport {
  if (result.acceptedBySystem) {
    return {
      state: "SUBMITTED",
      evidence: (result.message || "操作系统已接受打印任务").slice(0, 1_000),
    };
  }
  return {
    state: "FAILED",
    evidence: (result.message || "操作系统明确拒绝打印任务").slice(0, 1_000),
  };
}

function makeCapabilities(selectedPrinterId: string, printers: PrinterSummary[]): Record<string, unknown> {
  return {
    version: 1,
    platform: process.platform,
    arch: process.arch,
    selectedPrinterId,
    paperSizes: ["40x30"],
    printers: printers.map((printer) => ({
      printerId: printer.name,
      displayName: printer.displayName,
      description: printer.description,
      isDefault: printer.isDefault,
      status: printer.status,
    })),
  };
}

function toPrintRequest(item: ClaimedPrintItem, selectedPrinterId: string): PrintLabelRequest {
  if (
    !item ||
    typeof item.id !== "string" ||
    !Number.isInteger(item.attemptNo) ||
    item.attemptNo < 1 ||
    typeof item.claimToken !== "string" ||
    !item.payload?.node
  ) {
    throw new RemotePrintPreflightError("INVALID_REMOTE_PRINT_ITEM");
  }
  if (item.payload.printerId && item.payload.printerId !== selectedPrinterId) {
    throw new RemotePrintPreflightError("REMOTE_PRINT_PRINTER_MISMATCH");
  }
  if (
    !/^(W|C|I)[0-9]{6,}$/.test(item.payload.node.code) ||
    typeof item.payload.node.name !== "string" ||
    item.payload.node.name.trim().length < 1 ||
    !new Set(["WAREHOUSE", "BOX", "BAG", "ITEM"]).has(item.payload.node.type)
  ) {
    throw new RemotePrintPreflightError("INVALID_REMOTE_PRINT_PAYLOAD");
  }
  const paper = item.payload.paper ?? {};
  return {
    printerName: selectedPrinterId,
    jobName: `Inventory Hub ${item.payload.node.code}`,
    label: item.payload.node,
    paper: {
      widthMm: paper.widthMm ?? 40,
      heightMm: paper.heightMm ?? 30,
      marginMm: paper.marginMm ?? 1.5,
      landscape: paper.orientation === "landscape",
    },
  };
}

function assertPairingResponse(
  value: unknown,
): asserts value is { executorId: string; token: string; name: string } {
  if (!value || typeof value !== "object") throw new Error("INVALID_PAIRING_RESPONSE");
  const record = value as Record<string, unknown>;
  if (
    typeof record.executorId !== "string" ||
    record.executorId.length < 1 ||
    record.executorId.length > 120 ||
    typeof record.token !== "string" ||
    record.token.length < 32 ||
    record.token.length > 4096 ||
    typeof record.name !== "string" ||
    record.name.length < 1 ||
    record.name.length > 120
  ) {
    throw new Error("INVALID_PAIRING_RESPONSE");
  }
}

function validatePairingRequest(request: RemotePairingRequest): void {
  if (!request || typeof request !== "object" || !/^\d{6}$/.test(request.code)) {
    throw new Error("INVALID_PAIRING_CODE");
  }
  if (
    typeof request.printerId !== "string" ||
    request.printerId.length < 1 ||
    request.printerId.length > 256
  ) {
    throw new Error("INVALID_PRINTER_ID");
  }
  if (
    request.executorName !== undefined &&
    (typeof request.executorName !== "string" ||
      request.executorName.trim().length < 1 ||
      request.executorName.length > 120)
  ) {
    throw new Error("INVALID_EXECUTOR_NAME");
  }
}

class RemoteHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class RemotePrintPreflightError extends Error {}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "UNKNOWN_ERROR";
}

async function racePrint(
  print: Promise<PrintLabelResult>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PrintLabelResult> {
  return new Promise<PrintLabelResult>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => rejectResult(new Error("PRINT_EXECUTOR_STOPPED")));
    const timer = setTimeout(
      () => finish(() => rejectResult(new Error("PRINT_RESULT_TIMEOUT"))),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    print.then(
      (result) => finish(() => resolveResult(result)),
      (error) => finish(() => rejectResult(error)),
    );
    if (signal.aborted) abort();
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
  });
}

function abortableRequest(request: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(new Error("REMOTE_REQUEST_ABORTED"));
  return new Promise<Response>((resolveResponse, rejectResponse) => {
    const abort = () => finish(() => rejectResponse(new Error("REMOTE_REQUEST_ABORTED")));
    const finish = (callback: () => void) => {
      signal.removeEventListener("abort", abort);
      callback();
    };
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (response) => finish(() => resolveResponse(response)),
      (error) => finish(() => rejectResponse(error)),
    );
  });
}
