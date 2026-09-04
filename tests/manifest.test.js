import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest is valid MV3 and exposes the side panel on Flow", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.9.32");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(manifest.permissions.includes("power"));
  assert.ok(manifest.host_permissions.includes("https://flow-content.google/*"));
  assert.ok(manifest.host_permissions.includes("https://flow.google.com/*"));
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://flow.google.com/project/*"]);
  assert.equal(manifest.host_permissions.includes("https://labs.google/*"), false);
  assert.equal(manifest.host_permissions.includes("https://flow.google/*"), false);
  assert.equal(manifest.host_permissions.includes("https://fow.google/*"), false);
});
