import { api } from "./api";

export interface PrintPreferences {
  printerId: string;
  paper: string;
  native: boolean;
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

export function printPreferences(): PrintPreferences {
  let stored: { printerId?: string; paper?: string } = {};
  try {
    stored = JSON.parse(
      localStorage.getItem("inventory-hub:device-preferences") || "{}",
    );
  } catch {
    /* use safe defaults */
  }
  const printerId = stored.printerId || "HPRT-D35-SIMULATOR";
  return {
    printerId,
    paper: stored.paper || "40x30",
    native:
      Boolean(window.inventoryHub?.printLabel) &&
      printerId !== "HPRT-D35-SIMULATOR",
  };
}

export function consumeLocalNativeQueue(): Promise<void> {
  if (!window.inventoryHub?.printLabel) return Promise.resolve();
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
      const result = (await bridge({
        printerName: item.payload.printerId || printPreferences().printerId,
        jobName: `Inventory Hub ${item.payload.node.code}`,
        label: item.payload.node,
        paper: {
          widthMm: paper.widthMm || 40,
          heightMm: paper.heightMm || 30,
          marginMm: paper.marginMm ?? 1.5,
          landscape: paper.orientation === "landscape",
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
