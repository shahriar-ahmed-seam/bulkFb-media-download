#!/usr/bin/env node
/**
 * Package the `extension/` directory into a versioned, store-ready zip.
 *
 * Usage:  node scripts/build-zip.js
 * Output: dist/bulkfb-media-download-v<version>.zip
 *
 * Uses the system zip tooling so there are no runtime dependencies:
 *   - PowerShell Compress-Archive on Windows
 *   - the `zip` CLI on macOS / Linux
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "extension");
const DIST_DIR = path.join(ROOT, "dist");

const manifest = JSON.parse(
  fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"),
);
const version = manifest.version;
const outName = `bulkfb-media-download-v${version}.zip`;
const outPath = path.join(DIST_DIR, outName);

fs.mkdirSync(DIST_DIR, { recursive: true });
if (fs.existsSync(outPath)) fs.rmSync(outPath);

console.log(`Packaging extension v${version} ...`);

if (process.platform === "win32") {
  // Compress the *contents* of extension/ so the zip has no wrapper folder.
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${path.join(EXT_DIR, "*")}' -DestinationPath '${outPath}' -Force`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-r", "-q", outPath, "."], {
    cwd: EXT_DIR,
    stdio: "inherit",
  });
}

const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`Created dist/${outName}  (${kb} KB)`);
