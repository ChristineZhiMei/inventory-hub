import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopRuntimeConfig } from "./config";
import type { RemotePrintExecutor } from "./remote-print-executor";
import type {
  PrinterSummary,
  RemoteDesktopEnvironment,
  RemotePairingRequest,
  RemotePrintExecutorStatus,
} from "../shared/contracts";

export function registerRemotePrintIpc(options: {
  getMainWindow: () => BrowserWindow | null;
  config: DesktopRuntimeConfig;
  executor: RemotePrintExecutor;
}): () => void {
  const { getMainWindow, config, executor } = options;
  if (config.mode !== "remote" || !config.remoteUrl) {
    throw new Error("REMOTE_PRINT_IPC_REQUIRES_REMOTE_MODE");
  }
  const remoteUrl = config.remoteUrl;
  const channels: string[] = [];
  const handle = <T extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: T) => unknown,
  ) => {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args: T) => {
      assertTrustedRemoteSender(event, getMainWindow(), remoteUrl);
      return listener(event, ...args);
    });
  };

  handle("remote-print:get-environment", (): RemoteDesktopEnvironment => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mode: "remote",
    serviceOrigin: new URL(remoteUrl).origin,
  }));
  handle("remote-print:list-printers", (): Promise<PrinterSummary[]> =>
    executor.listAvailablePrinters(),
  );
  handle(
    "remote-print:pair",
    (_event, request: RemotePairingRequest): Promise<RemotePrintExecutorStatus> =>
      executor.pair(request),
  );
  handle("remote-print:get-status", (): RemotePrintExecutorStatus => executor.status);
  handle("remote-print:unpair", (): Promise<RemotePrintExecutorStatus> => executor.unpair());

  const unsubscribeStatus = executor.onStatus((status) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("remote-print:status", status);
    }
  });

  return () => {
    unsubscribeStatus();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function assertTrustedRemoteSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  trustedPageUrl: string,
): void {
  if (
    !window ||
    event.sender.id !== window.webContents.id ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("UNTRUSTED_IPC_SENDER");
  }
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || new URL(senderUrl).origin !== new URL(trustedPageUrl).origin) {
    throw new Error("UNTRUSTED_IPC_ORIGIN");
  }
}
