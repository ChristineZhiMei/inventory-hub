import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopEnvironment,
  InventoryHubDesktopApi,
  LanConfigurationResult,
  ManagedPathKind,
  MediaDirectoryValidation,
  LocalPrintPreferences,
  PrintLabelRequest,
  PrintLabelResult,
  SelectedDirectory,
  ServiceStatus,
  WebReleaseActionResult,
  WebReleaseStatus,
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
  getPrintPreferences: () =>
    ipcRenderer.invoke("desktop:get-print-preferences") as Promise<LocalPrintPreferences>,
  setPrintPreferences: (preferences: LocalPrintPreferences) =>
    ipcRenderer.invoke(
      "desktop:set-print-preferences",
      preferences,
    ) as Promise<LocalPrintPreferences>,
  printLabel: (request: PrintLabelRequest) =>
    ipcRenderer.invoke("desktop:print-label", request) as Promise<PrintLabelResult>,
  getWebReleaseStatus: () =>
    ipcRenderer.invoke("desktop:get-web-release-status") as Promise<WebReleaseStatus>,
  onWebReleaseStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: WebReleaseStatus) => listener(status);
    ipcRenderer.on("desktop:web-release-status", handler);
    return () => ipcRenderer.removeListener("desktop:web-release-status", handler);
  },
  checkWebReleaseUpdate: () =>
    ipcRenderer.invoke("desktop:check-web-release-update") as Promise<WebReleaseStatus>,
  selectWebReleasePackage: () =>
    ipcRenderer.invoke("desktop:select-web-release-package") as Promise<WebReleaseStatus>,
  downloadWebReleaseUpdate: () =>
    ipcRenderer.invoke("desktop:download-web-release-update") as Promise<WebReleaseStatus>,
  applyWebRelease: () =>
    ipcRenderer.invoke("desktop:apply-web-release") as Promise<WebReleaseActionResult>,
  restoreBundledWebRelease: () =>
    ipcRenderer.invoke("desktop:restore-bundled-web-release") as Promise<WebReleaseActionResult>,
  openWebReleaseClientDownload: (url: string) =>
    ipcRenderer.invoke("desktop:open-web-release-client-download", url) as Promise<void>,
  reportWebReleaseReady: () =>
    ipcRenderer.invoke("desktop:report-web-release-ready") as Promise<void>,
};

contextBridge.exposeInMainWorld("inventoryHub", api);

declare global {
  interface Window {
    inventoryHub?: InventoryHubDesktopApi;
  }
}
