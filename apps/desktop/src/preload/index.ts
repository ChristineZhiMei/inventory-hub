import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopEnvironment,
  InventoryHubDesktopApi,
  LanConfigurationResult,
  ManagedPathKind,
  MediaDirectoryValidation,
  PrintLabelRequest,
  PrintLabelResult,
  PrinterSummary,
  SelectedDirectory,
  ServiceStatus,
} from "../shared/contracts";

const api: InventoryHubDesktopApi = {
  getEnvironment: () => ipcRenderer.invoke("desktop:get-environment") as Promise<DesktopEnvironment>,
  getServiceStatus: () => ipcRenderer.invoke("desktop:get-service-status") as Promise<ServiceStatus>,
  onServiceStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ServiceStatus) => listener(status);
    ipcRenderer.on("desktop:service-status", handler);
    return () => ipcRenderer.removeListener("desktop:service-status", handler);
  },
  selectMediaDirectory: () =>
    ipcRenderer.invoke("desktop:select-media-directory") as Promise<SelectedDirectory | null>,
  validateMediaDirectory: (selectionToken: string) =>
    ipcRenderer.invoke(
      "desktop:validate-media-directory",
      selectionToken,
    ) as Promise<MediaDirectoryValidation>,
  openManagedPath: (kind: ManagedPathKind, selectionToken?: string) =>
    ipcRenderer.invoke("desktop:open-managed-path", kind, selectionToken) as Promise<void>,
  setLanEnabled: (enabled: boolean) =>
    ipcRenderer.invoke("desktop:set-lan-enabled", enabled) as Promise<LanConfigurationResult>,
  listPrinters: () => ipcRenderer.invoke("desktop:list-printers") as Promise<PrinterSummary[]>,
  printLabel: (request: PrintLabelRequest) =>
    ipcRenderer.invoke("desktop:print-label", request) as Promise<PrintLabelResult>,
};

contextBridge.exposeInMainWorld("inventoryHub", api);

declare global {
  interface Window {
    inventoryHub?: InventoryHubDesktopApi;
  }
}
