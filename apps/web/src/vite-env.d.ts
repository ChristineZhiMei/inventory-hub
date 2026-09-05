/// <reference types="vite/client" />

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
    listPrinters?: () => Promise<unknown[]>;
    printLabel?: (payload: {
      printerName: string;
      jobName: string;
      label: {
        code: string;
        name: string;
        type: "WAREHOUSE" | "BOX" | "BAG" | "ITEM";
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
