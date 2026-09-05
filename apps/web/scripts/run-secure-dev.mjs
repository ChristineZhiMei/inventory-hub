import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDirectory = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "Inventory Hub")
  : process.platform === "win32"
    ? join(process.env.APPDATA || homedir(), "Inventory Hub")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Inventory Hub");
const certificateDirectory = process.env.INVENTORY_HUB_LAN_CERT_DIR
  || join(defaultDataDirectory, "security", "lan");
const keyPath = join(certificateDirectory, "server-key.pem");
const certificatePath = join(certificateDirectory, "server-chain.pem");

if (!existsSync(keyPath) || !existsSync(certificatePath)) {
  console.error("未找到局域网 HTTPS 证书。请先在 Electron 设置中开启局域网访问并生成证书。");
  console.error(`证书目录：${certificateDirectory}`);
  process.exit(1);
}

const server = await createServer({
  configFile: join(webDirectory, "vite.config.ts"),
  server: {
    host: "0.0.0.0",
    port: 14239,
    strictPort: true,
    https: {
      key: readFileSync(keyPath),
      cert: readFileSync(certificatePath),
    },
    hmr: {
      protocol: "wss",
      clientPort: 14239,
    },
  },
});

await server.listen();
server.printUrls();
