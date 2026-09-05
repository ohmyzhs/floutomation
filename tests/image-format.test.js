import assert from "node:assert/strict";
import test from "node:test";

import { detectImageExtension, replaceImageExtension } from "../lib/image-format.js";

test("Flow WebP originals keep a matching archive extension", () => {
  const bytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
    0x57, 0x45, 0x42, 0x50
  ]);
  assert.equal(detectImageExtension("image/webp", bytes), "webp");
  assert.equal(replaceImageExtension("Scene_Images/001-01.jpeg", "webp"), "Scene_Images/001-01.webp");
});

test("image signatures override a misleading response content type", () => {
  assert.equal(detectImageExtension("image/webp", new Uint8Array([0xff, 0xd8, 0xff, 0x00])), "jpeg");
  assert.equal(detectImageExtension("application/octet-stream", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
});
