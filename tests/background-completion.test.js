import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");
const completionStart = backgroundSource.indexOf("async function completeTask");
const completionEnd = backgroundSource.indexOf("function characterMessagePayload", completionStart);
const completionSource = backgroundSource.slice(completionStart, completionEnd);

const manualSceneStart = backgroundSource.indexOf('if (message.type === "PREPARE_MANUAL_SCENE")');
const manualSceneEnd = backgroundSource.indexOf('if (message.type === "UPDATE_OPTIONS")', manualSceneStart);
const manualSceneSource = backgroundSource.slice(manualSceneStart, manualSceneEnd);

test("background rejects a scene completion without every requested image URL", () => {
  assert.match(completionSource, /verifiedAssets\.length < expectedImages/);
  assert.match(completionSource, /scheduleSceneAutomaticRetry/);
  assert.match(completionSource, /다운로드 가능한 결과 이미지/);
});

test("manual scene mode pauses the queue and requires a separate user completion", () => {
  assert.match(manualSceneSource, /PREPARE_MANUAL_SCENE_PROMPT/);
  assert.match(manualSceneSource, /target\.status = "manual"/);
  assert.match(manualSceneSource, /state\.status = "paused"/);
  assert.match(manualSceneSource, /COMPLETE_MANUAL_SCENE/);
  assert.match(manualSceneSource, /사용자 확인: Flow 생성 완료/);
});

test("background validates and opens a tracked Flow asset detail", () => {
  assert.match(backgroundSource, /message\.type === "OPEN_ASSET"/);
  assert.match(backgroundSource, /labs\.google/);
  assert.match(backgroundSource, /chrome\.tabs\.create/);
});

test("background supports explicit suffix asset remapping", () => {
  assert.match(backgroundSource, /REASSIGN_ASSETS_FROM_POSITION/);
  assert.match(backgroundSource, /buildAssetSuffixAssignments/);
  assert.match(backgroundSource, /job\.mappedAssetIds = \[\]/);
  assert.match(backgroundSource, /job\.resultAssets = \[\]/);
});

test("scene failure handling finalizes after one retry and keeps the queue moving", () => {
  assert.match(backgroundSource, /canAutomaticallyRetry/);
  assert.match(backgroundSource, /markSceneFailedAndContinue/);
  assert.match(backgroundSource, /MAX_AUTOMATIC_RETRIES/);
});

test("pause control immediately releases the active queue task", () => {
  assert.match(backgroundSource, /draft\.status = "paused"/);
  assert.match(backgroundSource, /draft\.activeJobId = null/);
  assert.match(backgroundSource, /STOP_FLOW_TASK/);
});
