import { analyzeIntroAssets, analyzePrompts, formatLabel } from "./lib/prompt-parser.js";
import { MIN_DELAY_MS, createInitialState, hydrateState, summarizeState } from "./lib/queue-state.js";

const elements = Object.fromEntries(
  [
    "checkFlowButton", "connectionDot", "connectionLabel", "queueStatusTitle", "statusBadge",
    "overallProgressBar", "completedStat", "imageStat", "characterStat", "remainingStat", "countdownRow",
    "countdownText", "errorBanner", "fileInput", "dropZone", "promptSource", "clearSourceButton", "sceneModeButton", "introModeButton", "modeDescription",
    "sourceSubtitle", "dropZoneAction", "dropZoneRest", "dropZoneHint", "introFileStatus", "sourceOrDivider", "promptSourceLabel",
    "analysisSummary", "detectedJobCount", "detectedImageCount", "detectedCharacterCount", "detectedFormat", "analysisWarning",
    "previewList", "applyQueueButton", "modelSelect", "delaySeconds", "existingCharactersRow", "charactersAlreadyRegistered",
    "characterSection", "characterListCaption", "characterList", "syncCharactersButton", "jobListCaption", "jobList", "retryFailedButton",
    "downloadProjectButton", "downloadProgress", "downloadProgressBar", "downloadStatus",
    "openFlowButton", "startButton", "pauseButton", "resumeButton", "retryFailedFooterButton", "resetButton", "toast"
  ].map((id) => [id, document.getElementById(id)])
);

let state = createInitialState();
let analysis = analyzePrompts("");
let inputMode = "scene";
let sceneSource = "";
let introSource = "";
let thumbnailSource = "";
let introFileName = "";
let toastTimer = null;
let sourceSaveTimer = null;
let downloadBusy = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "확장 프로그램 작업에 실패했습니다.");
  return response.result;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2_700);
}

function setConnected(connected, label) {
  elements.checkFlowButton.classList.toggle("connected", connected);
  elements.checkFlowButton.classList.toggle("disconnected", connected === false);
  elements.connectionLabel.textContent = label || (connected ? "Flow 연결됨" : "연결 안 됨");
}

function knownCharacterKeys() {
  return (state.characters || []).map((character) => character.key).filter(Boolean);
}

function renderInputMode() {
  const intro = inputMode === "intro";
  elements.sceneModeButton.setAttribute("aria-selected", String(!intro));
  elements.introModeButton.setAttribute("aria-selected", String(intro));
  elements.modeDescription.textContent = intro
    ? "인트로는 파일의 [A] 이미지 프롬프트만, 썸네일은 아래 텍스트 한 건만 사용합니다. 둘 다 현재 프로젝트의 캐릭터를 연결합니다."
    : "장면용 프롬프트 파일을 분석해 캐릭터 생성과 장면 생성을 순서대로 진행합니다.";
  elements.sourceSubtitle.textContent = intro ? "인트로 파일 + 썸네일 텍스트" : "Markdown 파일 또는 텍스트";
  elements.dropZoneAction.textContent = intro ? "인트로훅 파일 선택" : "파일을 선택";
  elements.dropZoneRest.textContent = "하거나 여기에 놓으세요";
  elements.dropZoneHint.textContent = intro ? ".txt · .md · [A] 이미지 프롬프트만 추출" : ".md · .txt";
  elements.introFileStatus.hidden = !intro || !introFileName;
  elements.introFileStatus.textContent = introFileName ? `선택한 인트로 파일: ${introFileName}` : "";
  elements.sourceOrDivider.hidden = intro;
  elements.promptSourceLabel.classList.toggle("sr-only", !intro);
  elements.promptSourceLabel.textContent = intro ? "썸네일 프롬프트" : "이미지 프롬프트 텍스트";
  elements.promptSource.value = intro ? thumbnailSource : sceneSource;
  elements.promptSource.placeholder = intro
    ? "@dongnae, @insun, two-shot positioned toward the right side of the frame…\n\n썸네일 1장용 프롬프트만 붙여넣으세요."
    : "## 이미지 1\n비 오는 밤, 네온사인 골목…\n\n## 이미지 2\n해 질 무렵의 바닷가…";
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const statusMeta = {
  idle: ["작업 준비", "대기", "status-idle"],
  running: ["이미지 생성 중", "실행 중", "status-running"],
  configuring: ["Flow 설정 확인 중", "설정 중", "status-running"],
  waiting: ["다음 작업 대기", "간격 대기", "status-waiting"],
  pausing: ["현재 작업 마무리 중", "중단 예약", "status-waiting"],
  paused: ["작업이 중단됨", "중단", "status-error"],
  completed: ["모든 작업 완료", "완료", "status-completed"]
};

function renderJobs() {
  if (!state.jobs.length) {
    elements.jobListCaption.textContent = "아직 적용된 작업이 없습니다";
    elements.jobList.innerHTML = '<div class="empty-state"><span>◇</span><p>프롬프트를 분석한 뒤<br />작업 큐에 적용하세요.</p></div>';
    return;
  }

  const hasPreviousScenes = state.queueMode === "intro" && state.jobs.some((job) => !["intro", "thumbnail"].includes(job.sourceMode));
  const jobLabel = hasPreviousScenes ? "장면 + 인트로" : state.queueMode === "intro" ? "인트로" : "장면";
  elements.jobListCaption.textContent = `${jobLabel} ${state.jobs.length}개 작업 · ${state.jobs.length * state.options.imagesPerPrompt}장 예정`;
  const canRemove = !state.activeJobId && !["running", "waiting", "pausing"].includes(state.status);
  const labels = {
    pending: "대기",
    configuring: "설정",
    generating: "생성",
    manual: "수동 생성",
    completed: "완료",
    failed: "실패"
  };

  elements.jobList.innerHTML = state.jobs.map((job, index) => `
    <article class="job-item ${escapeHtml(job.status)}">
      <div class="job-row">
        <span class="job-number">${String(index + 1).padStart(2, "0")}</span>
        <div class="job-copy" title="${escapeHtml(job.prompt)}">
          <div class="job-title">${escapeHtml(job.title)}</div>
          <div class="job-stage">${escapeHtml(job.stage || "대기 중")}</div>
        </div>
        <div class="job-status-controls">
          <label class="character-ready-toggle" title="체크하면 이 장면 작업을 완료로 처리하고 건너뜁니다">
            <input type="checkbox" data-job-ready="${escapeHtml(job.id)}" aria-label="${index + 1}번 장면 완료로 지정" ${job.status === "completed" ? "checked" : ""} ${state.activeJobId || ["running", "waiting", "pausing"].includes(state.status) ? "disabled" : ""} />
            <span aria-hidden="true">✓</span>
          </label>
          <span class="job-badge">${labels[job.status] || escapeHtml(job.status)}</span>
          ${canRemove && job.status !== "completed" ? `<button class="remove-job" data-remove-job="${escapeHtml(job.id)}" type="button" aria-label="${index + 1}번 작업 삭제">×</button>` : ""}
        </div>
      </div>
      <div class="job-progress"><span style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></span></div>
      ${job.status === "generating" && Array.isArray(job.generationPercentages) && job.generationPercentages.length
        ? `<div class="job-image-progress" aria-label="생성 이미지별 진행률">${job.generationPercentages.map((percentage, imageIndex) => `<span>이미지 ${imageIndex + 1} <strong>${Math.max(0, Math.min(100, Number(percentage || 0)))}%</strong></span>`).join("")}</div>`
        : ""}
      ${job.status === "pending" && job.lastTransientError
        ? `<p class="job-retry-note">${escapeHtml(job.lastTransientError)}</p>`
        : ""}
      ${job.status === "manual"
        ? `<p class="job-manual-note">Flow에서 직접 생성한 뒤 결과를 확인하고 완료 처리하세요.</p>`
        : ""}
      ${!state.activeJobId && !["running", "waiting", "pausing", "completed"].includes(job.status)
        ? `<div class="job-manual-actions">
            <button class="job-manual-button" data-prepare-manual-job="${escapeHtml(job.id)}" type="button">수동 프롬프트 보내기</button>
            ${job.status === "manual" ? `<button class="job-complete-button" data-complete-manual-job="${escapeHtml(job.id)}" type="button">생성 완료 처리</button>` : ""}
          </div>`
        : ""}
      ${job.error ? `<p class="job-error">${escapeHtml(job.error)}</p>` : ""}
    </article>
  `).join("");
}

function renderCharacters() {
  const characters = state.characters || [];
  elements.characterSection.hidden = !characters.length;
  if (!characters.length) {
    elements.characterList.innerHTML = "";
    return;
  }

  const completed = characters.filter((character) => character.status === "completed").length;
  const synced = (state.lastFlowRegisteredKeys || []).filter((key) => characters.some((character) => character.key === key)).length;
  elements.characterListCaption.textContent = `${completed}/${characters.length}명 준비 · 장면 참조 ${characters.reduce((sum, character) => sum + Number(character.referenceCount || 0), 0)}회${state.lastFlowSyncAt ? ` · Flow 확인 ${synced}명` : ""}`;
  const labels = {
    pending: "대기",
    configuring: "설정",
    generating: "생성",
    review: "검수",
    completed: "완료",
    failed: "실패"
  };

  elements.characterList.innerHTML = characters.map((character) => `
    <article class="character-item ${escapeHtml(character.status)}">
      <div class="character-row">
        <span class="character-avatar">${escapeHtml(character.key.slice(0, 2))}</span>
        <div class="character-copy" title="${escapeHtml(character.prompt)}">
          <div class="character-name">${escapeHtml(character.displayName)} <code>@${escapeHtml(character.key)}</code></div>
          <div class="character-meta">${escapeHtml(character.stage || "생성 대기")} · 장면 ${Number(character.referenceCount || 0)}회</div>
        </div>
        <div class="character-status-controls">
          <label class="character-ready-toggle" title="체크하면 Flow에 이미 등록된 캐릭터로 처리합니다">
            <input type="checkbox" data-character-ready="${escapeHtml(character.id)}" aria-label="@${escapeHtml(character.key)} 등록 완료로 지정" ${character.status === "completed" ? "checked" : ""} ${state.activeJobId || ["running", "waiting", "pausing"].includes(state.status) ? "disabled" : ""} />
            <span aria-hidden="true">✓</span>
          </label>
          <span class="character-badge">${labels[character.status] || escapeHtml(character.status)}</span>
        </div>
      </div>
      <div class="character-progress"><span style="width:${Math.max(0, Math.min(100, Number(character.progress || 0)))}%"></span></div>
      ${character.error ? `<p class="job-error">${escapeHtml(character.error)}</p>` : ""}
      ${character.status === "review" ? `<button class="character-review-button" data-confirm-character="${escapeHtml(character.id)}" type="button">Flow에서 @${escapeHtml(character.key)} 저장 완료 — 계속</button>` : ""}
      ${["failed", "review"].includes(character.status) && (!state.activeJobId || character.status === "review") ? `<button class="character-retry-button" data-retry-character="${escapeHtml(character.id)}" type="button">@${escapeHtml(character.key)} 처음부터 다시 생성</button>` : ""}
    </article>
  `).join("");
}

function renderState() {
  state = hydrateState(state);
  const summary = summarizeState(state);
  const meta = [...(statusMeta[state.status] || statusMeta.idle)];
  if (["running", "pausing"].includes(state.status) && state.activeTaskType === "character") {
    meta[0] = "캐릭터 생성 중";
  }
  const active = state.activeTaskType === "character"
    ? state.characters.find((character) => character.id === state.activeJobId)
    : state.jobs.find((job) => job.id === state.activeJobId);
  const retryingJob = state.status === "waiting"
    ? state.jobs.find((job) => job.status === "pending" && Number(job.autoRetryCount || 0) > 0 && job.lastTransientError)
    : null;
  if (retryingJob) {
    meta[0] = "자동 복구 재시도 대기";
    meta[1] = `재시도 ${retryingJob.autoRetryCount}`;
  }
  const totalTasks = summary.total + summary.charactersTotal;
  const completedTasks = summary.completed + summary.charactersCompleted;
  const refinedPercent = totalTasks
    ? Math.round(((completedTasks + (active ? Number(active.progress || 0) / 100 : 0)) / totalTasks) * 100)
    : 0;

  elements.queueStatusTitle.textContent = meta[0];
  elements.statusBadge.textContent = meta[1];
  elements.statusBadge.className = `status-badge ${meta[2]}`;
  elements.overallProgressBar.style.width = `${Math.min(100, refinedPercent)}%`;
  elements.completedStat.textContent = String(summary.completed);
  elements.imageStat.textContent = String(summary.generatedImages);
  elements.characterStat.textContent = `${summary.charactersCompleted}/${summary.charactersTotal}`;
  elements.remainingStat.textContent = String(Math.max(0, totalTasks - completedTasks));
  elements.delaySeconds.value = String(Math.max(60, Math.round(state.options.delayMs / 1000)));
  elements.delaySeconds.disabled = Boolean(state.activeJobId);
  elements.modelSelect.value = state.options.model;
  elements.modelSelect.disabled = Boolean(state.activeJobId);
  setConnected(Boolean(state.flowConnected), state.flowConnected ? "Flow 연결됨" : "연결 확인");

  const waiting = state.status === "waiting" && state.nextRunAt;
  elements.countdownRow.hidden = !waiting;
  if (waiting) elements.countdownText.textContent = `${retryingJob ? "자동 재시도까지" : "다음 작업까지"} ${formatDuration(state.nextRunAt - Date.now())}`;

  elements.errorBanner.hidden = !state.lastError;
  elements.errorBanner.textContent = state.lastError || "";

  const hasPending = state.jobs.some((job) => job.status === "pending") || state.characters.some((character) => character.status === "pending");
  const hasFailed = state.jobs.some((job) => job.status === "failed") || state.characters.some((character) => character.status === "failed");
  const activeState = ["running", "waiting", "pausing"].includes(state.status) || Boolean(state.activeJobId);
  const manualWorkflow = state.executionMode === "manual";
  elements.startButton.hidden = activeState || state.status === "paused" || manualWorkflow;
  elements.startButton.disabled = !hasPending || activeState;
  elements.startButton.textContent = state.characters.some((character) => character.status === "pending")
    ? "캐릭터부터 생성 시작"
    : state.queueMode === "intro" ? "인트로·썸네일 생성 시작" : "장면 생성 시작";
  elements.pauseButton.hidden = !["running", "waiting", "pausing"].includes(state.status);
  elements.pauseButton.disabled = state.status === "pausing";
  elements.pauseButton.textContent = state.activeJobId ? "현재 작업 후 중단" : "대기열 중단";
  elements.resumeButton.hidden = state.status !== "paused" || hasFailed || manualWorkflow;
  elements.resumeButton.disabled = !hasPending || Boolean(state.activeJobId);
  elements.retryFailedButton.hidden = !hasFailed || Boolean(state.activeJobId);
  elements.retryFailedFooterButton.hidden = !hasFailed || Boolean(state.activeJobId);
  elements.retryFailedFooterButton.disabled = Boolean(state.activeJobId);
  elements.syncCharactersButton.disabled = activeState;
  elements.resetButton.disabled = !(state.jobs.length || state.characters.length) || Boolean(state.activeJobId);
  elements.applyQueueButton.disabled = !analysis.prompts.length
    || Boolean(analysis.unknownRefs?.length)
    || (inputMode === "intro" && !knownCharacterKeys().length)
    || Boolean(state.activeJobId)
    || activeState;
  const hasDownloadSequence = state.jobs.length > 0 || state.characters.length > 0;
  elements.downloadProjectButton.disabled = !hasDownloadSequence || activeState || downloadBusy;
  elements.downloadProjectButton.innerHTML = downloadBusy
    ? '<span aria-hidden="true">…</span> ZIP 준비 중'
    : '<span aria-hidden="true">⇩</span> 프로젝트 ZIP 다운로드';

  renderJobs();
  renderCharacters();
}

function renderAnalysis() {
  const hasPrompts = analysis.prompts.length > 0;
  const intro = inputMode === "intro";
  const hasReusableCharacters = knownCharacterKeys().length > 0;
  const introCount = analysis.prompts.filter((prompt) => prompt.sourceMode === "intro").length;
  const thumbnailCount = analysis.prompts.filter((prompt) => prompt.sourceMode === "thumbnail").length;
  elements.analysisSummary.hidden = !hasPrompts;
  elements.detectedJobCount.textContent = intro
    ? [introCount ? `인트로 ${introCount}개` : "", thumbnailCount ? `썸네일 ${thumbnailCount}개` : ""].filter(Boolean).join(" · ")
    : `${analysis.prompts.length}개 작업`;
  elements.detectedImageCount.textContent = `${intro ? "인트로·썸네일" : "장면"} ${analysis.totalImages}장`;
  elements.detectedCharacterCount.textContent = intro
    ? (hasReusableCharacters ? `기존 캐릭터 ${knownCharacterKeys().length}명 연결` : "기존 캐릭터 없음")
    : (analysis.characters?.length ? `캐릭터 ${analysis.characters.length}명` : "");
  elements.detectedFormat.textContent = formatLabel(analysis.format);
  elements.analysisWarning.hidden = !analysis.warnings.length;
  elements.analysisWarning.textContent = analysis.warnings.join(" ");
  elements.existingCharactersRow.hidden = intro || !(analysis.characters?.length);
  const hasUnknownRefs = Boolean(analysis.unknownRefs?.length);
  elements.applyQueueButton.textContent = intro ? "인트로·썸네일 작업 큐에 적용" : "분석 결과를 작업 큐에 적용";
  elements.applyQueueButton.disabled = !hasPrompts || hasUnknownRefs || (intro && !hasReusableCharacters) || Boolean(state.activeJobId) || ["running", "waiting", "pausing"].includes(state.status);

  if (!hasPrompts) {
    elements.previewList.innerHTML = "";
    return;
  }
  const visiblePrompts = analysis.prompts.slice(0, 8);
  elements.previewList.innerHTML = visiblePrompts.map((item, index) => `
    <div class="preview-item" title="${escapeHtml(item.prompt)}">
      <span class="preview-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="preview-title">${escapeHtml(item.title)}</span>
      <span class="preview-count">2장</span>
    </div>
  `).join("") + (analysis.prompts.length > 8 ? `<div class="preview-more">외 ${analysis.prompts.length - 8}개 작업</div>` : "");
}

function analyzeSource() {
  if (inputMode === "intro") thumbnailSource = elements.promptSource.value;
  else sceneSource = elements.promptSource.value;
  analysis = inputMode === "intro"
    ? analyzeIntroAssets({ introText: introSource, thumbnailText: thumbnailSource, knownCharacterKeys: knownCharacterKeys() })
    : analyzePrompts(sceneSource, { mode: "scene", knownCharacterKeys: knownCharacterKeys() });
  renderAnalysis();
  clearTimeout(sourceSaveTimer);
  sourceSaveTimer = setTimeout(() => {
    const drafts = inputMode === "intro"
      ? { flowBatchIntroDraft: introSource, flowBatchThumbnailDraft: thumbnailSource, flowBatchIntroFileName: introFileName }
      : { flowBatchPromptDraft: sceneSource };
    chrome.storage.local.set(drafts).catch(() => {});
  }, 250);
}

async function readFile(file) {
  if (!file) return;
  if (!/\.(?:md|txt)$/i.test(file.name) && !/text\/(?:plain|markdown)/i.test(file.type || "")) {
    throw new Error(".md 또는 .txt 파일만 가져올 수 있습니다.");
  }
  const source = await file.text();
  if (inputMode === "intro") {
    introSource = source;
    introFileName = file.name;
    renderInputMode();
  } else {
    sceneSource = source;
    elements.promptSource.value = source;
  }
  analyzeSource();
  const summary = inputMode === "intro"
    ? `인트로 ${analysis.prompts.filter((prompt) => prompt.sourceMode === "intro").length}개`
    : `캐릭터 ${analysis.characters?.length || 0}명, 장면 ${analysis.prompts.length}개`;
  showToast(`${file.name}에서 ${summary}를 찾았습니다.`);
}

async function applyQueue() {
  if (!analysis.prompts.length) return;
  const delayMs = Math.max(MIN_DELAY_MS, Number(elements.delaySeconds.value || 60) * 1000);
  await send("UPDATE_OPTIONS", { options: { delayMs, model: elements.modelSelect.value } });
  state = await send("SET_QUEUE", {
    prompts: analysis.prompts,
    characters: analysis.characters || [],
    charactersAlreadyRegistered: elements.charactersAlreadyRegistered.checked,
    queueMode: inputMode,
    reuseExistingCharacters: inputMode === "intro"
  });
  let syncMessage = "";
  if (state.characters.some((character) => character.status !== "completed")) {
    try {
      const syncResult = await send("SYNC_FLOW_STATE");
      state = syncResult.state;
      syncMessage = ` · Flow 등록 ${syncResult.matchedKeys.length}명 확인`;
    } catch (error) {
      syncMessage = ` · Flow 동기화 생략: ${String(error?.message || error)}`;
    }
  }
  renderState();
  const summary = inputMode === "intro"
    ? `기존 캐릭터 ${state.characters.length}명과 ${analysis.prompts.map((prompt) => prompt.sourceMode === "thumbnail" ? "썸네일" : "인트로").filter((value, index, values) => values.indexOf(value) === index).join("·")} ${analysis.prompts.length}개`
    : `캐릭터 ${analysis.characters?.length || 0}명과 장면 ${analysis.prompts.length}개`;
  showToast(`${summary}를 큐에 적용했습니다${syncMessage}.`);
  document.getElementById(inputMode === "scene" && analysis.characters?.length ? "characterSection" : "queueSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startOrResume(type) {
  const delayMs = Math.max(MIN_DELAY_MS, Number(elements.delaySeconds.value || 60) * 1000);
  await send("UPDATE_OPTIONS", { options: { delayMs, model: elements.modelSelect.value } });
  state = await send(type);
  renderState();
}

async function retryAndResume(type, payload = {}) {
  state = await send(type, payload);
  renderState();
  await startOrResume("RESUME_QUEUE");
}

async function checkFlow() {
  elements.connectionLabel.textContent = "확인 중";
  const result = await send("CHECK_FLOW");
  setConnected(Boolean(result.connected), result.connected ? "Flow 연결됨" : "연결 안 됨");
  if (result.connected) {
    showToast("Flow 프로젝트와 연결되었습니다.");
  } else {
    showToast(result.error || "Flow 프로젝트 탭을 열어 주세요.");
  }
}

function withUiError(operation) {
  return async (...args) => {
    try {
      await operation(...args);
    } catch (error) {
      showToast(String(error?.message || error));
    }
  };
}

elements.promptSource.addEventListener("input", analyzeSource);
elements.sceneModeButton.addEventListener("click", () => {
  if (inputMode === "scene") return;
  inputMode = "scene";
  renderInputMode();
  analyzeSource();
  chrome.storage.local.set({ flowBatchInputMode: inputMode }).catch(() => {});
});
elements.introModeButton.addEventListener("click", () => {
  if (inputMode === "intro") return;
  inputMode = "intro";
  renderInputMode();
  analyzeSource();
  chrome.storage.local.set({ flowBatchInputMode: inputMode }).catch(() => {});
});
elements.fileInput.addEventListener("change", withUiError(async () => readFile(elements.fileInput.files?.[0])));
elements.clearSourceButton.addEventListener("click", () => {
  if (inputMode === "intro") {
    introSource = "";
    thumbnailSource = "";
    introFileName = "";
  } else {
    sceneSource = "";
  }
  elements.fileInput.value = "";
  renderInputMode();
  analyzeSource();
});
elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("dragging"); });
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
elements.dropZone.addEventListener("drop", withUiError(async (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
  await readFile(event.dataTransfer?.files?.[0]);
}));

elements.applyQueueButton.addEventListener("click", withUiError(applyQueue));
elements.startButton.addEventListener("click", withUiError(() => startOrResume("START_QUEUE")));
elements.resumeButton.addEventListener("click", withUiError(() => startOrResume("RESUME_QUEUE")));
elements.pauseButton.addEventListener("click", withUiError(async () => {
  state = await send("PAUSE_QUEUE");
  renderState();
}));
elements.retryFailedButton.addEventListener("click", withUiError(async () => {
  await retryAndResume("RETRY_FAILED");
  showToast("실패한 작업을 앞에서부터 다시 실행합니다.");
}));
elements.retryFailedFooterButton.addEventListener("click", withUiError(async () => {
  await retryAndResume("RETRY_FAILED");
  showToast("실패한 작업을 앞에서부터 다시 실행합니다.");
}));
elements.resetButton.addEventListener("click", withUiError(async () => {
  state = await send("RESET_QUEUE");
  renderState();
  showToast("작업 큐를 초기화했습니다.");
}));
elements.openFlowButton.addEventListener("click", withUiError(() => send("OPEN_FLOW")));
elements.checkFlowButton.addEventListener("click", withUiError(checkFlow));
elements.syncCharactersButton.addEventListener("click", withUiError(async () => {
  const result = await send("SYNC_FLOW_STATE");
  state = result.state;
  renderState();
  showToast(`Flow에서 등록된 캐릭터 ${result.matchedKeys.length}명을 큐와 동기화했습니다.`);
}));
elements.downloadProjectButton.addEventListener("click", withUiError(async () => {
  downloadBusy = true;
  elements.downloadProgress.hidden = false;
  elements.downloadProgress.classList.remove("error");
  elements.downloadProgressBar.style.width = "4%";
  elements.downloadStatus.textContent = "Flow 모든 미디어 카드에서 원본 이미지 URL을 순서대로 수집하는 중";
  renderState();
  try {
    const result = await send("DOWNLOAD_PROJECT");
    const missing = [
      result.missingScenes?.length ? `장면 ${result.missingScenes.join(", ")}` : "",
      result.missingCharacters?.length ? `캐릭터 ${result.missingCharacters.join(", ")}` : ""
    ].filter(Boolean);
    elements.downloadProgressBar.style.width = "100%";
    const totalMedia = result.removedCharacterMediaCount
      ? `전체 ${result.allMediaCount}장 → 장면 ${result.scannedSceneCount}/${result.expectedSceneCount}장`
      : `카드 ${result.scannedSceneCount}/${result.expectedSceneCount}장`;
    const extras = result.extraSceneCount ? ` · 추가 카드 ${result.extraSceneCount}장 제외` : "";
    elements.downloadStatus.textContent = `${result.archiveFilename} · ${totalMedia} · 장면 ${result.sceneCount}장 · 캐릭터 ${result.characterCount}장${extras}${missing.length ? ` · 미확인 ${missing.join(" / ")}` : ""}`;
    showToast(`${result.downloaded}개 이미지를 ZIP 파일 하나로 저장했습니다.`);
  } catch (error) {
    const message = String(error?.message || error);
    elements.downloadProgress.classList.add("error");
    elements.downloadStatus.textContent = `다운로드 실패: ${message}`;
    showToast("다운로드가 실패했습니다. 프로젝트 결과 영역의 오류를 확인해 주세요.");
  } finally {
    downloadBusy = false;
    renderState();
  }
}));
elements.delaySeconds.addEventListener("change", () => {
  const seconds = Math.min(600, Math.max(60, Number(elements.delaySeconds.value || 60)));
  elements.delaySeconds.value = String(seconds);
});
elements.modelSelect.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: { model: elements.modelSelect.value } });
  renderState();
  showToast(`${state.options.model} 모델로 변경했습니다. 다음 생성부터 Flow에도 적용됩니다.`);
}));
elements.jobList.addEventListener("click", withUiError(async (event) => {
  const prepareButton = event.target.closest("[data-prepare-manual-job]");
  if (prepareButton) {
    state = await send("PREPARE_MANUAL_SCENE", { jobId: prepareButton.dataset.prepareManualJob });
    renderState();
    showToast("Flow 입력창에 캐릭터 바인딩과 프롬프트를 준비했습니다. 생성은 Flow에서 직접 실행하세요.");
    return;
  }
  const completeButton = event.target.closest("[data-complete-manual-job]");
  if (completeButton) {
    state = await send("COMPLETE_MANUAL_SCENE", { jobId: completeButton.dataset.completeManualJob });
    renderState();
    showToast("사용자 확인으로 작업을 완료 처리했습니다.");
    return;
  }
  const button = event.target.closest("[data-remove-job]");
  if (!button) return;
  state = await send("REMOVE_JOB", { jobId: button.dataset.removeJob });
  renderState();
}));
elements.jobList.addEventListener("change", withUiError(async (event) => {
  const checkbox = event.target.closest("[data-job-ready]");
  if (!checkbox) return;
  state = await send("SET_JOB_READY", {
    jobId: checkbox.dataset.jobReady,
    ready: checkbox.checked
  });
  renderState();
  showToast(checkbox.checked ? "선택한 장면 작업을 건너뜁니다." : "선택한 장면 작업부터 다시 생성할 수 있습니다.");
}));
elements.characterList.addEventListener("click", withUiError(async (event) => {
  const retryButton = event.target.closest("[data-retry-character]");
  if (retryButton) {
    await retryAndResume("RETRY_CHARACTER", { characterId: retryButton.dataset.retryCharacter });
    showToast("선택한 캐릭터를 다시 생성합니다.");
    return;
  }
  const confirmButton = event.target.closest("[data-confirm-character]");
  if (!confirmButton) return;
  state = await send("CONFIRM_CHARACTER", { characterId: confirmButton.dataset.confirmCharacter });
  renderState();
  showToast("캐릭터 등록을 확인했습니다. 대기 후 다음 작업을 진행합니다.");
}));
elements.characterList.addEventListener("change", withUiError(async (event) => {
  const checkbox = event.target.closest("[data-character-ready]");
  if (!checkbox) return;
  state = await send("SET_CHARACTER_READY", {
    characterId: checkbox.dataset.characterReady,
    ready: checkbox.checked
  });
  renderState();
  showToast(checkbox.checked ? "선택한 캐릭터 생성을 건너뜁니다." : "선택한 캐릭터부터 다시 생성할 수 있습니다.");
}));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PROJECT_DOWNLOAD_PROGRESS") {
    const progress = message.progress || {};
    const total = Math.max(1, Number(progress.total || 1));
    const current = Math.max(0, Number(progress.current || 0));
    elements.downloadProgress.hidden = false;
    elements.downloadProgress.classList.remove("error");
    elements.downloadProgressBar.style.width = `${Math.max(4, Math.min(100, Math.round((current / total) * 100)))}%`;
    elements.downloadStatus.textContent = String(progress.message || "프로젝트 이미지를 준비하는 중");
    return;
  }
  if (message?.type === "STATE_UPDATED") {
    state = hydrateState(message.state);
    renderState();
  }
});

setInterval(() => {
  if (state.status === "waiting" && state.nextRunAt) renderState();
}, 1_000);

async function initialize() {
  const [storedState, draft] = await Promise.all([
    send("GET_STATE"),
    chrome.storage.local.get([
      "flowBatchPromptDraft", "flowBatchInputMode", "flowBatchIntroDraft", "flowBatchThumbnailDraft", "flowBatchIntroFileName"
    ])
  ]);
  state = hydrateState(storedState);
  inputMode = draft.flowBatchInputMode === "intro" ? "intro" : "scene";
  sceneSource = String(draft.flowBatchPromptDraft || "");
  introSource = String(draft.flowBatchIntroDraft || "");
  thumbnailSource = String(draft.flowBatchThumbnailDraft || "");
  introFileName = String(draft.flowBatchIntroFileName || "");
  renderInputMode();
  analysis = inputMode === "intro"
    ? analyzeIntroAssets({ introText: introSource, thumbnailText: thumbnailSource, knownCharacterKeys: knownCharacterKeys() })
    : analyzePrompts(sceneSource, { mode: "scene", knownCharacterKeys: knownCharacterKeys() });
  renderAnalysis();
  renderState();
}

withUiError(initialize)();
