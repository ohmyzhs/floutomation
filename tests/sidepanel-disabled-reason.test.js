import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
const reasonStart = source.indexOf("function applyQueueDisabledReason");
const reasonEnd = source.indexOf("function startQueueDisabledReason", reasonStart);
const applyReasonSource = source.slice(reasonStart, reasonEnd);

test("disabled queue application tells the user which character bindings are missing", () => {
  assert.match(applyReasonSource, /uniqueUnknownCharacterKeys/);
  assert.match(applyReasonSource, /Flow와 동기화/);
});

test("disabled controls expose both a tooltip and visible reason text", () => {
  assert.match(source, /hint\.title = message/);
  assert.match(source, /reasonElement\.textContent = reason \? `비활성화 이유/);
  assert.match(source, /queueControlReason/);
});

test("connection status is checked manually without a polling loop", () => {
  assert.match(source, /let flowCheckInFlight = false/);
  assert.match(source, /send\("CHECK_FLOW"\)/);
  assert.match(source, /if \(flowCheckInFlight\) return null/);
  assert.doesNotMatch(source, /checkFlow\(\{ notify: false \}\).*2_000/);
});

test("queue reset clears both scene and intro prompt drafts", () => {
  assert.match(source, /flowBatchPromptDraft/);
  assert.match(source, /flowBatchIntroDraft/);
  assert.match(source, /flowBatchThumbnailDraft/);
  assert.match(source, /chrome\.storage\.local\.remove/);
  assert.match(source, /elements\.promptSource\.value = ""/);
});

test("sidepanel uses combined character and image task totals", () => {
  assert.match(source, /summary\.totalTasks/);
  assert.match(source, /summary\.completedTasks/);
  assert.match(source, /summary\.remainingTasks/);
});

test("random delay disables the fixed delay slider", () => {
  assert.match(source, /elements\.delayRange\.disabled = Boolean\(state\.activeJobId\) \|\| Boolean\(state\.options\.randomDelay\)/);
  assert.match(source, /60~90초 사이 랜덤으로 대기합니다/);
});

test("job cards separate work actions from state controls and expose asset navigation", () => {
  assert.match(source, /job-action-group/);
  assert.match(source, /job-state-controls/);
  assert.match(source, /data-open-asset/);
  assert.match(source, /resultAssets/);
  assert.match(source, /OPEN_ASSET/);
});

test("job cards expose every tracked result as a numbered thumbnail button", () => {
  assert.match(source, /displayAssetsForJob/);
  assert.match(source, /job-asset-button/);
  assert.match(source, /#\$\{assetIndex \+ 1\}/);
  assert.match(source, /OPEN_IMAGE/);
});

test("asset mapping reflects automatic and manual job assignments", () => {
  assert.match(source, /job\.resultAssets/);
  assert.match(source, /source: "auto"/);
  assert.match(source, /source: "manual"/);
  assert.match(source, /asset-mapping-source/);
});

test("asset mapping can filter to unassigned images", () => {
  assert.match(source, /showUnassignedOnly/);
  assert.match(source, /unassignedOnlyToggle/);
  assert.match(source, /visibleCatalog/);
});

test("stale asset mappings are visible and can be disconnected", () => {
  assert.match(source, /orphanAssignments/);
  assert.match(source, /Flow 목록에 없는 연결/);
  assert.match(source, /data-remove-job-asset/);
  assert.match(source, /UNMAP_ASSET_FROM_JOB/);
});

test("asset disconnect controls are scoped to thumbnail wrappers", () => {
  assert.match(source, /<span class="job-asset-wrap"><button class="job-asset-button"/);
  assert.match(source, /class="job-asset-remove"/);
});

test("asset mapping exposes an explicit suffix remapping action", () => {
  assert.match(source, /fillFromAssetSelect/);
  assert.match(source, /fillFromJobSelect/);
  assert.match(source, /REASSIGN_ASSETS_FROM_POSITION/);
  assert.match(source, /선택한 이미지와 장면부터 이후 매핑을 번호 순서대로 다시 지정합니다/);
});
