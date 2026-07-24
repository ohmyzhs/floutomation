import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const powerStart = source.indexOf("function shouldKeepDisplayAwake");
const powerEnd = source.indexOf("async function readState", powerStart);
const powerSource = source.slice(powerStart, powerEnd);

test("active queues and downloads keep the display awake", () => {
  assert.match(powerSource, /downloadInProgress/);
  assert.match(powerSource, /"running", "waiting", "pausing"/);
  assert.match(powerSource, /requestKeepAwake\("display"\)/);
  assert.match(powerSource, /releaseKeepAwake\(\)/);
});

test("queue recovery restores the power request after a service worker restart", () => {
  assert.match(source, /async function recoverQueue\(\) \{\s*const state = await readState\(\);\s*syncPowerState\(state\);/);
});
