const { existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ARCH_NAMES = new Map([
  [0, "ia32"],
  [1, "x64"],
  [2, "armv7l"],
  [3, "arm64"],
  [4, "universal"],
]);

/**
 * Keep Sharp's target payload and remove optional binaries for every other OS.
 * supportedArchitectures intentionally installs all release targets, but copying
 * them all into every application makes each distributable unnecessarily large.
 */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = typeof context.arch === "number" ? ARCH_NAMES.get(context.arch) : context.arch;
  if (!arch) throw new Error(`Unsupported electron-builder architecture: ${context.arch}`);

  const resourcesDirectory =
    platform === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  const imageModulesDirectory = join(
    resourcesDirectory,
    "app.asar.unpacked",
    "node_modules",
    "@img",
  );

  const required =
    platform === "darwin"
      ? new Set([`sharp-darwin-${arch}`, `sharp-libvips-darwin-${arch}`])
      : platform === "win32"
        ? new Set([`sharp-win32-${arch}`])
        : new Set([`sharp-linux-${arch}`, `sharp-libvips-linux-${arch}`]);

  for (const packageName of required) {
    if (!existsSync(join(imageModulesDirectory, packageName))) {
      throw new Error(`Required Sharp payload is missing for ${platform}-${arch}: ${packageName}`);
    }
  }

  for (const packageName of readdirSync(imageModulesDirectory)) {
    if (!required.has(packageName)) {
      rmSync(join(imageModulesDirectory, packageName), { recursive: true, force: true });
    }
  }
};
