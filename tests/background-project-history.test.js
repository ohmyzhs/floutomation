import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../background.js", import.meta.url), "utf8");
const loadStart = source.indexOf("async function loadCurrentProjectCharacters");
const loadEnd = source.indexOf("async function handleFlowEvent", loadStart);
const loadSource = source.slice(loadStart, loadEnd);

test("project character reload restores a saved profile or reads the active Flow library", () => {
  assert.match(loadSource, /findProjectCharacterProfile/);
  assert.match(loadSource, /DISCOVER_FLOW_CHARACTERS/);
  assert.match(loadSource, /state\.jobs = \[\]/);
  assert.match(loadSource, /archiveProjectCharacters/);
});

test("intro reuse refuses to bind characters from a different Flow project", () => {
  const setQueueStart = source.indexOf('if (message.type === "SET_QUEUE")');
  const setQueueEnd = source.indexOf('if (message.type === "SYNC_FLOW_STATE")', setQueueStart);
  const setQueueSource = source.slice(setQueueStart, setQueueEnd);
  assert.match(setQueueSource, /!current\.flowProjectId \|\| !flowProject\?\.projectId \|\| current\.flowProjectId !== flowProject\.projectId/);
  assert.match(setQueueSource, /프로젝트 캐릭터 불러오기/);
});

test("intro character recovery reloads the active project when saved bindings belong elsewhere", () => {
  const ensureStart = source.indexOf("async function ensureCurrentProjectCharacters");
  const ensureEnd = source.indexOf("async function handleFlowEvent", ensureStart);
  const ensureSource = source.slice(ensureStart, ensureEnd);
  assert.match(ensureSource, /synchronizeFlowCharacters/);
  assert.match(ensureSource, /loadCurrentProjectCharacters/);
  assert.match(source, /message\.type === "ENSURE_CURRENT_PROJECT_CHARACTERS"/);
});
