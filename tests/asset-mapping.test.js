import assert from "node:assert/strict";
import test from "node:test";
import { buildAssetSuffixAssignments } from "../lib/asset-mapping.js";

const catalog = (count) => Array.from({ length: count }, (_, index) => ({ assetId: `asset-${index + 1}`, url: `https://example.test/${index + 1}` }));

test("suffix remapping starts at the selected image and scene", () => {
  const result = buildAssetSuffixAssignments({
    catalog: catalog(7),
    imagesPerPrompt: 2,
    startAssetKey: "asset-4",
    startJobId: "scene-2",
    jobs: [
      { id: "scene-1", sourceMode: "scene", imagesGenerated: 1 },
      { id: "scene-2", sourceMode: "scene", imagesGenerated: 2 },
      { id: "scene-3", sourceMode: "scene", imagesGenerated: 1 }
    ]
  });

  assert.deepEqual(result.assignments.map(({ assetKey, jobId }) => [assetKey, jobId]), [
    ["asset-4", "scene-2"],
    ["asset-5", "scene-2"],
    ["asset-6", "scene-3"]
  ]);
  assert.equal(result.startAssetIndex, 3);
  assert.equal(result.startJobIndex, 1);
});
test("suffix remapping resolves the selected asset through any catalog alias", () => {
  const result = buildAssetSuffixAssignments({
    catalog: [
      { assetId: "asset-1", detailUrl: "https://flow.test/1", url: "https://cdn.test/1" },
      { assetId: "asset-2", url: "https://cdn.test/2" }
    ],
    imagesPerPrompt: 1,
    startAssetKey: "https://flow.test/1",
    startJobId: "scene-1",
    jobs: [{ id: "scene-1", sourceMode: "scene" }]
  });

  assert.deepEqual(result.assignments.map(({ assetKey, jobId }) => [assetKey, jobId]), [["asset-1", "scene-1"]]);
  assert.deepEqual([...result.suffixAssetKeys], ["asset-1", "asset-2"]);
});

test("suffix remapping excludes character tasks", () => {
  const result = buildAssetSuffixAssignments({
    catalog: catalog(2),
    imagesPerPrompt: 1,
    startAssetKey: "asset-1",
    startJobId: "scene-1",
    jobs: [
      { id: "character-1", sourceMode: "character" },
      { id: "scene-1", sourceMode: "scene" }
    ]
  });

  assert.deepEqual(result.assignments.map(({ assetKey, jobId }) => [assetKey, jobId]), [["asset-1", "scene-1"]]);
});
