import test from "node:test";
import assert from "node:assert/strict";

import { requireArchiveResult } from "../lib/archive-result.js";

test("offscreen ZIP result contract exposes url and count", () => {
  assert.deepEqual(requireArchiveResult({ url: "blob:chrome-extension://id/archive", count: 105 }), {
    url: "blob:chrome-extension://id/archive",
    count: 105
  });
});

test("legacy files-array result cannot silently pass the ZIP result boundary", () => {
  assert.throws(
    () => requireArchiveResult({ url: "blob:chrome-extension://id/archive", files: new Array(105) }),
    /이미지 개수/
  );
});
