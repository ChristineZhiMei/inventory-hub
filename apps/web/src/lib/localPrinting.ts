import { api } from "./api";

export interface PrintPreferences {
  printerId: string;
  paper: "40x30" | "50x30";
  terminator: "Enter" | "Tab";
  native: boolean;
}

export interface NativePrintSettings {
  available: boolean;
  printerId?: string;
  paper: "40x30" | "50x30";
  terminator: "Enter" | "Tab";
  printers: Array<{
    printerId: string;
    displayName: string;
    description: string;
    isDefault: boolean;
    status: number;
  }>;
  updatedAt: string;
}

interface NativeClaim {
  item: null | {
    id: string;
    jobId: string;
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
  };
}

let activeConsumer: Promise<void> | null = null;
let cachedPreferences: PrintPreferences = {
  printerId: "",
  paper: "40x30",
  terminator: "Enter",
  native: false,
};

export function printPreferences(): PrintPreferences {
  return { ...cachedPreferences };
}

export async function refreshPrintPreferences(): Promise<PrintPreferences> {
  const bridge = window.inventoryHub;
  if (!bridge?.getPrintPreferences) return printPreferences();
  let preferences = await bridge.getPrintPreferences();
  if (!preferences.printerId && bridge.setPrintPreferences) {
    const legacy = readLegacyPreferences();
    if (legacy.printerId && legacy.printerId !== "HPRT-D35-SIMULATOR") {
      try {
        preferences = await bridge.setPrintPreferences({
          printerId: legacy.printerId,
          paper: legacy.paper === "50x30" ? "50x30" : "40x30",
          terminator: legacy.terminator === "Tab" ? "Tab" : "Enter",
        });
      } catch {
        // The old browser preference may reference a removed printer.
      }
    }
    localStorage.removeItem("inventory-hub:device-preferences");
  }
  cachedPreferences = {
    printerId: preferences.printerId || "",
    paper: preferences.paper,
    terminator: preferences.terminator,
    native: Boolean(bridge.printLabel && preferences.printerId),
  };
  return printPreferences();
}

export function rememberPrintPreferences(
  preferences: Pick<PrintPreferences, "printerId" | "paper" | "terminator">,
): void {
  cachedPreferences = {
    ...preferences,
    native: Boolean(window.inventoryHub?.printLabel && preferences.printerId),
  };
}

export async function consumeLocalNativeQueue(): Promise<void> {
  if (!window.inventoryHub?.printLabel) return Promise.resolve();
  const preference = await refreshPrintPreferences();
  if (!preference.native)
    return Promise.reject(new Error("请先在设置中选择本机打印机"));
  if (activeConsumer) return activeConsumer;
  activeConsumer = consumeSerially().finally(() => {
    activeConsumer = null;
  });
  return activeConsumer;
}

async function consumeSerially() {
  const bridge = window.inventoryHub?.printLabel;
  if (!bridge) return;
  while (true) {
    const claim = await api<NativeClaim>("/print-native/claim", {
      method: "POST",
      idempotent: true,
      body: {},
    });
    if (!claim.item) return;
    const { item } = claim;
    const paper = item.payload.paper || {};
    let state: "SUBMITTED" | "FAILED" | "UNKNOWN" = "UNKNOWN";
    let evidence = "桌面打印调用未返回结果";
    try {
      const preference = await refreshPrintPreferences();
      const requestedPrinter = item.payload.printerId;
      const result = (await bridge({
        printerName:
          !requestedPrinter || requestedPrinter === "local-default"
            ? preference.printerId
            : requestedPrinter,
        jobName: `Inventory Hub ${item.payload.node.code}`,
        label: item.payload.node,
        paper: {
          widthMm: paper.widthMm || 40,
          heightMm: paper.heightMm || 30,
          marginMm: paper.marginMm ?? 1.5,
          // D35 labels are defined as width × feed length. Send them through the
          // horizontal print path so Chromium and the driver use the same origin.
          landscape: true,
        },
      })) as { acceptedBySystem?: boolean; message?: string };
      state = result.acceptedBySystem === true ? "SUBMITTED" : "FAILED";
      evidence =
        result.message ||
        (state === "SUBMITTED"
          ? "操作系统已接受打印任务"
          : "操作系统明确拒绝打印任务");
    } catch (error) {
      state = "UNKNOWN";
      evidence = error instanceof Error ? error.message : "桌面打印调用异常";
    }
    await api(`/print-native/items/${item.id}/report`, {
      method: "POST",
      idempotent: true,
      body: {
        attemptNo: item.attemptNo,
        claimToken: item.claimToken,
        state,
        evidence,
      },
    });
    if (state !== "SUBMITTED") return;
  }
}

function readLegacyPreferences(): {
  printerId?: string;
  paper?: string;
  terminator?: string;
} {
  try {
    return JSON.parse(
      localStorage.getItem("inventory-hub:device-preferences") || "{}",
    );
  } catch {
    return {};
  }
}
