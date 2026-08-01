import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectCharacterProfile,
  findProjectCharacterProfile,
  projectIdFromFlowUrl,
  upsertProjectCharacterProfile
} from "../lib/project-history.js";

test("a Flow project ID is extracted from Korean and default project URLs", () => {
  assert.equal(
    projectIdFromFlowUrl("https://labs.google/fx/ko/tools/flow/project/c4f8aa7e-0ed5-4893-9d42-141ddc250f78"),
    "c4f8aa7e-0ed5-4893-9d42-141ddc250f78"
  );
  assert.equal(projectIdFromFlowUrl("https://labs.google/fx/tools/flow/"), "");
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
