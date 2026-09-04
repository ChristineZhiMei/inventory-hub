import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");
const packageRequire = createRequire(join(packageDirectory, "package.json"));
const workspaceRequire = createRequire(join(workspaceDirectory, "packages", "core", "package.json"));

let buildStatus = 1;
let restoreStatus = 1;
try {
  const builderCli = packageRequire.resolve("electron-builder/out/cli/cli.js");
  const result = spawnSync(process.execPath, [builderCli, ...process.argv.slice(2)], {
    cwd: packageDirectory,
    env: process.env,
    stdio: "inherit",
  });
  buildStatus = result.status ?? 1;
  if (result.error) console.error(result.error);
} finally {
  if (process.env.CI === "true") {
    restoreStatus = 0;
  } else {
    // electron-builder rebuilds native modules in the pnpm workspace in place. Always
    // restore better-sqlite3 for the host Node ABI so server/dev commands remain usable.
    // Remove only node-gyp's generated output first: rebuilding a second ABI in the same
    // directory can otherwise reuse stale dependency files left by Electron rebuild.
    const betterSqlitePackage = workspaceRequire.resolve("better-sqlite3/package.json");
    rmSync(join(dirname(betterSqlitePackage), "build"), { recursive: true, force: true });
    const restore = spawnSync(
      "pnpm",
      ["--filter", "@inventory-hub/core", "exec", "npm", "rebuild", "better-sqlite3"],
      {
        cwd: workspaceDirectory,
        env: process.env,
        shell: process.platform === "win32",
        stdio: "inherit",
      },
    );
    restoreStatus = restore.status ?? 1;
    if (restore.error) console.error(restore.error);
  }
}

process.exitCode = buildStatus === 0 && restoreStatus === 0 ? 0 : 1;
