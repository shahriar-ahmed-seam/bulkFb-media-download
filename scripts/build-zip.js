#!/usr/bin/env node
/**
 * Package the `extension/` directory into a versioned, store-ready zip.
 *
 * Usage:  npm run build
 * Output: dist/stashly-v<version>.zip
 *
 * Uses the platform's built-in zip tooling so there are no dependencies:
 *   - PowerShell Compress-Archive on Windows
 *   - the `zip` CLI on macOS / Linux
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT, "extension");
const DIST_DIR = path.join(ROOT, "dist");

const manifest = JSON.parse(
  fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"),
);
const version = manifest.version;
const outName = `stashly-v${version}.zip`;
const outPath = path.join(DIST_DIR, outName);

fs.mkdirSync(DIST_DIR, { recursive: true });
if (fs.existsSync(outPath)) fs.rmSync(outPath);

console.log(`Packaging Stashly v${version} ...`);

if (process.platform === "win32") {
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
