import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const scanStart = contentSource.indexOf("async function scanFlowCharacters");
const scanEnd = contentSource.indexOf("async function setFormControlValue", scanStart);
const scanSource = contentSource.slice(scanStart, scanEnd);

const creatorInputStart = contentSource.indexOf("function findCharacterCreatorInput");
const creatorInputEnd = contentSource.indexOf("function findCharacterNavigationButton", creatorInputStart);
const creatorInputSource = contentSource.slice(creatorInputStart, creatorInputEnd);

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

const promptReferenceStart = contentSource.indexOf("async function setPromptWithCharacterReferences");
const promptReferenceEnd = contentSource.indexOf("function findSubmitButton", promptReferenceStart);
const promptReferenceSource = contentSource.slice(promptReferenceStart, promptReferenceEnd);

const manualPromptStart = contentSource.indexOf("async function prepareManualScenePrompt");
const manualPromptEnd = contentSource.indexOf("function currentProjectTitle", manualPromptStart);
const manualPromptSource = contentSource.slice(manualPromptStart, manualPromptEnd);

test("the general image prompt cannot be mistaken for the character description input", () => {
  assert.match(creatorInputSource, /캐릭터\.\*설명\|describe\.\*character/);
  assert.doesNotMatch(creatorInputSource, /candidates\.length\s*===\s*1/);
  assert.doesNotMatch(creatorInputSource, /hasCreatorHeading/);
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
  assert.match(contentSource, /ensureDirectImageSettings\(input, options\.model\)/);
});

test("character registration monitoring responds to a requested stop", () => {
  assert.match(
    registrationSource,
    /if \(pauseRequested\) \{\s*return \{ completed: false, paused: true, referenceImages: detectedImages, assets: \[\] \};/
  );
});

test("Flow daily-limit failure cards are inspected as generation errors", () => {
  assert.match(failureCardsSource, /querySelectorAll\("button"\)/);
  assert.match(failureCardsSource, /일일\\s\*한도/);
  assert.match(failureCardsSource, /baselineFailureCount/);
});

test("a scene cannot complete without every requested downloadable image", () => {
  assert.match(monitorSource, /detectedImages >= expectedImages/);
  assert.match(monitorSource, /다운로드 가능한 결과 이미지/);
  assert.doesNotMatch(monitorSource, /Math\.max\(expectedImages, detectedImages\)/);
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

test("manual scene preparation binds the prompt but never submits or monitors generation", () => {
  assert.match(manualPromptSource, /enterDirectMediaWorkspace\(\)/);
  assert.match(manualPromptSource, /ensureDirectImageSettings\(input, options\.model\)/);
  assert.match(manualPromptSource, /setPromptWithCharacterReferences\(input, job\.prompt, job\.characterRefs \|\| \[\]\)/);
  assert.doesNotMatch(manualPromptSource, /findSubmitButton|clickTrusted\(submitButton\)|monitorGeneration/);
});
