import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "..", "..");
const webPackage = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
const desktopPackage = JSON.parse(readFileSync(join(workspaceDirectory, "apps", "desktop", "package.json"), "utf8"));
const options = parseOptions(process.argv.slice(2));
const uiVersion = normalizeVersion(options.version || process.env.INVENTORY_HUB_WEB_VERSION || webPackage.version);
const minDesktopVersion = normalizeVersion(options.minDesktop || process.env.INVENTORY_HUB_MIN_DESKTOP_VERSION || webPackage.inventoryHub?.minDesktopVersion);
const releaseNotes = options.notes || process.env.INVENTORY_HUB_WEB_RELEASE_NOTES || webPackage.inventoryHub?.releaseNotes || "界面功能与体验更新";
if (compareVersions(minDesktopVersion, desktopPackage.version) > 0) {
  throw new Error("Minimum compatible desktop version exceeds the configured desktop version.");
}
const distDirectory = resolve(packageDirectory, "dist");
const outputDirectory = resolve(options.output || join(packageDirectory, "release"));

if (!existsSync(join(distDirectory, "index.html"))) {
  throw new Error("Web build not found. Run the web build before packaging the release.");
}

const files = walk(distDirectory)
  .filter((path) => !path.endsWith(".map") && path !== ".inventory-hub-web.json")
  .map((path) => {
    const content = readFileSync(join(distDirectory, ...path.split("/")));
    return {
      path,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content: content.toString("base64"),
    };
  });
const payloadSha256 = digestFileIndex(files);
const manifest = {
  format: "inventory-hub-web-package",
  formatVersion: 1,
  uiVersion,
  createdAt: new Date().toISOString(),
  minDesktopVersion,
  desktopApiVersion: 1,
  coreApiVersion: 1,
  releaseNotes,
  clientDownloadUrl: `https://github.com/ChristineZhiMei/inventory-hub/releases/tag/v${minDesktopVersion}`,
  fileCount: files.length,
  payloadSha256,
};
const envelope = { manifest, files };
const packageBytes = gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 });
const packageName = `inventory-hub-web-${uiVersion}.ihweb`;
const metadataName = `inventory-hub-web-${uiVersion}.json`;
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, packageName), packageBytes);
writeFileSync(join(outputDirectory, metadataName), `${JSON.stringify(manifest, null, 2)}\n`);

const verification = JSON.parse(gunzipSync(readFileSync(join(outputDirectory, packageName))).toString("utf8"));
if (verification.manifest.payloadSha256 !== payloadSha256 || verification.files.length !== files.length) {
  throw new Error("Generated web release package failed verification.");
}
console.log(`Created ${packageName} (${packageBytes.byteLength} bytes, ${files.length} files)`);
console.log(`Created ${metadataName}`);

function walk(root) {
  const results = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stats = statSync(absolute);
        if (stats.size > 50 * 1024 * 1024) throw new Error(`Web asset is too large: ${absolute}`);
        results.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return results.sort(comparePath);
}

function digestFileIndex(files) {
  const index = [...files]
    .sort((left, right) => comparePath(left.path, right.path))
    .map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`)
    .join("");
  return createHash("sha256").update(index).digest("hex");
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--version") result.version = value;
    else if (key === "--min-desktop") result.minDesktop = value;
    else if (key === "--notes") result.notes = value;
    else if (key === "--output") result.output = value;
    else continue;
    index += 1;
  }
  return result;
}
