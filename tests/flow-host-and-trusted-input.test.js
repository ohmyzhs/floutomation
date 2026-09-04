import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FLOW_TAB_URL_PATTERNS,
  characterDetailFromFlowUrl,
  isFlowUrl,
  projectIdFromFlowUrl
} from "../lib/project-history.js";

const backgroundSource = await readFile(new URL("../background.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

const trustedHelpersStart = backgroundSource.indexOf("async function dispatchTextFallback");
const trustedHelpersEnd = backgroundSource.indexOf("async function clickTrustedPoint", trustedHelpersStart);
assert.notEqual(trustedHelpersStart, -1, "trusted-input helper start must exist");
assert.notEqual(trustedHelpersEnd, -1, "trusted-input helper end must exist");
const trustedHelpersSource = backgroundSource.slice(trustedHelpersStart, trustedHelpersEnd);

function trustedInputHarness({ os = "mac", tabUrl = "https://flow.google.com/project/project-a" } = {}) {
  const commands = [];
  const attached = [];
  const detached = [];
  const chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: tabUrl })
    },
    runtime: {
      getPlatformInfo: async () => ({ os })
    },
    debugger: {
      attach: async (target, version) => attached.push({ target, version }),
      detach: async (target) => detached.push(target),
      sendCommand: async (target, method, params) => {
        commands.push({ target, method, params });
        return {};
      }
    }
  };

  const buildHelpers = new Function(
    "chrome",
    "isFlowUrl",
    `"use strict";\n${trustedHelpersSource}\nreturn { flowSelectAllModifier, insertTrustedText, pressTrustedKey };`
  );
  return {
    ...buildHelpers(chrome, isFlowUrl),
    commands,
    attached,
    detached
  };
}

function keyEvents(commands) {
  return commands
    .filter((entry) => entry.method === "Input.dispatchKeyEvent")
    .map((entry) => entry.params);
}

test("trusted prompt replacement sends Cmd+A on macOS and Ctrl+A on Windows/Linux", async () => {
  for (const [os, expectedModifier] of [["mac", 4], ["win", 2], ["linux", 2]]) {
    const harness = trustedInputHarness({ os });

    assert.deepEqual(
      await harness.insertTrustedText(17, "replacement", { clear: true }),
      { inserted: 11, cleared: true }
    );

    const events = keyEvents(harness.commands);
    assert.deepEqual(events.slice(0, 4), [
      {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        modifiers: expectedModifier,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        commands: ["selectAll"]
      },
      {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: expectedModifier,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65
      },
      {
        type: "rawKeyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        commands: ["deleteBackward"]
      },
      {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      }
    ], `${os} must use the correct select-all modifier before replacement`);
    assert.deepEqual(harness.commands.at(-1), {
      target: { tabId: 17 },
      method: "Input.insertText",
      params: { text: "replacement" }
    });
    assert.deepEqual(harness.attached, [{ target: { tabId: 17 }, version: "1.3" }]);
    assert.deepEqual(harness.detached, [{ tabId: 17 }]);
  }
});

test("trusted Enter and Escape dispatch complete key pairs with their native key codes", async () => {
  for (const [key, keyCode] of [["Enter", 13], ["Escape", 27]]) {
    const harness = trustedInputHarness();

    assert.deepEqual(await harness.pressTrustedKey(23, key), { pressed: key });
    assert.deepEqual(keyEvents(harness.commands), [
      {
        type: "rawKeyDown",
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      },
      {
        type: "keyUp",
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      }
    ]);
    assert.deepEqual(harness.detached, [{ tabId: 23 }]);
  }
});

test("trusted input refuses legacy or lookalike Flow hosts before attaching a debugger", async () => {
  for (const tabUrl of [
    "https://labs.google/fx/tools/flow/project/project-a",
    "https://flow.google/project/project-a",
    "https://fow.google/project/project-a",
    "https://flow.google.com.evil.test/project/project-a"
  ]) {
    const harness = trustedInputHarness({ tabUrl });
    await assert.rejects(
      harness.insertTrustedText(31, "blocked"),
      /신뢰 입력은 Google Flow 탭에서만 사용할 수 있습니다/
    );
    assert.equal(harness.attached.length, 0);
    assert.equal(harness.commands.length, 0);
  }
});

test("automatic scene submission clicks once, verifies start, then retries with trusted Enter", () => {
  const runJobStart = contentSource.indexOf("async function runJob");
  const runJobEnd = contentSource.indexOf("async function prepareManualScenePrompt", runJobStart);
  const runJobSource = contentSource.slice(runJobStart, runJobEnd);
  const bindIndex = runJobSource.indexOf("await setPromptWithCharacterReferences");
  const clickIndex = runJobSource.indexOf("await clickTrusted(submitButton)");
  const confirmIndex = runJobSource.indexOf("await confirmGenerationStarted");
  const monitorIndex = runJobSource.indexOf("await monitorGeneration");

  assert.ok(bindIndex >= 0, "scene prompt and character anchors must be prepared");
  assert.ok(clickIndex > bindIndex, "automatic submit must happen after prompt preparation");
  assert.ok(confirmIndex > clickIndex, "automatic submit must be confirmed after its click");
  assert.ok(monitorIndex > confirmIndex, "generation monitoring must start only after submit confirmation");

  const confirmationStart = contentSource.indexOf("async function confirmGenerationStarted");
  const confirmationEnd = contentSource.indexOf("async function monitorGeneration", confirmationStart);
  const confirmationSource = contentSource.slice(confirmationStart, confirmationEnd);
  assert.match(confirmationSource, /retrySubmit = submitWithTrustedEnter/);
  assert.match(confirmationSource, /if \(!retrySubmitted && Date\.now\(\) - startedAt >= 8_000\)/);
  assert.match(confirmationSource, /retrySubmitted = true;[\s\S]*await retrySubmit\(currentButton\)/);

  const submitBranchStart = backgroundSource.indexOf('if (message.type === "FLOW_TRUSTED_SUBMIT")');
  const submitBranchEnd = backgroundSource.indexOf('if (message.type === "FLOW_TRUSTED_CLICK")', submitBranchStart);
  const submitBranchSource = backgroundSource.slice(submitBranchStart, submitBranchEnd);
  assert.match(submitBranchSource, /isFlowUrl\(sender\.url \|\| sender\.tab\?\.url\)/);
  assert.match(submitBranchSource, /return pressTrustedKey\(tabId, "Enter"\)/);
});

test("Flow routing and content injection are restricted to flow.google.com project URLs", () => {
  assert.deepEqual(FLOW_TAB_URL_PATTERNS, ["https://flow.google.com/project/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://flow.google.com/project/*"]);

  const accepted = [
    "https://flow.google.com/project/project-a",
    "https://flow.google.com/project/project-a/character/character-b",
    "https://flow.google.com/project/project-a/edit/asset-c?source=queue"
  ];
  for (const url of accepted) assert.equal(isFlowUrl(url), true, url);

  const rejected = [
    "http://flow.google.com/project/project-a",
    "https://flow.google.com/",
    "https://flow.google.com/projects/project-a",
    "https://labs.google/fx/tools/flow/project/project-a",
    "https://flow.google/project/project-a",
    "https://fow.google/project/project-a",
    "https://flow.google.com.evil.test/project/project-a"
  ];
  for (const url of rejected) {
    assert.equal(isFlowUrl(url), false, url);
    assert.equal(projectIdFromFlowUrl(url), "", url);
    assert.equal(characterDetailFromFlowUrl(url), null, url);
  }

  const openFlowStart = backgroundSource.indexOf('if (message.type === "OPEN_FLOW")');
  const openFlowEnd = backgroundSource.indexOf('if (message.type === "OPEN_ASSET")', openFlowStart);
  const openFlowSource = backgroundSource.slice(openFlowStart, openFlowEnd);
  assert.match(openFlowSource, /chrome\.tabs\.create\(\{ url: "https:\/\/flow\.google\.com\/" \}\)/);
  assert.doesNotMatch(openFlowSource, /labs\.google|fow\.google|https:\/\/flow\.google\//);
});
