function startsWith(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function detectImageExtension(contentType, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (data.length >= 12 && startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (data.length >= 8 && startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (data.length >= 3 && startsWith(data, [0xff, 0xd8, 0xff])) return "jpeg";
  if (data.length >= 6 && (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "gif";

  const normalizedType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  return ({
    "image/webp": "webp",
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/gif": "gif"
  })[normalizedType] || "jpeg";
}

export function replaceImageExtension(filename, extension) {
  const path = String(filename || "image.jpeg");
  const suffix = String(extension || "jpeg").replace(/^\./, "").toLowerCase() || "jpeg";
  return /\.[a-z0-9]+$/i.test(path) ? path.replace(/\.[a-z0-9]+$/i, `.${suffix}`) : `${path}.${suffix}`;
}
