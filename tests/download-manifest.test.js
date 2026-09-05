import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDownloadManifest,
  sanitizeArchiveFilename,
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
    characterAssets: [{ name: "saebyeol", url: "https://example.test/character" }]
  });

  assert.equal(manifest.folder, "Scene_Images");
  assert.equal(manifest.archiveFilename, "바보가_된_거상의_딸.zip");
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
    characterAssets: []
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

test("download manifest uses tracked asset IDs and labels intro and thumbnail jobs", () => {
  const state = createInitialState();
  state.jobs = createJobs([
    { index: 0, number: 1, sourceNumber: 1, sourceMode: "scene", prompt: "scene" },
    { index: 1, number: 1, sourceNumber: 1, sourceMode: "intro", prompt: "intro" },
    { index: 2, number: 1, sourceNumber: 1, sourceMode: "thumbnail", prompt: "thumbnail" }
  ]).map((job, index) => ({ ...job, index }));
  state.jobs[0].resultAssets = [
    { assetId: "scene-b", url: "https://example.test/scene-b" },
    { assetId: "scene-a", url: "https://example.test/scene-a" }
  ];
  state.jobs[1].resultAssets = [
    { assetId: "intro-1", url: "https://example.test/intro-1" },
    { assetId: "intro-2", url: "https://example.test/intro-2" }
  ];
  state.jobs[2].resultAssets = [
    { assetId: "thumbnail-1", url: "https://example.test/thumbnail-1" }
  ];
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [
      { assetId: "scene-a", url: "https://example.test/scene-a" },
      { assetId: "intro-2", url: "https://example.test/intro-2" },
      { assetId: "scene-b", url: "https://example.test/scene-b" },
      { assetId: "intro-1", url: "https://example.test/intro-1" },
      { assetId: "thumbnail-1", url: "https://example.test/thumbnail-1" }
    ],
    characterAssets: []
  });

  assert.deepEqual(manifest.entries.map((entry) => [entry.url, entry.filename.split("/").pop()]), [
    ["https://example.test/scene-b", "001-1.jpeg"],
    ["https://example.test/scene-a", "001-2.jpeg"],
    ["https://example.test/intro-1", "intro1-1.jpeg"],
    ["https://example.test/intro-2", "intro1-2.jpeg"],
    ["https://example.test/thumbnail-1", "thumbnail-1.jpeg"]
  ]);
});

test("download manifest keeps every actual result and numbers variable-size scenes", () => {
  const state = createInitialState();
  state.jobs = createJobs([
    { number: 1, prompt: "one" },
    { number: 2, prompt: "two" }
  ]);
  state.jobs[0].resultAssets = [
    { assetId: "a-1", url: "https://example.test/a-1" }
  ];
  state.jobs[1].resultAssets = [
    { assetId: "b-1", url: "https://example.test/b-1" },
    { assetId: "b-2", url: "https://example.test/b-2" },
    { assetId: "b-3", url: "https://example.test/b-3" },
    { assetId: "b-4", url: "https://example.test/b-4" }
  ];
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [...state.jobs.flatMap((job) => job.resultAssets)],
    characterAssets: []
  });
  assert.deepEqual(manifest.entries.map((entry) => entry.filename), [
    "Scene_Images/001-1.jpeg",
    "Scene_Images/002-1.jpeg",
    "Scene_Images/002-2.jpeg",
    "Scene_Images/002-3.jpeg",
    "Scene_Images/002-4.jpeg"
  ]);
  assert.deepEqual(manifest.sceneAssetCounts.map((entry) => entry.count), [1, 4]);
  assert.deepEqual(manifest.missingScenes, []);
});

test("manual asset mapping overrides scan order and fixes the asset ID to one scene", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ number: 1, prompt: "one" }, { number: 2, prompt: "two" }]);
  state.jobs[0].mappedAssetIds = ["asset-3", "asset-1"];
  state.jobs[1].resultAssets = [{ assetId: "asset-2", url: "https://example.test/2" }];
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [
      { assetId: "asset-1", url: "https://example.test/1" },
      { assetId: "asset-2", url: "https://example.test/2" },
      { assetId: "asset-3", url: "https://example.test/3" }
    ],
    characterAssets: []
  });
  assert.deepEqual(manifest.entries.slice(0, 2).map((entry) => [entry.assetId, entry.filename]), [
    ["asset-3", "Scene_Images/001-1.jpeg"],
    ["asset-1", "Scene_Images/001-2.jpeg"]
  ]);
  assert.deepEqual(manifest.mappingWarnings, []);
});

test("download manifest keeps automatic results when a scene also has manual mappings", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ number: 25, prompt: "scene 25" }]);
  state.jobs[0].resultAssets = [
    { assetId: "auto-1", url: "https://example.test/auto-1" },
    { assetId: "auto-2", url: "https://example.test/auto-2" }
  ];
  state.jobs[0].mappedAssetIds = ["manual-1", "manual-2"];
  const manifest = buildDownloadManifest({
    state,
    projectTitle: "project",
    orderedSceneAssets: [
      ...state.jobs[0].resultAssets,
      { assetId: "manual-1", url: "https://example.test/manual-1" },
      { assetId: "manual-2", url: "https://example.test/manual-2" }
    ],
    characterAssets: []
  });

  assert.deepEqual(manifest.entries.map((entry) => entry.filename), [
    "Scene_Images/025-1.jpeg",
    "Scene_Images/025-2.jpeg",
    "Scene_Images/025-3.jpeg",
    "Scene_Images/025-4.jpeg"
  ]);
  assert.deepEqual(manifest.entries.map((entry) => entry.assetId), ["auto-1", "auto-2", "manual-1", "manual-2"]);
});

test("download path segments remove file-system separators", () => {
  assert.equal(sanitizePathSegment('a/b:c*?"<>|'), "a-b-c------");
});

test("archive filenames use the normalized Flow project title", () => {
  assert.equal(
    sanitizeArchiveFilename("015_종으로 팔려간 며느리 등의 점 세 개"),
    "015_종으로_팔려간_며느리_등의_점_세_개"
  );
  assert.equal(sanitizeArchiveFilename("title/with:unsafe*chars"), "title_with_unsafe_chars");
});
