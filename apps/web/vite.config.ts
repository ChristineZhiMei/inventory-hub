import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
