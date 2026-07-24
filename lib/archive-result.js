export function requireArchiveResult(value) {
  const url = String(value?.url || "");
  const count = Number(value?.count);
  if (!url.startsWith("blob:")) throw new Error("ZIP 생성 결과에 Blob URL이 없습니다.");
  if (!Number.isInteger(count) || count < 1) throw new Error("ZIP 생성 결과의 이미지 개수가 올바르지 않습니다.");
  return { url, count };
}
