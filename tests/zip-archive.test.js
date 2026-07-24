import test from "node:test";
import assert from "node:assert/strict";

import { createStoredZip } from "../lib/zip-archive.js";

function read16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function read32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

test("ZIP archive preserves requested image paths and writes one standard archive", () => {
  const zip = createStoredZip([
    { filename: "Flow Batch Studio/project/001-1.jpeg", bytes: new Uint8Array([1, 2, 3]) },
    { filename: "Flow Batch Studio/project/새별.jpeg", bytes: new Uint8Array([4, 5]) }
  ], new Date(2026, 6, 20, 13, 45, 6));

  assert.equal(read32(zip, 0), 0x04034b50);
  const endOffset = zip.length - 22;
  assert.equal(read32(zip, endOffset), 0x06054b50);
  assert.equal(read16(zip, endOffset + 8), 2);
  const directoryOffset = read32(zip, endOffset + 16);
  assert.equal(read32(zip, directoryOffset), 0x02014b50);
  assert.match(new TextDecoder().decode(zip), /001-1\.jpeg/);
  assert.match(new TextDecoder().decode(zip), /새별\.jpeg/);
});
