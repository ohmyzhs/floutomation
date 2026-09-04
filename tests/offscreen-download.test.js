import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../offscreen.js", import.meta.url), "utf8");

test("Flow originals use the signed-in redirect and retry timed-out downloads", () => {
  assert.match(source, /credentials:\s*"include"/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /const FETCH_ATTEMPTS = 3/);
  assert.match(source, /재시도/);
});

test("archive entries use the actual downloaded image format", () => {
  assert.match(source, /detectImageExtension/);
  assert.match(source, /replaceImageExtension\(entry\.filename, original\.extension\)/);
  assert.match(source, /bytes: original\.bytes/);
});
