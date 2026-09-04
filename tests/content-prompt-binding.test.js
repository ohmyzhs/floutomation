import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = contentSource.indexOf(startMarker);
  const end = contentSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return contentSource.slice(start, end);
}

function compileFunction(source, name, bindings) {
  const keys = Object.keys(bindings);
  const values = Object.values(bindings);
  return Function(...keys, `"use strict";\n${source}\nreturn ${name};`)(...values);
}

const promptFunctionSource = sourceBetween(
  "async function setPromptWithCharacterReferences",
  "function submitButtonDescriptor"
);

test("prompt binding executes repeated and interleaved mentions in source order", async () => {
  const operations = [];
  let editorText = "";
  let mentionCount = 0;
  let editorRevision = 0;
  const nextEditor = () => ({ revision: ++editorRevision });

  const setPromptWithCharacterReferences = compileFunction(
    promptFunctionSource,
    "setPromptWithCharacterReferences",
    {
      waitForLiveDirectPromptInput: async () => nextEditor(),
      clearScenePrompt: async () => {
        operations.push({ type: "clear" });
        editorText = "";
        mentionCount = 0;
        return nextEditor();
      },
      bindCharacterAssetReference: async (_input, key) => {
        operations.push({ type: "mention", value: key });
        editorText += key;
        mentionCount += 1;
        return nextEditor();
      },
      insertTrustedText: async (_input, text) => {
        operations.push({ type: "text", value: text });
        editorText += text;
      },
      confirmScenePromptText: async (input) => input,
      waitFor: async (predicate, options) => {
        const result = predicate();
        if (!result) throw new Error(options?.error || "condition not met");
        return result;
      },
      liveDirectPromptInput: () => nextEditor(),
      findPromptMentionChips: () => Array.from({ length: mentionCount }, () => ({})),
      normalizedEditorText: () => editorText,
      normalizeTrackedPrompt: (value) => String(value || "")
        .replace(/@(?=[A-Za-z][\w-]*)/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
    }
  );

  const prompt = "Lead @suok watches @hyangi; @suok answers @hyangi.";
  const result = await setPromptWithCharacterReferences(nextEditor(), prompt, ["suok", "hyangi"]);

  assert.ok(result);
  assert.deepEqual(operations, [
    { type: "clear" },
    { type: "text", value: "Lead " },
    { type: "mention", value: "suok" },
    { type: "text", value: " watches " },
    { type: "mention", value: "hyangi" },
    { type: "text", value: "; " },
    { type: "mention", value: "suok" },
    { type: "text", value: " answers " },
    { type: "mention", value: "hyangi" },
    { type: "text", value: "." }
  ]);
  assert.equal(mentionCount, 4);
});

const confirmTextFunctionSource = sourceBetween(
  "async function confirmScenePromptText",
  "async function setPromptWithCharacterReferences"
);

test("scene text that missed a swapped editor is typed once more into the live editor", async () => {
  const staleEditor = { id: "stale" };
  const liveEditor = { id: "live" };
  let liveText = "";
  const inserts = [];
  const normalizeTrackedPrompt = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  const confirmScenePromptText = compileFunction(confirmTextFunctionSource, "confirmScenePromptText", {
    normalizeTrackedPrompt,
    normalizedEditorText: (editor) => (editor === liveEditor ? liveText : ""),
    liveDirectPromptInput: () => liveEditor,
    waitForLiveDirectPromptInput: async () => liveEditor,
    insertTrustedText: async (editor, text) => {
      inserts.push(editor.id);
      if (editor === liveEditor) liveText += text;
    },
    waitFor: async (predicate, options) => {
      const result = predicate();
      if (!result) throw new Error(options?.error || "condition not met");
      return result;
    }
  });

  // First insert went to the node Flow replaced; nothing reached the live editor.
  assert.equal(await confirmScenePromptText(staleEditor, " walks home"), liveEditor);
  assert.deepEqual(inserts, ["live"]);
  assert.equal(liveText, " walks home");

  // Text already present on the live editor is never typed twice.
  inserts.length = 0;
  assert.equal(await confirmScenePromptText(liveEditor, " walks home"), liveEditor);
  assert.deepEqual(inserts, []);
});

const bindingFunctionSource = sourceBetween(
  "async function bindCharacterAssetReference",
  "async function setPromptWithCharacterReferences"
);

test("character picker fallback confirms the Add button created a real mention chip", async () => {
  class FakeHTMLElement {}
  const input = new FakeHTMLElement();
  const refreshedInput = new FakeHTMLElement();
  const dialog = {};
  const option = {
    syntheticClicks: 0,
    click() {
      this.syntheticClicks += 1;
    }
  };
  const addButton = { disabled: false, getAttribute: () => null };
  let pickerOpen = true;
  let mentionCount = 0;
  let trustedOptionClicks = 0;
  let trustedAddClicks = 0;

  const bindCharacterAssetReference = compileFunction(
    bindingFunctionSource,
    "bindCharacterAssetReference",
    {
      HTMLElement: FakeHTMLElement,
      waitForLiveDirectPromptInput: async () => refreshedInput,
      findPromptMentionChips: () => Array.from({ length: mentionCount }, () => ({
        classList: { contains: () => false }
      })),
      openCharacterAssetPicker: async () => dialog,
      findCharacterAssetFilter: () => ({}),
      settingControlSelected: () => true,
      selectCharacterAssetFilter: async () => dialog,
      findAssetSearchInput: () => null,
      insertTrustedText: async () => {},
      liveDirectPromptInput: () => refreshedInput,
      findAssetPickerDialog: () => pickerOpen ? dialog : null,
      findCharacterAssetOption: () => option,
      clickTrusted: async (element) => {
        if (element === option) trustedOptionClicks += 1;
        if (element === addButton) {
          trustedAddClicks += 1;
          mentionCount += 1;
          pickerOpen = false;
        }
      },
      waitFor: async (predicate, options) => {
        const result = predicate();
        if (!result) throw new Error(options?.error || "condition not met");
        return result;
      },
      findAssetAddButton: () => addButton,
      sendRuntimeMessage: async () => ({ ok: true })
    }
  );

  const result = await bindCharacterAssetReference(input, "suok");

  assert.equal(result, refreshedInput);
  assert.equal(trustedOptionClicks, 1);
  assert.equal(option.syntheticClicks, 0);
  assert.equal(trustedAddClicks, 1);
  assert.equal(mentionCount, 1);
});

const manualFunctionSource = sourceBetween(
  "async function prepareManualScenePrompt",
  "function currentProjectTitle"
);

test("manual prompt preparation waits for the shared complete binding pipeline and does not submit", async () => {
  const calls = [];
  const workspaceInput = { id: "workspace" };
  const configuredInput = { id: "configured" };
  const boundInput = { id: "bound" };
  let activeJobId = null;
  let activeTaskType = null;
  let pauseRequested = true;

  const prepareManualScenePrompt = compileFunction(
    manualFunctionSource,
    "prepareManualScenePrompt",
    {
      activeJobId,
      activeTaskType,
      pauseRequested,
      enterDirectMediaWorkspace: async () => {
        calls.push("enter-workspace");
        return workspaceInput;
      },
      ensureDirectImageSettings: async (input) => {
        assert.equal(input, workspaceInput);
        calls.push("configure-image");
        return configuredInput;
      },
      setPromptWithCharacterReferences: async (input, prompt, refs) => {
        assert.equal(input, configuredInput);
        assert.equal(prompt, "@suok meets @hyangi and @suok replies");
        assert.deepEqual(refs, ["suok", "hyangi"]);
        calls.push("bind-complete-prompt");
        return boundInput;
      }
    }
  );

  const result = await prepareManualScenePrompt(
    {
      id: "scene-2",
      prompt: "@suok meets @hyangi and @suok replies",
      characterRefs: ["suok", "hyangi"]
    },
    { model: "Nano Banana 2", aspectRatio: "16:9", imagesPerPrompt: 2 }
  );

  assert.deepEqual(calls, ["enter-workspace", "configure-image", "bind-complete-prompt"]);
  assert.deepEqual(result, { prepared: true });
});

const automaticFunctionSource = sourceBetween(
  "async function runJob",
  "async function prepareManualScenePrompt"
);

test("automatic scene submission uses the live editor returned by prompt binding", async () => {
  const calls = [];
  const workspaceInput = { id: "workspace" };
  const configuredInput = { id: "configured" };
  const boundInput = { id: "bound" };
  const submitButton = { id: "submit" };
  let activeJobId = null;
  let activeTaskType = null;
  let pauseRequested = false;

  const runJob = compileFunction(automaticFunctionSource, "runJob", {
    activeJobId,
    activeTaskType,
    pauseRequested,
    emit: (message) => calls.push(["emit", message.type]),
    emitReliable: async (message) => calls.push(["emitReliable", message.stage]),
    enterDirectMediaWorkspace: async () => workspaceInput,
    captureLargeMedia: () => new Set(),
    requestedFlowModel: () => "Nano Banana 2",
    requestedFlowAspectRatio: () => "16:9",
    requestedFlowImageCount: () => 2,
    ensureDirectImageSettings: async (input) => {
      assert.equal(input, workspaceInput);
      return configuredInput;
    },
    setPromptWithCharacterReferences: async (input) => {
      assert.equal(input, configuredInput);
      calls.push(["prompt-bound", input.id]);
      return boundInput;
    },
    waitFor: async (predicate) => predicate(),
    findSubmitButton: (input) => {
      assert.equal(input, boundInput);
      calls.push(["find-submit", input.id]);
      return submitButton;
    },
    submitControlIsEnabled: (button) => button === submitButton,
    UI_SETTLE_MS: 0,
    sleep: async () => {},
    captureCompletionSignals: () => [],
    captureGenerationFailureCards: () => [],
    clickTrusted: async (button) => {
      assert.equal(button, submitButton);
      calls.push(["click-submit", button.id]);
    },
    submissionDiagnostic: () => "diagnostic",
    confirmGenerationStarted: async ({ input }) => {
      assert.equal(input, boundInput);
      calls.push(["confirm-submit", input.id]);
    },
    monitorGeneration: async () => ({ paused: false, imagesGenerated: 2, assets: [] })
  });

  await runJob(
    { id: "scene-2", prompt: "@suok meets @hyangi", characterRefs: ["suok", "hyangi"] },
    { model: "Nano Banana 2", aspectRatio: "16:9", imagesPerPrompt: 2 }
  );

  assert.deepEqual(
    calls.filter(([type]) => ["prompt-bound", "find-submit", "click-submit", "confirm-submit"].includes(type)),
    [
      ["prompt-bound", "configured"],
      ["find-submit", "bound"],
      ["find-submit", "bound"],
      ["click-submit", "submit"],
      ["confirm-submit", "bound"]
    ]
  );
  assert.ok(calls.some(([type]) => type === "emit"));
});
