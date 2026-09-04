import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectCharacterProfile,
  characterDetailFromFlowUrl,
  findProjectCharacterProfile,
  isFlowUrl,
  projectIdFromFlowUrl,
  upsertProjectCharacterProfile
} from "../lib/project-history.js";

test("flow.google.com character detail URLs expose stable project and character IDs", () => {
  assert.deepEqual(
    characterDetailFromFlowUrl("https://flow.google.com/project/project-a/character/character-b?source=test"),
    {
      projectId: "project-a",
      characterId: "character-b",
      url: "https://flow.google.com/project/project-a/character/character-b"
    }
  );
  assert.equal(characterDetailFromFlowUrl("https://labs.google/fx/ko/tools/flow/project/project-a/character/character-b/"), null);
  assert.equal(characterDetailFromFlowUrl("https://flow.google.com/project/project-a/character"), null);
});

test("Flow project IDs are extracted only from flow.google.com project URLs", () => {
  assert.equal(
    projectIdFromFlowUrl("https://labs.google/fx/ko/tools/flow/project/c4f8aa7e-0ed5-4893-9d42-141ddc250f78"),
    ""
  );
  assert.equal(
    projectIdFromFlowUrl("https://flow.google/project/68a9af2f-a252-4883-900b-c5a1794d7193"),
    ""
  );
  assert.equal(
    projectIdFromFlowUrl("https://flow.google.com/project/eab2930a-6753-4fb3-a20c-accb80166330"),
    "eab2930a-6753-4fb3-a20c-accb80166330"
  );
  assert.equal(
    projectIdFromFlowUrl("https://fow.google/project/68a9af2f-a252-4883-900b-c5a1794d7193"),
    ""
  );
  assert.equal(projectIdFromFlowUrl("https://labs.google/fx/tools/flow/"), "");
});

test("Flow URL recognition accepts only flow.google.com project routes", () => {
  assert.equal(isFlowUrl("https://labs.google/fx/tools/flow/project/project-a"), false);
  assert.equal(isFlowUrl("https://flow.google/project/project-a"), false);
  assert.equal(isFlowUrl("https://flow.google.com/project/project-a"), true);
  assert.equal(isFlowUrl("https://fow.google/project/project-a"), false);
  assert.equal(isFlowUrl("https://flow.google/not-a-project"), false);
  assert.equal(isFlowUrl("https://example.com/project/project-a"), false);
});

test("project history retains character definitions but not scene queues", () => {
  const profile = buildProjectCharacterProfile({
    projectId: "project-a",
    projectTitle: "첫 프로젝트",
    registeredKeys: ["widow"],
    characters: [{
      key: "widow",
      displayName: "과부",
      prompt: "Joseon widow portrait",
      description: "dignified",
      referenceCount: 7,
      status: "completed",
      jobs: [{ prompt: "must not persist" }]
    }],
    now: 100
  });
  const history = upsertProjectCharacterProfile({}, profile);
  const restored = findProjectCharacterProfile(history, "project-a");

  assert.deepEqual(restored.characters, [{
    key: "widow",
    displayName: "과부",
    description: "dignified",
    chapterRange: "",
    prompt: "Joseon widow portrait",
    referenceCount: 7
  }]);
  assert.deepEqual(restored.registeredKeys, ["widow"]);
});

test("saving the same project refreshes its characters without discarding prior registration evidence", () => {
  const first = upsertProjectCharacterProfile({}, buildProjectCharacterProfile({
    projectId: "project-a",
    registeredKeys: ["widow"],
    characters: [{ key: "widow", prompt: "first" }],
    now: 100
  }));
  const refreshed = upsertProjectCharacterProfile(first, buildProjectCharacterProfile({
    projectId: "project-a",
    registeredKeys: ["daughter"],
    characters: [{ key: "widow", prompt: "updated" }, { key: "daughter", prompt: "second" }],
    now: 200
  }));
  const profile = findProjectCharacterProfile(refreshed, "project-a");

  assert.equal(refreshed.profiles.length, 1);
  assert.equal(profile.savedAt, 100);
  assert.deepEqual(profile.registeredKeys, ["widow", "daughter"]);
  assert.equal(profile.characters[0].prompt, "updated");
});

test("project history keeps asset mappings by project ID while character-only saves preserve them", () => {
  const first = upsertProjectCharacterProfile({}, buildProjectCharacterProfile({
    projectId: "project-a",
    characters: [{ key: "widow", prompt: "portrait" }],
    mappingJobs: [{
      sourceMode: "scene",
      sourceNumber: 25,
      title: "장면 025",
      mappedAssetIds: ["manual-25"],
      assets: [
        { assetId: "auto-25a", url: "https://example.test/25a" },
        { assetId: "manual-25", url: "https://example.test/25b" }
      ]
    }],
    now: 100
  }));
  const refreshed = upsertProjectCharacterProfile(first, buildProjectCharacterProfile({
    projectId: "project-a",
    characters: [{ key: "widow", prompt: "new portrait" }],
    now: 200
  }));
  const profile = findProjectCharacterProfile(refreshed, "project-a");

  assert.equal(profile.mappingJobs.length, 1);
  assert.equal(profile.mappingJobs[0].sourceNumber, 25);
  assert.deepEqual(profile.mappingJobs[0].mappedAssetIds, ["manual-25"]);
  assert.deepEqual(profile.mappingJobs[0].assets.map((asset) => asset.assetId), ["auto-25a", "manual-25"]);
});

test("project history keeps the scene roster for scenes that have not produced an image yet", () => {
  const history = upsertProjectCharacterProfile({}, buildProjectCharacterProfile({
    projectId: "project-b",
    characters: [{ key: "suok", prompt: "portrait" }],
    mappingJobs: [
      { sourceMode: "scene", sourceNumber: 1, title: "장면 001", characterRefs: ["suok"] },
      { sourceMode: "scene", sourceNumber: 2, title: "장면 002", characterRefs: ["suok", "hyangi"] },
      {
        sourceMode: "scene",
        sourceNumber: 3,
        title: "장면 003",
        characterRefs: [],
        assets: [{ assetId: "done-3", url: "https://example.test/3" }]
      },
      { sourceMode: "scene", sourceNumber: 4 }
    ],
    now: 100
  }));
  const profile = findProjectCharacterProfile(history, "project-b");

  // Scenes 1-2 carry no image yet; they are still part of the project.
  assert.deepEqual(profile.mappingJobs.map((job) => job.sourceNumber), [1, 2, 3]);
  assert.deepEqual(profile.mappingJobs[1].characterRefs, ["suok", "hyangi"]);
  assert.deepEqual(profile.mappingJobs[0].assets, []);
  assert.equal(profile.mappingJobs[0].title, "장면 001");
  // Scene 4 has nothing to remember at all, so it stays dropped.
  assert.equal(profile.mappingJobs.length, 3);
});
