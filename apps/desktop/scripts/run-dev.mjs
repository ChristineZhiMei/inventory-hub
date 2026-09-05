import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(desktopDirectory, "../..");
const desktopRequire = createRequire(join(desktopDirectory, "package.json"));
const coreRequire = createRequire(join(workspaceDirectory, "packages/core/package.json"));
const sqliteBuild = join(dirname(coreRequire.resolve("better-sqlite3/package.json")), "build");
let activeChild;
let stopping = false;

function run(command, args, options = {}) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, args, { cwd: desktopDirectory, stdio: "inherit", ...options });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code) => {
      if (activeChild === child) activeChild = undefined;
      resolveStatus(code ?? 1);
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    activeChild?.kill(signal);
  });
}

let status = 1;
try {
  // Native builds cannot be shared between host Node and Electron ABIs.
  rmSync(sqliteBuild, { recursive: true, force: true });
  status = await run(process.execPath, [
    desktopRequire.resolve("electron-builder/out/cli/cli.js"),
    "install-app-deps",
  ]);
  if (status === 0 && !stopping) {
    status = await run(desktopRequire("electron"), ["."], {
      env: {
        ...process.env,
        INVENTORY_HUB_DESKTOP_DEV_URL: "http://127.0.0.1:14237",
      },
    });
  }
} catch (error) {
  status = 1;
  console.error(error);
} finally {
  console.log("Restoring SQLite for Node.js development…");
  rmSync(sqliteBuild, { recursive: true, force: true });
  const restored = await run("pnpm", ["--filter", "@inventory-hub/core", "exec", "npm", "rebuild", "better-sqlite3"], {
    cwd: workspaceDirectory,
    shell: process.platform === "win32",
  });
  if (restored !== 0) status = restored;
}
process.exitCode = status;
