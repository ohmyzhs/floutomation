import assert from "node:assert/strict";
import test from "node:test";
import { buildRemainingAssetAssignments } from "../lib/asset-mapping.js";

const catalog = (count) => Array.from({ length: count }, (_, index) => ({ assetId: `asset-${index + 1}`, url: `https://example.test/${index + 1}` }));

test("remaining asset mapping keeps existing automatic and manual assignments", () => {
  const result = buildRemainingAssetAssignments({
    catalog: catalog(6),
    imagesPerPrompt: 2,
    jobs: [
      { id: "scene-1", sourceMode: "scene", resultAssets: [{ assetId: "asset-1" }], mappedAssetIds: ["asset-2"] },
      { id: "scene-2", sourceMode: "scene", resultAssets: [{ assetId: "asset-4" }] }
    ]
  });

  assert.deepEqual(result.map(({ assetKey, jobId }) => [assetKey, jobId]), [["asset-3", "scene-2"]]);
});

test("recorded variable image counts determine the remaining slots", () => {
  const result = buildRemainingAssetAssignments({
    catalog: catalog(6),
    imagesPerPrompt: 2,
    jobs: [
      { id: "scene-1", sourceMode: "scene", imagesGenerated: 1, resultAssets: [{ assetId: "asset-1" }] },
      { id: "scene-2", sourceMode: "scene", imagesGenerated: 3, resultAssets: [{ assetId: "asset-5" }] }
    ]
  });

  assert.deepEqual(result.map(({ assetKey, jobId }) => [assetKey, jobId]), [
    ["asset-2", "scene-2"],
    ["asset-3", "scene-2"]
  ]);
});

test("asset aliases and character tasks are resolved without creating mappings", () => {
  const result = buildRemainingAssetAssignments({
    catalog: [
      { assetId: "asset-1", detailUrl: "https://flow.test/1", url: "https://cdn.test/1" },
      { assetId: "asset-2", url: "https://cdn.test/2" }
    ],
    imagesPerPrompt: 2,
    jobs: [
      { id: "character-1", sourceMode: "character", resultAssets: [{ assetId: "asset-1" }] },
      { id: "scene-1", sourceMode: "scene", mappedAssetIds: ["https://flow.test/1"] }
    ]
  });

  assert.deepEqual(result.map(({ assetKey, jobId }) => [assetKey, jobId]), [["asset-2", "scene-1"]]);
});
