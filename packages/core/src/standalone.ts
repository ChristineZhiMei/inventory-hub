import { startInventoryServer } from "./index.js";
import { registerMediaSelection } from "./native-selections.js";
import {
  registerNativePrintSettings,
  setNativePrintPreferenceWriter,
  type NativePrintPreferences,
} from "./native-print-settings.js";

const server = await startInventoryServer();
console.log(`Inventory Hub API listening at ${server.address}`);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}, closing Inventory Hub API`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  try { await server.close(); process.exitCode = 0; }
  finally { clearTimeout(timer); }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

type ParentPort = {
  on(event: "message", listener: (event: { data?: unknown } | unknown) => void): void;
  postMessage(message: unknown): void;
};
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  setNativePrintPreferenceWriter((preferences: NativePrintPreferences) => {
    parentPort.postMessage({
      type: "inventory-hub:set-print-preferences",
      preferences,
    });
  });
}
parentPort?.on("message", (event) => {
  const message = ((event as { data?: unknown })?.data ?? event) as Record<string, unknown>;
  if (message.type === "inventory-hub:shutdown") void shutdown("utilityProcess parent request");
  if (message.type === "inventory-hub:media-selection" && typeof message.token === "string" && typeof message.path === "string" && typeof message.expiresAt === "number") {
    registerMediaSelection(message.token, message.path, message.expiresAt);
  }
  if (
    message.type === "inventory-hub:native-print-settings" &&
    message.settings &&
    typeof message.settings === "object"
  ) {
    registerNativePrintSettings(message.settings as Parameters<typeof registerNativePrintSettings>[0]);
  }
});
