import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
const controlStart = source.indexOf("  const hasPending = state.jobs.some");
const controlEnd = source.indexOf("  elements.syncCharactersButton.disabled", controlStart);
const controlSource = source.slice(controlStart, controlEnd);

test("a manually recovered scene does not hide automatic queue controls", () => {
  assert.doesNotMatch(controlSource, /manualWorkflow/);
  assert.match(controlSource, /elements\.resumeButton\.hidden = state\.status !== "paused" \|\| hasFailed/);
});
