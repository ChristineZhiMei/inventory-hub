import type { BrowserWindow } from "electron";
import type { DesktopConfigStore } from "./config";
import { listPrinterSummaries } from "./printing";
import type { CoreServiceSupervisor } from "./service-supervisor";
import type {
  LocalPrintPreferences,
  LocalPrintSettings,
} from "../shared/contracts";

export async function applyAndPublishPrintPreferences(options: {
  window: BrowserWindow;
  configStore: DesktopConfigStore;
  service: CoreServiceSupervisor;
  preferences?: LocalPrintPreferences;
}): Promise<LocalPrintSettings> {
  const printers = await listPrinterSummaries(options.window);
  let preferences = options.preferences
    ? options.configStore.setPrintPreferences(options.preferences)
    : options.configStore.getPrintPreferences();

  if (
    preferences.printerId &&
    !printers.some((printer) => printer.name === preferences.printerId)
  ) {
    preferences = options.configStore.setPrintPreferences({
      paper: preferences.paper,
      terminator: preferences.terminator,
    });
  }

  const settings: LocalPrintSettings = {
    available: true,
    ...preferences,
    printers: printers.map((printer) => ({
      printerId: printer.name,
      displayName: printer.displayName,
      description: printer.description,
      isDefault: printer.isDefault,
      status: printer.status,
    })),
    updatedAt: new Date().toISOString(),
  };
  options.service.registerLocalPrintSettings(settings);
  return settings;
}
