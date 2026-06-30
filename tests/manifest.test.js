import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../extension");

const manifest = JSON.parse(
  fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"),
);

test("manifest is MV3 with required identity fields", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.name.length > 0);
  assert.ok(manifest.description && manifest.description.length <= 132,
    "CWS description must be <= 132 chars");
  assert.match(manifest.version, /^\d+(\.\d+){1,3}$/);
});

test("manifest declares a module service worker", () => {
  assert.ok(manifest.background?.service_worker);
  assert.equal(manifest.background.type, "module");
});

test("manifest requests only the permissions the code uses", () => {
  const allowed = new Set([
    "scripting",
    "storage",
    "tabs",
    "declarativeNetRequest",
    "declarativeNetRequestWithHostAccess",
  ]);
  for (const p of manifest.permissions) {
    assert.ok(allowed.has(p), `unexpected permission: ${p}`);
  }
});

test("host permissions are limited to Facebook", () => {
  for (const h of manifest.host_permissions) {
    assert.match(h, /facebook\.com/);
  }
});

test("every file referenced by the manifest exists on disk", () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.action.default_icon,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
  ].filter(Boolean);

  for (const ref of refs) {
    assert.ok(
      fs.existsSync(path.join(EXT, ref)),
      `manifest references missing file: ${ref}`,
    );
  }
});

test("all declared icon files are non-empty", () => {
  for (const rel of Object.values(manifest.icons)) {
    const size = fs.statSync(path.join(EXT, rel)).size;
    assert.ok(size > 0, `empty icon: ${rel}`);
  }
});
