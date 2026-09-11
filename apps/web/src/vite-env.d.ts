/// <reference types="vite/client" />

declare const __INVENTORY_HUB_WEB_VERSION__: string;

interface InventoryHubWebReleaseSummary {
  version: string;
  releaseNotes?: string;
  minDesktopVersion: string;
  compatible: boolean;
  clientDownloadUrl?: string;
}

interface InventoryHubWebReleaseStatus {
  phase: "idle" | "checking" | "available" | "downloading" | "importing" | "ready" | "applying" | "failed" | "incompatible";
  currentVersion: string;
  bundledVersion: string;
  source: "bundled" | "imported";
  available?: InventoryHubWebReleaseSummary;
  pending?: InventoryHubWebReleaseSummary;
  downloadProgress?: number;
  message?: string;
  updatedAt: string;
}

interface Window {
  inventoryHub?: {
    selectMediaDirectory?: () => Promise<{
      token: string;
      displayPath?: string;
    } | null>;
    startMediaMigration?: (token: string) => Promise<unknown>;
    setLanEnabled?: (enabled: boolean) => Promise<{
      enabled: boolean;
      restartScheduled: true;
    }>;
    validateMediaDirectory?: (token: string) => Promise<unknown>;
    openManagedPath?: (kind: string) => Promise<unknown>;
    getPrintPreferences?: () => Promise<{
      printerId?: string;
      paper: "40x30" | "50x30";
      terminator: "Enter" | "Tab";
    }>;
    setPrintPreferences?: (preferences: {
      printerId?: string;
      paper: "40x30" | "50x30";
      terminator: "Enter" | "Tab";
    }) => Promise<{
      printerId?: string;
      paper: "40x30" | "50x30";
      terminator: "Enter" | "Tab";
    }>;
    printLabel?: (payload: {
      printerName: string;
      jobName: string;
      label: {
        code: string;
        name: string;
        type: "WAREHOUSE" | "BOX" | "BAG" | "ITEM";
        categories?: Array<{ id?: string; name: string }>;
        specifications?: Array<{ id?: string; name: string }>;
      };
      paper: {
        widthMm: number;
        heightMm: number;
        marginMm: number;
        landscape?: boolean;
      };
    }) => Promise<{ acceptedBySystem: boolean; message?: string }>;
    getEnvironment?: () => Promise<{
      appVersion: string;
      platform: string;
      arch: string;
      mode: "desktop" | "remote";
      serviceOrigin: string;
      lanEnabled: boolean;
      lanOrigin?: string;
      certificateInstallUrl?: string;
      caFingerprint?: string;
      lanAddresses?: string[];
      userDataPath: string;
    }>;
    getServiceStatus?: () => Promise<{
      protocol?: string;
      host?: string;
      port?: number;
      lanEnabled?: boolean;
      url?: string;
    }>;
    getWebReleaseStatus?: () => Promise<InventoryHubWebReleaseStatus>;
    onWebReleaseStatus?: (
      listener: (status: InventoryHubWebReleaseStatus) => void,
    ) => () => void;
    checkWebReleaseUpdate?: () => Promise<InventoryHubWebReleaseStatus>;
    selectWebReleasePackage?: () => Promise<InventoryHubWebReleaseStatus>;
    downloadWebReleaseUpdate?: () => Promise<InventoryHubWebReleaseStatus>;
    applyWebRelease?: () => Promise<{ restartScheduled: boolean }>;
    restoreBundledWebRelease?: () => Promise<{ restartScheduled: boolean }>;
    openWebReleaseClientDownload?: (url: string) => Promise<void>;
    reportWebReleaseReady?: () => Promise<void>;
  };
  inventoryHubRemote?: {
    getEnvironment?: () => Promise<{
      appVersion: string;
      platform: string;
      arch: string;
      mode: "remote";
      serviceOrigin: string;
    }>;
    getStatus?: () => Promise<InventoryHubRemoteStatus>;
    onStatus?: (
      listener: (status: InventoryHubRemoteStatus) => void,
    ) => () => void;
    listPrinters?: () => Promise<
      Array<{
        name: string;
        displayName: string;
        description: string;
        isDefault: boolean;
        status: number;
      }>
    >;
    pair?: (request: {
      code: string;
      printerId: string;
      executorName?: string;
    }) => Promise<InventoryHubRemoteStatus>;
    unpair?: () => Promise<InventoryHubRemoteStatus>;
  };
}

interface InventoryHubRemoteStatus {
  phase:
    | "unpaired"
    | "pairing"
    | "online"
    | "printing"
    | "offline"
    | "attention"
    | "stopped";
  paired: boolean;
  executorId?: string;
  executorName?: string;
  selectedPrinterId?: string;
  currentItemId?: string;
  lastHeartbeatAt?: string;
  message?: string;
  updatedAt: string;
}
