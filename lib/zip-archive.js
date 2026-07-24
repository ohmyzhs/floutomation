const encoder = new TextEncoder();

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("ZIP 항목은 바이트 배열이어야 합니다.");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

function write16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function write32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function concat(chunks, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

// A store-only ZIP avoids a second CPU-heavy compression pass over JPEG files,
// which are already compressed. Its entries are standard UTF-8 ZIP members.
export function createStoredZip(files, now = new Date()) {
  const timestamp = dosTimestamp(now);
  const localChunks = [];
  const directoryChunks = [];
  let localLength = 0;
  let directoryLength = 0;
  let offset = 0;

  for (const file of files || []) {
    const filename = String(file?.filename || "").replace(/^\/+/, "");
    if (!filename) throw new Error("ZIP 항목의 파일명이 비어 있습니다.");
    const name = encoder.encode(filename);
    const data = asBytes(file.bytes);
    const crc = crc32(data);

    const localHeader = new Uint8Array(30);
    write32(localHeader, 0, 0x04034b50);
    write16(localHeader, 4, 20);
    write16(localHeader, 6, 0x0800);
    write16(localHeader, 8, 0);
    write16(localHeader, 10, timestamp.time);
    write16(localHeader, 12, timestamp.date);
    write32(localHeader, 14, crc);
    write32(localHeader, 18, data.length);
    write32(localHeader, 22, data.length);
    write16(localHeader, 26, name.length);
    write16(localHeader, 28, 0);
    localChunks.push(localHeader, name, data);
    localLength += localHeader.length + name.length + data.length;

    const directoryHeader = new Uint8Array(46);
    write32(directoryHeader, 0, 0x02014b50);
    write16(directoryHeader, 4, 20);
    write16(directoryHeader, 6, 20);
    write16(directoryHeader, 8, 0x0800);
    write16(directoryHeader, 10, 0);
    write16(directoryHeader, 12, timestamp.time);
    write16(directoryHeader, 14, timestamp.date);
    write32(directoryHeader, 16, crc);
    write32(directoryHeader, 20, data.length);
    write32(directoryHeader, 24, data.length);
    write16(directoryHeader, 28, name.length);
    write16(directoryHeader, 30, 0);
    write16(directoryHeader, 32, 0);
    write16(directoryHeader, 34, 0);
    write16(directoryHeader, 36, 0);
    write32(directoryHeader, 38, 0);
    write32(directoryHeader, 42, offset);
    directoryChunks.push(directoryHeader, name);
    directoryLength += directoryHeader.length + name.length;
    offset += localHeader.length + name.length + data.length;
  }

  const end = new Uint8Array(22);
  write32(end, 0, 0x06054b50);
  write16(end, 4, 0);
  write16(end, 6, 0);
  write16(end, 8, directoryChunks.length / 2);
  write16(end, 10, directoryChunks.length / 2);
  write32(end, 12, directoryLength);
  write32(end, 16, localLength);
  write16(end, 20, 0);
  return concat([...localChunks, ...directoryChunks, end], localLength + directoryLength + end.length);
}
