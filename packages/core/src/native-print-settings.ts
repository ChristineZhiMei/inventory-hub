import { AppError } from "./errors.js";

export interface NativePrinterCapability {
  printerId: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  status: number;
}

export interface NativePrintPreferences {
  printerId?: string;
  paper: "40x30" | "50x30";
  terminator: "Enter" | "Tab";
}

export interface NativePrintSettings extends NativePrintPreferences {
  available: boolean;
  printers: NativePrinterCapability[];
  updatedAt: string;
}

type PreferenceWriter = (preferences: NativePrintPreferences) => void;

let settings: NativePrintSettings = {
  available: false,
  printers: [],
  paper: "40x30",
  terminator: "Enter",
  updatedAt: new Date(0).toISOString(),
};
let writePreferences: PreferenceWriter | undefined;

export function registerNativePrintSettings(next: NativePrintSettings): void {
  settings = normalizeSettings(next);
}

export function getNativePrintSettings(): NativePrintSettings {
  return {
    ...settings,
    printers: settings.printers.map((printer) => ({ ...printer })),
  };
}

export function setNativePrintPreferenceWriter(writer: PreferenceWriter): void {
  writePreferences = writer;
}

export function requestNativePrintPreferences(
  preferences: NativePrintPreferences,
): NativePrintSettings {
  if (!settings.available || !writePreferences) {
    throw new AppError("EXECUTOR_OFFLINE", "Electron 打印服务暂不可用");
  }
  const normalized = normalizePreferences(preferences);
  if (
    !normalized.printerId ||
    !settings.printers.some((printer) => printer.printerId === normalized.printerId)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "所选打印机不在 Electron 可用设备列表中",
      { fields: { printerId: ["请选择 Electron 电脑当前可访问的打印机"] } },
    );
  }
  settings = {
    ...settings,
    ...normalized,
    updatedAt: new Date().toISOString(),
  };
  writePreferences(normalized);
  return getNativePrintSettings();
}

function normalizeSettings(input: NativePrintSettings): NativePrintSettings {
  const printers = Array.isArray(input.printers)
    ? input.printers
        .filter(
          (printer) =>
            printer &&
            typeof printer.printerId === "string" &&
            printer.printerId.trim().length > 0 &&
            printer.printerId.length <= 256,
        )
        .map((printer) => ({
          printerId: printer.printerId.trim(),
          displayName:
            typeof printer.displayName === "string" && printer.displayName.trim()
              ? printer.displayName.trim().slice(0, 256)
              : printer.printerId.trim(),
          description:
            typeof printer.description === "string"
              ? printer.description.slice(0, 500)
              : "",
          isDefault: printer.isDefault === true,
          status: Number.isInteger(printer.status) ? printer.status : 0,
        }))
    : [];
  const preferences = normalizePreferences(input);
  return {
    available: input.available === true,
    printers,
    ...preferences,
    updatedAt:
      typeof input.updatedAt === "string" && !Number.isNaN(Date.parse(input.updatedAt))
        ? input.updatedAt
        : new Date().toISOString(),
  };
}

function normalizePreferences(
  input: Partial<NativePrintPreferences>,
): NativePrintPreferences {
  const printerId =
    typeof input.printerId === "string" ? input.printerId.trim() : "";
  if (printerId.length > 256) {
    throw new AppError("VALIDATION_ERROR", "打印机标识无效", {
      fields: { printerId: ["打印机标识不能超过 256 个字符"] },
    });
  }
  return {
    ...(printerId ? { printerId } : {}),
    paper: input.paper === "50x30" ? "50x30" : "40x30",
    terminator: input.terminator === "Tab" ? "Tab" : "Enter",
  };
}
