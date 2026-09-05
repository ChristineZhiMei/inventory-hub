import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function lanCertificateDirectory() {
  const dataDirectory = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Inventory Hub")
    : process.platform === "win32"
      ? join(process.env.APPDATA || homedir(), "Inventory Hub")
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Inventory Hub");
  return process.env.INVENTORY_HUB_LAN_CERT_DIR || join(dataDirectory, "security", "lan");
}

function developmentCertificatePortal(): Plugin {
  return {
    name: "inventory-hub-development-certificate-portal",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (pathname !== "/install" && pathname !== "/inventory-hub-ca.cer") {
          next();
          return;
        }
        const certificatePath = join(lanCertificateDirectory(), "ca-cert.pem");
        if (!existsSync(certificatePath)) {
          response.statusCode = 404;
          response.end("请先在 Electron 设置中开启局域网访问并生成证书");
          return;
        }
        const certificate = readFileSync(certificatePath);
        response.setHeader("Cache-Control", "no-store");
        if (pathname === "/inventory-hub-ca.cer") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/x-x509-ca-cert");
          response.setHeader("Content-Disposition", 'attachment; filename="inventory-hub-ca.cer"');
          response.end(certificate);
          return;
        }
        const requestHost = new URL(`http://${request.headers.host || "localhost"}`).hostname;
        const secureUrl = `https://${requestHost}:14239`;
        const fingerprint = new X509Certificate(certificate).fingerprint256;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安装 Inventory Hub 开发证书</title><style>body{margin:0;background:#f4f6fa;color:#172033;font:16px/1.6 system-ui,-apple-system,sans-serif}.card{box-sizing:border-box;width:min(92vw,620px);margin:7vh auto;padding:24px;border:1px solid #d9dfeb;border-radius:18px;background:#fff;box-shadow:0 16px 50px #18233a18}h1{margin:0 0 16px;font-size:24px}.button{display:block;margin:16px 0;padding:12px 16px;border-radius:10px;background:#2563eb;color:#fff;text-align:center;text-decoration:none;font-weight:700}.secondary{background:#eef3ff;color:#1d4ed8}.fingerprint{overflow-wrap:anywhere;padding:12px;border-radius:10px;background:#f4f6fa;font:12px/1.6 ui-monospace,monospace}.notice{padding:12px;border-radius:10px;background:#fff7df;color:#754c00}</style></head><body><main class="card"><h1>安装手机开发证书</h1><p class="notice">如果已经安装过证书但 HTTPS 仍无法打开，请先删除旧的 Inventory Hub 证书描述文件，再安装当前证书。</p><a class="button" href="/inventory-hub-ca.cer">下载当前 CA 证书</a><ol><li>安装下载的描述文件。</li><li>进入“设置 → 通用 → 关于本机 → 证书信任设置”。</li><li>开启 Inventory Hub Local CA 的完全信任。</li><li>彻底关闭浏览器后重新打开。</li></ol><p>SHA-256 指纹</p><div class="fingerprint">${fingerprint}</div><a class="button secondary" href="${secureUrl}">验证并打开 ${secureUrl}</a></main></body></html>`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), developmentCertificatePortal()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "0.0.0.0",
    port: 14237,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:18473", changeOrigin: true } },
  },
  preview: { host: "0.0.0.0", port: 14238, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
