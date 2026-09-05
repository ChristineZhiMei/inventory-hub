import { BrowserWindow } from "electron";
import bwipjs = require("bwip-js");
import { Buffer } from "node:buffer";
import { labelBarcodeOptions, renderLabelHtml } from "@inventory-hub/contracts";
import type { PrinterSummary, PrintLabelRequest, PrintLabelResult } from "../shared/contracts";

const CODE_PATTERN = /^(W|C|I)[0-9]{6,}$/;
const NODE_TYPES = new Set(["WAREHOUSE", "BOX", "BAG", "ITEM"]);

export async function printLabel(
  ownerWindow: BrowserWindow,
  rawRequest: PrintLabelRequest,
): Promise<PrintLabelResult> {
  const request = validateRequest(rawRequest);
  const printers = await ownerWindow.webContents.getPrintersAsync();
  if (!printers.some((printer) => printer.name === request.printerName)) {
    return { acceptedBySystem: false, message: "PRINTER_NOT_FOUND" };
  }

  const barcode = await bwipjs.toBuffer({
    ...labelBarcodeOptions,
    text: request.label.code,
  });
  const html = renderLabelHtml(request.label, request.paper, `data:image/png;base64,${Buffer.from(barcode).toString("base64")}`);
  const printWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
      webSecurity: true,
    },
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await new Promise<PrintLabelResult>((resolveResult) => {
      printWindow.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: request.printerName,
          copies: 1,
          landscape: request.paper.landscape ?? true,
          scaleFactor: 100,
          margins: { marginType: "none" },
          pageSize: {
            width: Math.round(request.paper.widthMm * 1_000),
            height: Math.round(request.paper.heightMm * 1_000),
          },
        },
        (success, failureReason) => {
          resolveResult(
            success
              ? { acceptedBySystem: true }
              : { acceptedBySystem: false, message: failureReason || "PRINT_REJECTED" },
          );
        },
      );
    });
  } catch (error) {
    return { acceptedBySystem: false, message: String(error) };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

export async function listPrinterSummaries(ownerWindow: BrowserWindow): Promise<PrinterSummary[]> {
  const printers = await ownerWindow.webContents.getPrintersAsync();
  return printers
    .map((printer) => {
      const platformOptions = printer.options as Record<string, string>;
      return {
        name: printer.name,
        displayName: printer.displayName,
        description: printer.description,
        isDefault:
          platformOptions.isDefault === "true" ||
          platformOptions["printer-is-default"] === "true",
        status: Number(platformOptions.status ?? platformOptions.printerState ?? 0) || 0,
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function validateRequest(request: PrintLabelRequest): PrintLabelRequest {
  if (!request || typeof request !== "object") throw new Error("INVALID_PRINT_REQUEST");
  if (typeof request.printerName !== "string" || request.printerName.length > 256) {
    throw new Error("INVALID_PRINTER_NAME");
  }
  if (typeof request.jobName !== "string" || request.jobName.trim().length === 0 || request.jobName.length > 120) {
    throw new Error("INVALID_JOB_NAME");
  }
  if (!CODE_PATTERN.test(request.label?.code ?? "")) throw new Error("INVALID_LABEL_CODE");
  if (!NODE_TYPES.has(request.label?.type ?? "")) throw new Error("INVALID_NODE_TYPE");
  if (
    typeof request.label?.name !== "string" ||
    request.label.name.trim().length === 0 ||
    request.label.name.length > 120
  ) {
    throw new Error("INVALID_LABEL_NAME");
  }

  const { widthMm, heightMm, marginMm } = request.paper ?? {};
  if (!isFiniteRange(widthMm, 10, 210) || !isFiniteRange(heightMm, 10, 297)) {
    throw new Error("INVALID_PAPER_SIZE");
  }
  if (!isFiniteRange(marginMm, 0, Math.min(widthMm, heightMm) / 3)) {
    throw new Error("INVALID_PAPER_MARGIN");
  }
  return {
    ...request,
    jobName: request.jobName.trim(),
    label: { ...request.label, name: request.label.name.trim() },
  };
}

function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
