import { contextBridge, ipcRenderer } from "electron";
import type {
  InventoryHubRemoteApi,
  PrinterSummary,
  RemoteDesktopEnvironment,
  RemotePairingRequest,
  RemotePrintExecutorStatus,
} from "../shared/contracts";

const api: InventoryHubRemoteApi = {
  getEnvironment: () =>
    ipcRenderer.invoke("remote-print:get-environment") as Promise<RemoteDesktopEnvironment>,
  listPrinters: () =>
    ipcRenderer.invoke("remote-print:list-printers") as Promise<PrinterSummary[]>,
  pair: (request: RemotePairingRequest) =>
    ipcRenderer.invoke("remote-print:pair", request) as Promise<RemotePrintExecutorStatus>,
  getStatus: () =>
    ipcRenderer.invoke("remote-print:get-status") as Promise<RemotePrintExecutorStatus>,
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: RemotePrintExecutorStatus) =>
      listener(status);
    ipcRenderer.on("remote-print:status", handler);
    return () => ipcRenderer.removeListener("remote-print:status", handler);
  },
  unpair: () =>
    ipcRenderer.invoke("remote-print:unpair") as Promise<RemotePrintExecutorStatus>,
};

contextBridge.exposeInMainWorld("inventoryHubRemote", api);

declare global {
  interface Window {
    inventoryHubRemote?: InventoryHubRemoteApi;
  }
}
