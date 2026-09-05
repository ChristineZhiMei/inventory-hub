export type ServicePhase =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "stopping"
  | "failed"
  | "remote";

export interface ServiceStatus {
  phase: ServicePhase;
  origin: string;
  attempt: number;
  message?: string;
  updatedAt: string;
}

export interface SelectedDirectory {
  token: string;
  displayPath: string;
  expiresAt: string;
}

export interface MediaDirectoryValidation {
  valid: boolean;
  displayPath: string;
  freeBytes?: number;
  reason?: "NOT_WRITABLE" | "SYMLINK_NOT_ALLOWED" | "INVALID_PATH";
}

export type ManagedPathKind = "userData" | "database" | "logs" | "selectedMedia";

export interface DesktopEnvironment {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  mode: "desktop" | "remote";
  serviceOrigin: string;
  lanEnabled: boolean;
  lanOrigin?: string;
  certificateInstallUrl?: string;
  caFingerprint?: string;
  lanAddresses?: string[];
  userDataPath: string;
}

export interface LanConfigurationResult {
  enabled: boolean;
  restartScheduled: true;
}

export interface PrinterSummary {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  status: number;
}

export type PrintableNodeType = "WAREHOUSE" | "BOX" | "BAG" | "ITEM";

export interface PrintLabelRequest {
  printerName: string;
  jobName: string;
  label: {
    code: string;
    name: string;
    type: PrintableNodeType;
  };
  paper: {
    widthMm: number;
    heightMm: number;
    marginMm: number;
    landscape?: boolean;
  };
}

export interface PrintLabelResult {
  acceptedBySystem: boolean;
  message?: string;
}

export interface RemoteDesktopEnvironment {
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  mode: "remote";
  serviceOrigin: string;
}

export type RemotePrintExecutorPhase =
  | "unpaired"
  | "pairing"
  | "online"
  | "printing"
  | "offline"
  | "attention"
  | "stopped";

export interface RemotePrintExecutorStatus {
  phase: RemotePrintExecutorPhase;
  paired: boolean;
  executorId?: string;
  executorName?: string;
  selectedPrinterId?: string;
  currentItemId?: string;
  lastHeartbeatAt?: string;
  message?: string;
  updatedAt: string;
}

export interface RemotePairingRequest {
  code: string;
  printerId: string;
  executorName?: string;
}

export interface InventoryHubRemoteApi {
  getEnvironment(): Promise<RemoteDesktopEnvironment>;
  listPrinters(): Promise<PrinterSummary[]>;
  pair(request: RemotePairingRequest): Promise<RemotePrintExecutorStatus>;
  getStatus(): Promise<RemotePrintExecutorStatus>;
  onStatus(listener: (status: RemotePrintExecutorStatus) => void): () => void;
  unpair(): Promise<RemotePrintExecutorStatus>;
}

export interface InventoryHubDesktopApi {
  getEnvironment(): Promise<DesktopEnvironment>;
  getServiceStatus(): Promise<ServiceStatus>;
  onServiceStatus(listener: (status: ServiceStatus) => void): () => void;
  selectMediaDirectory(): Promise<SelectedDirectory | null>;
  validateMediaDirectory(selectionToken: string): Promise<MediaDirectoryValidation>;
  openManagedPath(kind: ManagedPathKind, selectionToken?: string): Promise<void>;
  setLanEnabled(enabled: boolean): Promise<LanConfigurationResult>;
  listPrinters(): Promise<PrinterSummary[]>;
  printLabel(request: PrintLabelRequest): Promise<PrintLabelResult>;
}
