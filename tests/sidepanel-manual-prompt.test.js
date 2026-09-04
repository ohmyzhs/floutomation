import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");

function sliceSource(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[character]));

// Builds the real manualPromptEditor + sendManualPrompt out of sidepanel.js and
// wires them to a fake panel, so a send goes through the same path a click does.
function manualPromptHarness({ savedPrompt, typed = null, opened = true }) {
  const editorSource = sliceSource("function manualPromptEditor(", "function renderCharacters()");
  const sendSource = sliceSource("const MANUAL_SEND_MESSAGE = {", "// Returns true when the click");

  const openPromptEditors = new Set();
  const promptDrafts = new Map();
  const sent = [];
  const toasts = [];
  const fields = new Map();

  const build = new Function(
    "escapeHtml",
    "openPromptEditors",
    "promptDrafts",
    "document",
    "CSS",
    "send",
    "renderState",
    "showToast",
    "setState",
    `${editorSource}\n${sendSource}\nreturn { manualPromptEditor, sendManualPrompt };`
  );

  const api = build(
    escapeHtml,
    openPromptEditors,
    promptDrafts,
    { querySelector: (selector) => fields.get(selector) || null },
    { escape: (value) => value },
    async (type, payload) => {
      sent.push({ type, payload });
      return { ok: true };
    },
    () => {},
    (message) => toasts.push(message),
    () => {}
  );

  return {
    openPromptEditors,
    promptDrafts,
    sent,
    toasts,
    render(kind, id, label) {
      const editorKey = `${kind}:${id}`;
      if (opened) openPromptEditors.add(editorKey);
      const html = api.manualPromptEditor({ kind, id, prompt: savedPrompt, label });
      // The browser fills the textarea from the markup; mirror that, then apply
      // whatever the user typed on top of it.
      const rendered = html.match(/spellcheck="false">([\s\S]*?)<\/textarea>/);
      fields.set(`[data-prompt-draft="${editorKey}"]`, {
        value: typed === null ? (rendered ? rendered[1] : "") : typed
      });
      if (typed !== null) promptDrafts.set(editorKey, typed);
      return html;
    },
    send: (editorKey, options) => api.sendManualPrompt(editorKey, options)
  };
}

test("sending an unedited editor uses the prompt already shown in the field", async () => {
  const harness = manualPromptHarness({ savedPrompt: "@suok, plain white jeogori, level clear eyes" });
  harness.render("job", "job-2", "장면 002");

  // Opened and sent without a keystroke: no "input" event ever fired, so the
  // draft map is empty while the textarea is full.
  assert.equal(harness.promptDrafts.size, 0);
  await harness.send("job:job-2", { edited: true });

  assert.deepEqual(harness.sent, [{
    type: "PREPARE_MANUAL_SCENE",
    payload: { jobId: "job-2", prompt: "@suok, plain white jeogori, level clear eyes" }
  }]);
});

test("sending an edited editor uses what the field holds now, for scenes and characters", async () => {
  const scene = manualPromptHarness({ savedPrompt: "@suok stands still", typed: "@suok and @hyangi stand still" });
  scene.render("job", "job-9", "장면 009");
  await scene.send("job:job-9", { edited: true });
  assert.deepEqual(scene.sent, [{
    type: "PREPARE_MANUAL_SCENE",
    payload: { jobId: "job-9", prompt: "@suok and @hyangi stand still" }
  }]);

  const character = manualPromptHarness({ savedPrompt: "20대 여성", typed: "30대 여성, 남색 치마" });
  character.render("character", "char-1", "@suok");
  await character.send("character:char-1", { edited: true });
  assert.deepEqual(character.sent, [{
    type: "PREPARE_MANUAL_CHARACTER",
    payload: { characterId: "char-1", prompt: "30대 여성, 남색 치마" }
  }]);
});

test("a send closes its editor and drops the draft, and a blank field is refused", async () => {
  const harness = manualPromptHarness({ savedPrompt: "@suok stands still", typed: "  keep this  " });
  harness.render("job", "job-3", "장면 003");
  await harness.send("job:job-3", { edited: true });

  assert.equal(harness.sent[0].payload.prompt, "keep this");
  assert.equal(harness.openPromptEditors.has("job:job-3"), false);
  assert.equal(harness.promptDrafts.has("job:job-3"), false);
  assert.equal(harness.toasts.length, 1);

  const blank = manualPromptHarness({ savedPrompt: "@suok stands still", typed: "   " });
  blank.render("job", "job-4", "장면 004");
  await assert.rejects(
    () => blank.send("job:job-4", { edited: true }),
    /보낼 프롬프트가 비어 있습니다/
  );
  assert.deepEqual(blank.sent, []);
});

test("the plain manual button sends no prompt override at all", async () => {
  const harness = manualPromptHarness({ savedPrompt: "@suok stands still", opened: false });
  harness.render("job", "job-5", "장면 005");
  await harness.send("job:job-5");

  assert.deepEqual(harness.sent, [{ type: "PREPARE_MANUAL_SCENE", payload: { jobId: "job-5" } }]);
});
