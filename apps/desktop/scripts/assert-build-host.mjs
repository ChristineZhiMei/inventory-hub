const [expectedPlatform] = process.argv.slice(2);

if (!expectedPlatform || !["darwin", "win32"].includes(expectedPlatform)) {
  console.error("Usage: node scripts/assert-build-host.mjs <darwin|win32>");
  process.exit(2);
}

if (process.platform !== expectedPlatform) {
  const target = expectedPlatform === "win32" ? "Windows" : "macOS";
  console.error(
    `${target} packages must be built on a ${target} host because Inventory Hub contains native ` +
      "better-sqlite3 and Sharp modules. Cross-platform electron-builder output would contain the wrong ABI.",
  );
  process.exit(1);
}
