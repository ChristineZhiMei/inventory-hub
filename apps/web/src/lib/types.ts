export type NodeType = "WAREHOUSE" | "BOX" | "BAG" | "ITEM";
export type StockStatus = "IN_STOCK" | "OUT" | "DISCARDED";
export type InventoryAction =
  | "MOVE"
  | "REMOVE"
  | "CHECK_OUT"
  | "CHECK_IN"
  | "DISCARD"
  | "RESTORE";

export interface ImageMeta {
  id: string;
  url?: string;
  thumbUrl?: string;
  mainUrl?: string;
  sortOrder?: number;
  width?: number;
  height?: number;
}

export interface Category {
  id: string;
  name: string;
  parentId?: string | null;
  version: number;
  referenceCount?: number;
  referenceToken?: string;
  childCount?: number;
  children?: Category[];
}
export interface Tag {
  id: string;
  name: string;
  version: number;
  referenceCount?: number;
  referenceToken?: string;
}

export interface InventoryNode {
  id: string;
  code: string;
  type: NodeType;
  name: string;
  notes?: string | null;
  parentId?: string | null;
  stockStatus?: StockStatus | null;
  version: number;
  locationVersion: number;
  locationToken?: string;
  subtreeToken?: string;
  isSystemStaging?: boolean;
  categoryId?: string | null;
  category?: Category | null;
  specification?: string | null;
  tags?: Tag[];
  images?: ImageMeta[];
  path?: Array<Pick<InventoryNode, "id" | "code" | "name" | "type">>;
  lastPath?: Array<Pick<InventoryNode, "id" | "code" | "name" | "type">>;
  createdAt?: string;
  updatedAt?: string;
  depth?: number;
  ancestorIds?: string[];
  directContainerCount?: number;
  directItemCount?: number;
  recursiveItemCount?: number;
}

export interface PageData<T> {
  items: T[];
  nextCursor?: string | null;
  treeToken?: string;
  total?: number;
  counts?: {
    directContainers?: number;
    directItems?: number;
    recursiveItems?: number;
  };
  root?: InventoryNode;
}
export interface User {
  id: string;
  username: string;
  expiresAt?: string;
  csrfToken?: string;
}
export interface SetupStatus {
  initialized: boolean;
  localSetupAllowed: boolean;
  setupTokenRequired?: boolean;
  reason?: string;
}

export interface Operation {
  id: string;
  requestId?: string;
  action: string;
  summary: string;
  reason?: string | null;
  subjectId?: string | null;
  reversesOperationId?: string | null;
  createdAt: string;
  canReverse?: boolean;
  targets?: Array<{
    nodeId: string;
    code: string;
    name?: string;
    directlyOperated: boolean;
    before?: unknown;
    after?: unknown;
  }>;
}

export interface OperationPreview {
  valid: boolean;
  action: InventoryAction;
  target?: InventoryNode;
  roots: Array<
    InventoryNode & { affectedCount?: number; recursiveItemCount?: number }
  >;
  affectedCount: number;
  errors?: Array<{ code: string; message: string; nodeId?: string }>;
  targetLocationToken?: string;
}

export type PrintItemState =
  | "QUEUED"
  | "SENDING"
  | "SUBMITTED"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELLED";
export interface PrintJob {
  id: string;
  executorId?: string;
  status: "ATTENTION" | "RUNNING" | "QUEUED" | "CANCELLED" | "SETTLED";
  paused?: boolean;
  pauseReason?: string | null;
  printerId?: string;
  createdAt: string;
  counts: Partial<Record<PrintItemState, number>>;
  items?: Array<{
    id: string;
    ordinal: number;
    state: PrintItemState;
    code: string;
    name: string;
    copyIndex: number;
    payloadSnapshot?: {
      paper?: { widthMm: number; heightMm: number; marginMm: number };
    };
    error?: string;
  }>;
}

export interface PrintExecutor {
  id: string;
  deviceId: string;
  name: string;
  state: "ONLINE" | "OFFLINE" | "REVOKED" | string;
  lastSeenAt: string;
  capabilities?: {
    selectedPrinterId?: string;
    printerId?: string;
    defaultPrinterId?: string;
    printerIds?: string[];
    printers?: Array<
      string | { printerId?: string; id?: string; name?: string; displayName?: string }
    >;
    [key: string]: unknown;
  };
}

export interface PrintPairing {
  pairingId: string;
  code: string;
  expiresAt: string;
}

export interface DashboardData {
  counts: {
    items: number;
    bags: number;
    boxes: number;
    warehouses: number;
    staging: number;
    attention?: number;
  };
  recentOperations: Operation[];
  stagingItems: InventoryNode[];
}

export interface Capabilities {
  deploymentMode: "desktop" | "server" | "web";
  desktopBridge: boolean;
  camera: boolean;
  printing: boolean;
  simulatedPrinting?: boolean;
  supportedUploadFormats: string[];
  uploadMaxBytes: number;
  serviceName?: string;
  service?: {
    protocol?: string;
    host?: string;
    port?: number;
    lanEnabled?: boolean;
    url?: string;
  };
  lan?: {
    enabled: boolean;
    protocol?: string;
    host?: string;
    port?: number;
    url?: string;
    certificateTrusted?: boolean;
  };
}

export interface StorageStatus {
  state: "UNCONFIGURED" | "ONLINE" | "OFFLINE" | "MIGRATING";
  configured?: boolean;
  mediaRootAccessible?: boolean;
  displayPath?: string;
  freeBytes?: number;
  cleanupPending?: number;
  message?: string;
}
export interface RuntimeStatus {
  appMode?: string;
  host?: string;
  port?: number;
  protocol?: string;
  secureContext?: boolean;
  sqliteVersion?: string;
  schemaVersion?: number;
  dataRevision?: number;
  lanEnabled?: boolean;
  url?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string | string[]>;
  details?: Record<string, unknown>;
  retryable?: boolean;
}
