import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
const reasonStart = source.indexOf("function applyQueueDisabledReason");
const reasonEnd = source.indexOf("function startQueueDisabledReason", reasonStart);
const applyReasonSource = source.slice(reasonStart, reasonEnd);

test("disabled queue application tells the user which character bindings are missing", () => {
  assert.match(applyReasonSource, /uniqueUnknownCharacterKeys/);
  assert.match(applyReasonSource, /저장된 캐릭터 불러오기/);
  assert.match(applyReasonSource, /Flow 등록 캐릭터 읽기/);
});

test("disabled controls expose both a tooltip and visible reason text", () => {
  assert.match(source, /hint\.title = message/);
  assert.match(source, /reasonElement\.textContent = reason \? `비활성화 이유/);
  assert.match(source, /queueControlReason/);
});
