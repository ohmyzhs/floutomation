import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const contentGuardSource = contentSource.slice(0, contentSource.indexOf("const pageSessionId"));
const scanStart = contentSource.indexOf("async function scanFlowCharacters");
const scanEnd = contentSource.indexOf("async function setFormControlValue", scanStart);
const scanSource = contentSource.slice(scanStart, scanEnd);

const creatorInputStart = contentSource.indexOf("function findCharacterCreatorInput");
const creatorInputEnd = contentSource.indexOf("function findCharacterNavigationButton", creatorInputStart);
const creatorInputSource = contentSource.slice(creatorInputStart, creatorInputEnd);

const directNavigationStart = contentSource.indexOf("function findDirectProjectNavigationItem");
const directNavigationEnd = contentSource.indexOf("function navigationItemSelected", directNavigationStart);
const directNavigationSource = contentSource.slice(directNavigationStart, directNavigationEnd);

const characterNavigationStart = contentSource.indexOf("function findCharacterNavigationButton");
const characterNavigationEnd = contentSource.indexOf("function findNewCharacterButton", characterNavigationStart);
const characterNavigationSource = contentSource.slice(characterNavigationStart, characterNavigationEnd);

const creatorNavigationStart = contentSource.indexOf("async function enterCharacterCreator");
const creatorNavigationEnd = contentSource.indexOf("async function enterDirectMediaWorkspace", creatorNavigationStart);
const creatorNavigationSource = contentSource.slice(creatorNavigationStart, creatorNavigationEnd);

const characterModelStart = contentSource.indexOf("function findCharacterModelButton");
const characterModelEnd = contentSource.indexOf("function findFlowBackButton", characterModelStart);
const characterModelSource = contentSource.slice(characterModelStart, characterModelEnd);

const modelSelectionStart = contentSource.indexOf("const SUPPORTED_FLOW_MODELS");
const modelSelectionEnd = contentSource.indexOf("function placeCaretAtEnd", modelSelectionStart);
const modelSelectionSource = contentSource.slice(modelSelectionStart, modelSelectionEnd);

const registrationStart = contentSource.indexOf("async function finishCharacterRegistration");
const registrationEnd = contentSource.indexOf("async function reconcileCharacterAfterNavigation", registrationStart);
const registrationSource = contentSource.slice(registrationStart, registrationEnd);

const failureCardsStart = contentSource.indexOf("function captureGenerationFailureCards");
const failureCardsEnd = contentSource.indexOf("async function monitorGeneration", failureCardsStart);
const failureCardsSource = contentSource.slice(failureCardsStart, failureCardsEnd);

const monitorStart = contentSource.indexOf("async function monitorGeneration");
const monitorEnd = contentSource.indexOf("function findCharacterCreatorInput", monitorStart);
const monitorSource = contentSource.slice(monitorStart, monitorEnd);

const submissionStart = contentSource.indexOf("async function confirmGenerationStarted");
const submissionEnd = contentSource.indexOf("async function monitorGeneration", submissionStart);
const submissionSource = contentSource.slice(submissionStart, submissionEnd);

const recoveryStart = contentSource.indexOf("async function reconcileSceneAfterNavigation");
const recoveryEnd = contentSource.indexOf("async function runCharacter", recoveryStart);
const recoverySource = contentSource.slice(recoveryStart, recoveryEnd);

const promptReferenceStart = contentSource.indexOf("async function setPromptWithCharacterReferences");
const promptReferenceEnd = contentSource.indexOf("function findSubmitButton", promptReferenceStart);
const promptReferenceSource = contentSource.slice(promptReferenceStart, promptReferenceEnd);

const submitStart = contentSource.indexOf("function submitButtonDescriptor");
const submitEnd = contentSource.indexOf("function assetIdFromDetailUrl", submitStart);
const submitSource = contentSource.slice(submitStart, submitEnd);

const manualPromptStart = contentSource.indexOf("async function prepareManualScenePrompt");
const manualPromptEnd = contentSource.indexOf("function currentProjectTitle", manualPromptStart);
const manualPromptSource = contentSource.slice(manualPromptStart, manualPromptEnd);

const projectTitleStart = contentSource.indexOf("function currentProjectTitle");
const projectTitleEnd = contentSource.indexOf("function sceneMediaCardAssets", projectTitleStart);
const projectTitleSource = contentSource.slice(projectTitleStart, projectTitleEnd);

const discoveryStart = contentSource.indexOf("function discoverRegisteredCharacterKeys");
const discoveryEnd = contentSource.indexOf("async function setFormControlValue", discoveryStart);
const discoverySource = contentSource.slice(discoveryStart, discoveryEnd);

const progressStart = contentSource.indexOf("function findGenerationProgressCards");
const progressEnd = contentSource.indexOf("function captureCompletionSignals", progressStart);
const progressSource = contentSource.slice(progressStart, progressEnd);

const assetPickerStart = contentSource.indexOf("function findAssetPickerDialog");
const assetPickerEnd = contentSource.indexOf("async function setPromptWithCharacterReferences", assetPickerStart);
const assetPickerSource = contentSource.slice(assetPickerStart, assetPickerEnd);

const mediaCardsStart = contentSource.indexOf("function sceneMediaCardAssets");
const mediaCardsEnd = contentSource.indexOf("function findMediaScrollContainer", mediaCardsStart);
const mediaCardsSource = contentSource.slice(mediaCardsStart, mediaCardsEnd);

test("content script stays active on direct Flow project URLs", () => {
  assert.match(contentGuardSource, /DIRECT_FLOW_HOSTS.*flow\.google\.com/);
  assert.match(contentGuardSource, /DIRECT_FLOW_PATH/);
  assert.match(contentGuardSource, /DIRECT_FLOW_HOSTS\.has\(location\.hostname\)/);
  assert.match(contentGuardSource, /DIRECT_FLOW_PATH\.test\(location\.pathname\)/);
});

test("the general image prompt cannot be mistaken for the character description input", () => {
  assert.match(creatorInputSource, /캐릭터\.\*설명\|describe\.\*character/);
  assert.match(creatorInputSource, /element\.textContent/);
  assert.doesNotMatch(creatorInputSource, /candidates\.length\s*===\s*1/);
  assert.doesNotMatch(creatorInputSource, /hasCreatorHeading/);
});

test("direct Flow project navigation uses its interactive list items without clicking back to the homepage", () => {
  assert.match(directNavigationSource, /mat-list-item/);
  assert.match(directNavigationSource, /function isDirectFlowProjectWorkspace/);
  assert.match(directNavigationSource, /isDirectFlowProject &&/);
  assert.match(directNavigationSource, /location\.pathname/);
  assert.match(directNavigationSource, /findDirectProjectNavigationItem\("전체 미디어"\)/);
  assert.match(characterNavigationSource, /findDirectProjectNavigationItem\("캐릭터"\)/);
  assert.match(creatorNavigationSource, /if \(isDirectFlowProjectWorkspace\(\)\) break;/);
});

test("the 16:9 x2 general image settings button cannot be used as the character model button", () => {
  assert.match(characterModelSource, /crop/);
  assert.match(characterModelSource, /16\\s\*:\\s\*9/);
  assert.match(characterModelSource, /\\bx\[1-4\]\\b/);
});

test("the selected model is matched exactly across all three Flow image models", () => {
  assert.match(modelSelectionSource, /Nano Banana Pro/);
  assert.match(modelSelectionSource, /Nano Banana 2 Lite/);
  assert.match(modelSelectionSource, /canonicalFlowModel/);
  assert.match(modelSelectionSource, /ensureDirectImageModel\(section, requestedModel\)/);
  assert.match(contentSource, /ensureCharacterModel\(options\.model\)/);
  assert.match(contentSource, /ensureDirectImageSettings\(input, options\.model, options\.aspectRatio, options\.imagesPerPrompt\)/);
});

test("current Flow settings use the trigger summary and radio controls", () => {
  assert.ok(contentSource.includes("설정트리거|settingstrigger|promptsettings"));
  assert.match(modelSelectionSource, /\[role="tab"\], \[role="radio"\], button/);
  assert.match(modelSelectionSource, /flow-prompt-box-settings/);
  assert.match(contentSource, /aria-checked/);
  assert.match(modelSelectionSource, /crop_16_9/);
});

test("character registration monitoring responds to a requested stop", () => {
  assert.match(
    registrationSource,
    /if \(pauseRequested\) \{\s*return \{ completed: false, paused: true, referenceImages: detectedImages, assets: \[\] \};/
  );
});

test("character registration uses the captured detail route instead of reopening an unnamed card", () => {
  assert.match(registrationSource, /currentCharacterDetailUrl\(\)/);
  assert.match(registrationSource, /findCharacterNameEditButton\(nameControl\)/);
  assert.doesNotMatch(contentSource, /FLOW_TRUSTED_DOUBLE_CLICK/);
  assert.doesNotMatch(contentSource, /dispatchSyntheticDoubleClick/);
  assert.doesNotMatch(registrationSource, /제목 없는 캐릭터 카드 열기/);
});

test("character completion requires the saved name card after returning from details", () => {
  assert.match(registrationSource, /findRegisteredCharacterImage\(character\.key\)/);
  assert.match(registrationSource, /registrationVerified: true/);
  assert.match(contentSource, /registrationVerified: result\.registrationVerified === true/);
});

test("scene monitoring captures offscreen baselines and caps automatic result cards", () => {
  assert.match(contentSource, /MAX_TRACKED_GENERATED_IMAGES\s*=\s*4/);
  assert.match(contentSource, /captureLargeMediaAssets\(\{ includeOffscreen: true \}\)/);
  assert.match(contentSource, /assets\.slice\(0, MAX_TRACKED_GENERATED_IMAGES\)/);
});

test("Flow daily-limit failure cards are inspected as generation errors", () => {
  assert.match(failureCardsSource, /querySelectorAll\("button"\)/);
  assert.match(failureCardsSource, /일일\\s\*한도/);
  assert.match(failureCardsSource, /baselineFailureCount/);
});

test("guardrail failures are surfaced as retryable generation errors", () => {
  assert.match(failureCardsSource, /가이드라인|guideline|moderation|unsafe|blocked/);
  assert.match(contentSource, /안전|policy|violat/);
});

test("scene monitoring stops promptly when the queue stop signal arrives", () => {
  assert.match(monitorSource, /if \(pauseRequested\)/);
  assert.match(monitorSource, /paused: true/);
});

test("a submitted request must show a Flow start signal and retries once with trusted Enter", () => {
  assert.match(submissionSource, /hasBusySignal\(progressCards\) \|\| \(currentSubmitButton && !submitControlIsEnabled\(currentSubmitButton\)\)/);
  assert.match(submissionSource, /Date\.now\(\) - startedAt >= 8_000/);
  assert.match(submissionSource, /retrySubmitted = true/);
  assert.match(submissionSource, /retrySubmit = submitWithTrustedEnter/);
  assert.match(submissionSource, /await retrySubmit\(currentButton\)/);
  assert.match(contentSource, /type: "FLOW_TRUSTED_SUBMIT"/);
  assert.match(contentSource, /submissionDiagnostic\(submitButton, "좌표 클릭 전송"\)/);
  assert.match(contentSource, /submissionDiagnostic\(currentButton, "키보드 Enter 재시도"\)/);
});

test("submit control lookup prefers the character form submit button and keeps retry scope", () => {
  assert.match(submitSource, /querySelectorAll\("button, \[role=/);
  assert.match(submitSource, /closest\("form"\)/);
  assert.match(submitSource, /associatedForm/);
  assert.match(submitSource, /type === "submit"/);
  assert.match(submitSource, /data-testid/);
  assert.match(contentSource, /element\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(contentSource, /const currentSubmitButton = findSubmitControl\(liveInput\)/);
  assert.match(contentSource, /confirmGenerationStarted\(\{\s*input,/);
  assert.match(contentSource, /const currentInput = input instanceof HTMLElement && document\.contains\(input\) \? input : findPromptInput\(\);/);
  assert.match(contentSource, /const currentButton = findSubmitControl\(currentInput\)/);
});

test("character generation uses a trusted coordinate click and Enter fallback", () => {
  assert.match(submitSource, /function isCharacterSubmitButton/);
  assert.match(submitSource, /textContent \|\| ""\)\.trim\(\) === "arrow_forward"/);
  assert.match(submitSource, /mat-icon/);
  assert.match(submitSource, /\^\(\?:만들기\|create\)\$/);
  assert.match(submitSource, /생성\\s\*시작\|create\|generate\|submit/);
  assert.match(submitSource, /button, \[role="button"\]/);
  assert.match(submitSource, /function findCharacterSubmitButton/);
  assert.match(contentSource, /const button = findCharacterSubmitButton\(input\)/);
  assert.match(contentSource, /const primarySubmissionDiagnostic = submissionDiagnostic\(submitButton, "만들기 버튼 좌표 클릭"\)/);
  assert.match(contentSource, /await clickTrusted\(submitButton\)/);
  assert.match(contentSource, /findSubmitControl: findCharacterSubmitButton/);
  assert.match(contentSource, /retrySubmit: submitWithTrustedEnter/);
  assert.match(contentSource, /submissionDiagnostic: ""/);
  assert.doesNotMatch(contentSource, /button\.click 직접 전송/);
});

test("character detail navigation is a start signal and failed retries resume registration", () => {
  assert.match(contentSource, /function findCharacterRegistrationSurface/);
  assert.match(contentSource, /function currentCharacterDetailUrl/);
  assert.match(contentSource, /if \(!currentCharacterDetailUrl\(\)\) return null/);
  assert.match(contentSource, /const nameControl = findCharacterNameControl\(\)/);
  assert.match(contentSource, /const editButton = findCharacterNameEditButton\(nameControl\)/);
  assert.match(contentSource, /const backButton = findFlowBackButton\(\)/);
  assert.match(contentSource, /function findCharacterCompletionButton/);
  assert.match(submissionSource, /additionalStartSignal = null/);
  assert.match(submissionSource, /if \(additionalStartSignal\?\.\(\)\) return true/);
  assert.match(contentSource, /additionalStartSignal: findCharacterRegistrationSurface/);
  assert.match(contentSource, /if \(findCharacterRegistrationSurface\(\)\)/);
  assert.match(contentSource, /생성된 캐릭터 상세 화면 복구 · 이름 저장 중/);
  assert.match(registrationSource, /setFormControlValue\(nameControl, character\.key\)/);
});

test("Flow character detail names are edited and persisted before completion", () => {
  assert.match(contentSource, /form\.character-form input\.name-input\[type="text"\]/);
  assert.match(registrationSource, /const nameControlNeedsEditing = !nameControl/);
  assert.match(contentSource, /function findCharacterNameEditButton/);
  assert.match(contentSource, /function findCharacterCompletionButton/);
  assert.match(contentSource, /findExactActionButton\(\["완료", "Done"\]\)/);
  assert.match(contentSource, /수정완료\|finishediting\|save\(\?:name\)\?/);
  assert.match(contentSource, /뒤로\|돌아가기\|이전페이지\|back/);
  assert.match(contentSource, /edit\\s\*name\|이름\\s\*\(\?:수정\|편집\)/);
  assert.match(contentSource, /setter\.call\(control, value\)/);
  assert.match(contentSource, /inputType: "insertReplacementText"/);
  assert.match(contentSource, /await insertTrustedText\(control, value, \{ clear: true \}\)/);
  assert.match(contentSource, /control\.dispatchEvent\(new Event\("change"/);
  assert.match(registrationSource, /setFormControlValue\(nameControl, character\.key\)/);
  assert.match(registrationSource, /FLOW_CHARACTER_NAME_SUBMITTED/);
  assert.match(registrationSource, /flowDetailUrl: currentCharacterDetailUrl\(\)/);
  assert.match(registrationSource, /const completionButton = findCharacterCompletionButton\(\)/);
  assert.match(registrationSource, /await clickTrusted\(completionButton, \{ settleMs: NAVIGATION_SETTLE_MS \}\)/);
  assert.match(registrationSource, /if \(currentCharacterDetailUrl\(\)\)/);
  assert.match(registrationSource, /await clickTrusted\(backButton, \{ settleMs: NAVIGATION_SETTLE_MS \}\)/);
  assert.match(registrationSource, /await waitFor\(\(\) => !currentCharacterDetailUrl\(\)/);
  assert.match(registrationSource, /registrationVerified: true/);
  assert.match(registrationSource, /findRegisteredCharacterImage\(character\.key\)/);
});

test("trusted text replacement selects the full focused Flow field", async () => {
  const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(contentSource, /placeTextSelection\(input, \{ selectAll: clear \}\)/);
  assert.match(backgroundSource, /async function flowSelectAllModifier/);
  assert.match(backgroundSource, /platform\?\.os === "mac" \? 4 : 2/);
  assert.match(backgroundSource, /modifiers: selectAllModifier/);
  assert.match(backgroundSource, /commands: \["selectAll"\]/);
  assert.match(backgroundSource, /commands: \["deleteBackward"\]/);
});

test("Flow ready events report the exact route for URL-based character recovery", () => {
  assert.match(contentSource, /type: "FLOW_READY"/);
  assert.match(contentSource, /url: location\.href/);
  assert.match(contentSource, /type: "FLOW_ROUTE_CHANGED"/);
  assert.match(contentSource, /setInterval/);
  assert.ok(contentSource.includes('/^\\/project\\/[^/]+\\/character\\/[^/?#]+\\/?$/i'));
});

test("Flow character discovery reads named custom-element tiles and real ProseMirror text", () => {
  assert.match(discoverySource, /flow-grid-tile-container, flow-character-tile/);
  assert.match(contentSource, /character-tile-name/);
  assert.match(contentSource, /\.ProseMirror/);
  assert.match(contentSource, /prosemirror-placeholder/);
  assert.match(contentSource, /characterTileMatchesKey/);
});

test("current Flow pending tiles prevent early character or scene completion", () => {
  assert.match(progressSource, /flow-pending-tile/);
  assert.match(progressSource, /mat-icon/);
  assert.match(progressSource, /data-mat-icon-type/);
  assert.ok(progressSource.includes('.match(/^(100|\\d{1,2})\\s*%$/)'));
});

test("current Flow asset popover can locate the character picker and its add action", () => {
  assert.match(assetPickerSource, /flow-add-menu-popover-content/);
  assert.match(assetPickerSource, /add-menu-popover-container/);
  assert.ok(assetPickerSource.includes("애셋\\s*검색|search\\s*assets?"));
  assert.match(assetPickerSource, /프롬프트에 추가/);
  assert.match(contentSource, /flow-character-ingredient-chip/);
});

test("current Flow image cards are scanned by stable data-media-id without edit links", () => {
  assert.match(mediaCardsSource, /flow-image-tile img\[data-media-id\]/);
  assert.match(mediaCardsSource, /getAttribute\("data-media-id"\)/);
  assert.match(mediaCardsSource, /const identity = assetId/);
});

test("one-time Flow release notes cannot block queue navigation", () => {
  assert.match(contentSource, /function dismissBlockingFlowAnnouncement/);
  assert.match(contentSource, /\[role="dialog"\]/);
  assert.match(contentSource, /시작하기\|Get started/);
  assert.match(contentSource, /await dismissBlockingFlowAnnouncement\(\)/);
});

test("hidden Flow pages can use structural controls without viewport geometry", () => {
  assert.match(contentSource, /document\.visibilityState === "hidden"/);
  assert.match(contentSource, /element\.click\(\)/);
});

test("a scene accepts a stable partial result after Flow has stopped", () => {
  assert.match(monitorSource, /detectedImages >= expectedImages/);
  assert.match(monitorSource, /다운로드 가능한 결과 이미지/);
  assert.match(monitorSource, /detectedImages > 0 && assetsStableAt/);
  assert.match(monitorSource, /Date\.now\(\) - busyStoppedAt >= 12_000/);
});

test("recovery without a persisted media boundary never attaches existing gallery cards", () => {
  assert.match(recoverySource, /Boolean\(job\.baselineCapturedAt\) && recoveryBaseline\.size > 0/);
  assert.match(recoverySource, /const baselineMedia = hasStoredBaseline \? recoveryBaseline : currentMedia/);
});

test("an empty Flow project accepts the direct character creator as a zero-character scan", () => {
  assert.match(
    scanSource,
    /if \(findCharacterCreatorInput\(\) && !findNewCharacterButton\(\)\) \{\s*return emptyCharacterScanResult\(\);\s*\}/
  );
});

test("returning from an empty creator accepts the project workspace instead of requiring a library", () => {
  assert.match(
    scanSource,
    /waitFor\(\(\) => findNewCharacterButton\(\) \|\| findCharacterNavigationButton\(\)/
  );
  assert.match(
    scanSource,
    /return emptyCharacterScanResult\("project-workspace"\)/
  );
});

test("repeated @character mentions produce one Flow reference chip and keep later mentions as prose", () => {
  assert.match(promptReferenceSource, /const boundKeys = new Set\(\);/);
  assert.match(promptReferenceSource, /if \(boundKeys\.has\(key\)\) \{\s*\/\/ A character can be mentioned repeatedly[\s\S]*?await insertTrustedText\(input, key\);/);
  assert.match(promptReferenceSource, /await bindCharacterAssetReference\(input, key\);\s*boundKeys\.add\(key\);/);
  assert.match(promptReferenceSource, /referenceCount >= boundKeys\.size/);
});

test("character anchors use Flow's @ shortcut instead of the generic asset menu", () => {
  assert.match(contentSource, /async function pressTrustedAtSign/);
  assert.match(contentSource, /await pressTrustedAtSign\(input\)/);
  assert.match(contentSource, /Flow's '@' shortcut opens the character-aware picker/);
  assert.match(contentSource, /editorText\.includes\(normalize\(key\)\)/);
});

test("current Flow character ingredient chips count as anchor references", () => {
  assert.match(contentSource, /flow-character-ingredient-chip button\.chip-container/);
  assert.match(contentSource, /accessibility_new/);
});

test("an invalidated extension context never throws from best-effort messages", () => {
  assert.match(contentSource, /function sendRuntimeMessage\(message\)/);
  assert.match(contentSource, /extensionContextInvalidated/);
  assert.match(contentSource, /void sendRuntimeMessage\(message\)\.catch/);
});

test("manual scene preparation binds the prompt but never submits or monitors generation", () => {
  assert.match(manualPromptSource, /enterDirectMediaWorkspace\(\)/);
  assert.match(manualPromptSource, /ensureDirectImageSettings\(input, options\.model, options\.aspectRatio, options\.imagesPerPrompt\)/);
  assert.match(manualPromptSource, /setPromptWithCharacterReferences\(input, job\.prompt, job\.characterRefs \|\| \[\]\)/);
  assert.doesNotMatch(manualPromptSource, /findSubmitButton|clickTrusted\(submitButton\)|monitorGeneration/);
});

test("project downloads prefer Flow's editable project title", () => {
  assert.match(projectTitleSource, /input\[aria-label="수정 가능한 텍스트"\]/);
  assert.match(projectTitleSource, /if \(editableTitle\) return editableTitle/);
});

test("an older Flow project can recover registered @keys without a saved queue", () => {
  assert.match(discoverySource, /a\[href\*="\/character\/"\]/);
  assert.match(contentSource, /DISCOVER_FLOW_CHARACTERS/);
  assert.match(discoverySource, /@\(\[A-Za-z\]/);
});
