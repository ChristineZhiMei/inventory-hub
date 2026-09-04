import { startInventoryServer } from "@inventory-hub/core";

const server = await startInventoryServer();

let closing = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (closing) return;
  closing = true;
  process.stdout.write(`[inventory-hub] received ${signal}, closing service\n`);
  try {
    await server.close();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`[inventory-hub] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.stdout.write(`[inventory-hub] listening at ${server.address}\n`);
