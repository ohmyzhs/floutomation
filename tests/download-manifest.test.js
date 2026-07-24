import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDownloadManifest,
  sanitizePathSegment
} from "../lib/download-manifest.js";
import { createCharacters, createInitialState, createJobs } from "../lib/queue-state.js";

test("download manifest trusts oldest-first Flow card order and does not read prompts", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ number: 1, prompt: "scene one" }, { number: 2, prompt: "scene two" }]);
  state.characters = createCharacters([{ key: "saebyeol", displayName: "새별", prompt: "portrait" }], { alreadyRegistered: true });
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "바보가 된/거상의 딸",
    orderedSceneAssets: [
      { url: "https://example.test/1a" },
      { url: "https://example.test/1b" },
      { url: "https://example.test/2a" },
      { url: "https://example.test/2b" }
    ],
    characterAssets: [{ name: "saebyeol", url: "https://example.test/character" }],
    now: new Date(2026, 6, 20, 13, 45, 6)
  });

  assert.equal(manifest.folder, "Flow Batch Studio/바보가 된-거상의 딸-20260720-134506");
  assert.deepEqual(manifest.entries.map((entry) => entry.filename), [
    `${manifest.folder}/001-1.jpeg`,
    `${manifest.folder}/001-2.jpeg`,
    `${manifest.folder}/002-1.jpeg`,
    `${manifest.folder}/002-2.jpeg`,
    `${manifest.folder}/saebyeol.jpeg`
  ]);
  assert.deepEqual(manifest.missingScenes, []);
  assert.deepEqual(manifest.missingCharacters, []);
  assert.equal(manifest.scannedSceneCount, 4);
  assert.equal(manifest.expectedSceneCount, 4);
});

test("download manifest retains ordinal pairing even when queue status is stale", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ number: 1, prompt: "one" }, { number: 2, prompt: "two" }]);
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [
      { url: "https://example.test/oldest-a" },
      { url: "https://example.test/oldest-b" },
      { url: "https://example.test/newest-a" },
      { url: "https://example.test/newest-b" }
    ],
    characterAssets: [],
    now: new Date(2026, 6, 20, 13, 45, 6)
  });
  assert.deepEqual(manifest.entries.map((entry) => [entry.url, entry.filename.split("/").pop()]), [
    ["https://example.test/oldest-a", "001-1.jpeg"],
    ["https://example.test/oldest-b", "001-2.jpeg"],
    ["https://example.test/newest-a", "002-1.jpeg"],
    ["https://example.test/newest-b", "002-2.jpeg"]
  ]);
});

test("download manifest ignores scene cards after the requested ordinal range", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ number: 1, prompt: "one" }]);
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [
      { url: "https://example.test/001-a" },
      { url: "https://example.test/001-b" },
      { url: "https://example.test/extra" }
    ],
    characterAssets: []
  });
  assert.equal(manifest.extraSceneCount, 1);
  assert.deepEqual(manifest.entries.map((entry) => entry.url), [
    "https://example.test/001-a",
    "https://example.test/001-b"
  ]);
});

test("download path segments remove file-system separators", () => {
  assert.equal(sanitizePathSegment('a/b:c*?"<>|'), "a-b-c------");
});
