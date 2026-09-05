import { createStoredZip } from "./lib/zip-archive.js";
import { detectImageExtension, replaceImageExtension } from "./lib/image-format.js";
import { flowOriginalUrl } from "./lib/download-manifest.js";

const archiveUrls = new Map();
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;

function progress(current, total, message) {
  chrome.runtime.sendMessage({
    type: "PROJECT_DOWNLOAD_PROGRESS",
    progress: { phase: "archiving", current, total, message }
  }).catch(() => {});
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchOriginalOnce(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Flow download endpoints require the signed-in Flow session. The final
    // flow-content.google response is permitted by manifest host access.
    const response = await fetch(flowOriginalUrl(entry.url), {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });
    if (/^https:\/\/www\.google\.com\/sorry\//i.test(response.url)) {
      throw new Error("Google Flow가 자동 요청 확인 페이지를 표시했습니다. Flow 탭에서 CAPTCHA 또는 로그인 확인을 직접 완료한 뒤 다시 시도해 주세요.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Flow 로그인 세션으로 원본을 열지 못했습니다 (${response.status}). 확장과 Flow 페이지를 새로고침한 뒤 다시 시도해 주세요.`);
    }
    if (!response.ok) throw new Error(`원본 응답 ${response.status}`);
    if (/text\/html/i.test(response.headers.get("content-type") || "")) {
      throw new Error("Flow 원본 대신 확인 페이지가 응답했습니다. Flow 탭에서 로그인 또는 CAPTCHA 확인을 완료한 뒤 다시 시도해 주세요.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("원본 이미지가 비어 있습니다.");
    return {
      bytes,
      extension: detectImageExtension(response.headers.get("content-type"), bytes)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOriginal(entry, onRetry) {
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOriginalOnce(entry);
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error(`원본 요청이 ${Math.round(FETCH_TIMEOUT_MS / 1000)}초 안에 끝나지 않았습니다.`)
        : error;
      if (attempt >= FETCH_ATTEMPTS) break;
      onRetry?.(attempt + 1, lastError);
      await sleep(1_000 * attempt);
    }
  }
  throw lastError || new Error("Flow 원본 이미지를 가져오지 못했습니다.");
}

async function buildArchive(entries) {
  const files = new Array(entries.length);
  let nextIndex = 0;
  let completed = 0;
  let failure = null;
  const workerCount = Math.min(2, entries.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      progress(completed, entries.length, `${entry.filename.split("/").pop()} 원본 수집 중`);
      try {
        const original = await fetchOriginal(entry, (attempt, error) => {
          progress(
            completed,
            entries.length,
            `${entry.filename.split("/").pop()} 재시도 ${attempt}/${FETCH_ATTEMPTS} · ${String(error?.message || error)}`
          );
        });
        files[index] = {
          filename: replaceImageExtension(entry.filename, original.extension),
          bytes: original.bytes
        };
      } catch (error) {
        failure = new Error(`${entry.filename.split("/").pop()} 수집 실패: ${String(error?.message || error)}`);
      } finally {
        completed += 1;
        progress(completed, entries.length, `이미지 ${completed}/${entries.length}장 ZIP에 준비 중`);
      }
    }
  }));

  if (failure) throw failure;
  const zip = createStoredZip(files.filter(Boolean));
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  archiveUrls.set(url, true);
  return { url, count: files.length };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (message.type === "BUILD_PROJECT_ARCHIVE") {
    void buildArchive(message.entries || [])
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message.type === "REVOKE_PROJECT_ARCHIVE") {
    const url = String(message.url || "");
    if (archiveUrls.has(url)) {
      archiveUrls.delete(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
