import { analyzeIntroAssets, analyzePrompts } from "./lib/prompt-parser.js";
import { MAX_DELAY_MS, MIN_DELAY_MS, createInitialState, hydrateState, summarizeState } from "./lib/queue-state.js";

const elements = Object.fromEntries(
  [
    "openFlowButton", "checkFlowButton", "connectionDot", "connectionLabel", "queueStatusTitle", "statusBadge",
    "overallProgressBar", "completedStat", "imageStat", "characterStat", "remainingStat", "countdownRow",
    "countdownText", "errorBanner", "fileInput", "dropZone", "promptSource", "sceneModeButton", "introModeButton", "modeDescription",
    "sourceSubtitle", "dropZoneAction", "dropZoneRest", "dropZoneHint", "introFileStatus", "sourceOrDivider", "promptSourceLabel",
    "analysisSummary", "detectedJobCount", "detectedImageCount", "detectedCharacterCount", "analysisWarning",
    "applyQueueButton", "applyQueueButtonHint", "applyQueueReason", "modelSelect", "aspectRatioSelect", "imageCountSelect", "delayRange", "delayValue", "delayValueLabel", "randomDelayToggle", "randomDelayDescription",
    "characterSection", "characterListCaption", "characterList", "syncCharactersButton", "jobListCaption", "jobList", "retryFailedButton",
    "assetMappingSection", "assetMappingCaption", "assetMappingList", "scanAssetsButton", "unassignedOnlyToggle", "fillFromAssetSelect", "fillFromJobSelect", "fillAssetRangeButton",
    "downloadProjectButton", "downloadProgress", "downloadProgressBar", "downloadStatus",
    "startButton", "startButtonHint", "pauseButton", "resumeButton", "retryFailedFooterButton", "resetButton", "queueControlReason", "toast"
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
let flowCheckInFlight = false;
let showUnassignedOnly = false;
let mappingStartAssetKey = "";
let mappingStartJobId = "";
let draggingAsset = null;
let suppressAssetOpenUntil = 0;

const PROMPT_DRAFT_KEYS = [
  "flowBatchPromptDraft",
  "flowBatchIntroDraft",
  "flowBatchThumbnailDraft",
  "flowBatchIntroFileName"
];

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

function uniqueUnknownCharacterKeys() {
  return [...new Set((analysis.unknownRefs || []).map((entry) => String(entry.key || "").trim()).filter(Boolean))];
}

function setDisabledReason(button, hint, reason, reasonElement = null) {
  const message = reason ? `비활성화 이유: ${reason}` : "";
  button.disabled = Boolean(reason);
  button.title = message;
  hint.title = message;
  if (!reasonElement) {
    button.removeAttribute("aria-describedby");
    return;
  }
  if (reason) button.setAttribute("aria-describedby", reasonElement.id);
  else button.removeAttribute("aria-describedby");
  reasonElement.hidden = !reason;
  reasonElement.textContent = reason ? `비활성화 이유 · ${reason}` : "";
}

function applyQueueDisabledReason() {
  const active = Boolean(state.activeJobId) || ["running", "waiting", "pausing"].includes(state.status);
  if (active) return "현재 큐가 실행 중입니다. 현재 작업을 중단하거나 완료한 뒤 새 작업을 적용하세요.";
  const unknownKeys = uniqueUnknownCharacterKeys();
  if (unknownKeys.length) {
    return `현재 Flow 프로젝트에 준비된 캐릭터가 아닙니다: ${unknownKeys.map((key) => `@${key}`).join(", ")}. 캐릭터 섹션의 ‘Flow와 동기화’를 먼저 실행하세요.`;
  }
  if (inputMode === "intro" && !knownCharacterKeys().length) {
    return "인트로·썸네일에는 현재 Flow 프로젝트의 캐릭터가 필요합니다. 캐릭터 섹션의 ‘Flow와 동기화’를 먼저 실행하세요.";
  }
  if (!analysis.prompts.length) {
    return inputMode === "intro"
      ? "인트로 파일의 [A] 이미지 프롬프트 또는 썸네일 프롬프트를 입력하세요."
      : "장면용 프롬프트 파일 또는 텍스트를 입력하세요.";
  }
  return "";
}

function renderApplyQueueAvailability() {
  setDisabledReason(
    elements.applyQueueButton,
    elements.applyQueueButtonHint,
    applyQueueDisabledReason(),
    elements.applyQueueReason
  );
}

function startQueueDisabledReason({ hasPending, hasFailed, activeState }) {
  if (activeState) return "현재 큐가 실행 중입니다.";
  if (hasFailed) return "실패한 작업이 있습니다. ‘실패 작업 다시 실행’으로 처리한 뒤 시작하세요.";
  if (hasPending) return "";
  if (!state.jobs.length && !state.characters.length) return "작업 큐가 비어 있습니다. 위에서 프롬프트를 분석하고 ‘작업 큐에 적용’을 먼저 누르세요.";
  if (state.status === "completed") return "모든 작업이 완료되었습니다. 새 프롬프트를 적용하거나 완료 체크를 해제하세요.";
  return "실행할 대기 작업이 없습니다. 작업 목록에서 완료 상태를 확인하세요.";
}

function renderInputMode() {
  const intro = inputMode === "intro";
  elements.sceneModeButton.setAttribute("aria-selected", String(!intro));
  elements.introModeButton.setAttribute("aria-selected", String(intro));
  elements.modeDescription.textContent = intro
    ? "인트로는 파일의 [A] 이미지 프롬프트만, 썸네일은 아래 텍스트 한 건만 사용합니다. 둘 다 현재 프로젝트의 캐릭터를 연결합니다."
    : "장면용 프롬프트 파일을 분석해 캐릭터 생성과 장면 생성을 순서대로 진행합니다.";
  elements.sourceSubtitle.textContent = intro ? "인트로 파일 + 썸네일 텍스트" : "Flow_Prompts 파일 또는 텍스트";
  elements.dropZoneAction.textContent = intro ? "인트로훅 파일 선택" : "Flow_Prompts 파일을 선택";
  elements.dropZoneRest.textContent = "하거나 여기에 놓으세요";
  elements.dropZoneHint.textContent = intro ? ".txt · .md · [A] 이미지 프롬프트만 추출" : ".md · .txt · 장면과 캐릭터를 자동 분석";
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
  pausing: ["대기열 중단 중", "중단 처리", "status-waiting"],
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
  const characterSummary = state.characters.length ? ` · 캐릭터 ${state.characters.length}개 별도` : "";
  elements.jobListCaption.textContent = `${jobLabel} ${state.jobs.length}개 작업 · ${state.jobs.length * state.options.imagesPerPrompt}장 예정${characterSummary}`;
  const canRemove = !state.activeJobId && !["running", "waiting", "pausing"].includes(state.status);
  const labels = {
    pending: "대기",
    configuring: "설정",
    generating: "생성",
    manual: "수동 생성",
    completed: "완료",
    failed: "실패"
  };

  function displayAssetsForJob(job) {
    const catalog = Array.isArray(state.assetCatalog) ? state.assetCatalog : [];
    const catalogByKey = new Map(catalog.map((asset) => [asset.assetId || asset.detailUrl || asset.url, asset]));
    const values = [
      ...(Array.isArray(job.resultAssets) ? job.resultAssets : []),
      ...(Array.isArray(job.mappedAssetIds) ? job.mappedAssetIds.map((id) => catalogByKey.get(String(id))).filter(Boolean) : [])
    ];
    const seen = new Set();
    return values.filter((asset) => {
      const key = asset.assetId || asset.detailUrl || asset.url;
      if (!key || seen.has(key) || !asset.url) return false;
      seen.add(key);
      return true;
    });
  }

  elements.jobList.innerHTML = state.jobs.map((job, index) => {
    const resultAssets = displayAssetsForJob(job);
    const assetButtons = resultAssets.map((asset, assetIndex) => {
      const targetAttribute = asset.detailUrl ? "data-open-asset" : "data-open-image";
      const target = asset.detailUrl || asset.url;
      const key = asset.assetId || asset.detailUrl || asset.url;
      const removeButton = canRemove
        ? `<button class="job-asset-remove" data-remove-job-asset="${escapeHtml(job.id)}" data-asset-key="${escapeHtml(key)}" type="button" aria-label="${index + 1}번 장면 결과 이미지 ${assetIndex + 1} 연결 해제">×</button>`
        : "";
      const dragTitle = canRemove ? `다른 장면으로 드래그해 이동 · 결과 이미지 ${assetIndex + 1} 열기` : `결과 이미지 ${assetIndex + 1} 열기`;
      return `<span class="job-asset-wrap"><button class="job-asset-button" ${targetAttribute}="${escapeHtml(target)}" data-drag-asset="${escapeHtml(key)}" data-drag-source="${escapeHtml(job.id)}" draggable="${canRemove ? "true" : "false"}" type="button" title="${dragTitle}" aria-label="${index + 1}번 장면 결과 이미지 ${assetIndex + 1} 열기"><img class="job-asset-thumb" src="${escapeHtml(asset.url)}" alt="" loading="lazy" /><span>#${assetIndex + 1}</span><span class="job-asset-preview" aria-hidden="true"><img src="${escapeHtml(asset.url)}" alt="" loading="lazy" /></span></button>${removeButton}</span>`;
    }).join("");
    const canUseManual = !state.activeJobId && !["running", "waiting", "pausing", "completed"].includes(job.status);
    return `
      <article class="job-item ${escapeHtml(job.status)}" data-drop-job="${escapeHtml(job.id)}">
        <div class="job-row">
          <span class="job-number">${String(index + 1).padStart(2, "0")}</span>
          <div class="job-copy" title="${escapeHtml(job.prompt)}">
            <div class="job-title">${escapeHtml(job.title)}</div>
            <div class="job-stage">${escapeHtml(job.stage || "대기 중")}</div>
          </div>
          <span class="job-badge">${labels[job.status] || escapeHtml(job.status)}</span>
        </div>
        <div class="job-progress"><span style="width:${Math.max(0, Math.min(100, Number(job.progress || 0)))}%"></span></div>
        ${job.status === "generating" && Array.isArray(job.generationPercentages) && job.generationPercentages.length
          ? `<div class="job-image-progress" aria-label="생성 이미지별 진행률">${job.generationPercentages.map((percentage, imageIndex) => `<span>이미지 ${imageIndex + 1} <strong>${Math.max(0, Math.min(100, Number(percentage || 0)))}%</strong></span>`).join("")}</div>`
          : ""}
        <div class="job-action-groups">
          <div class="job-action-group job-work-actions" aria-label="작업 기능">
            <button class="job-action-button" data-copy-prompt="${escapeHtml(job.id)}" type="button" aria-label="${index + 1}번 프롬프트 복사">복사</button>
            ${resultAssets.length ? `<div class="job-assets" aria-label="${index + 1}번 장면 결과 이미지">${assetButtons}</div>` : ""}
            ${canUseManual ? `<button class="job-action-button job-manual-button" data-prepare-manual-job="${escapeHtml(job.id)}" type="button">수동 프롬프트 보내기</button>` : ""}
          </div>
          <div class="job-action-group job-state-controls" aria-label="상태 제어">
            <label class="job-ready-control" title="체크하면 이 장면 작업을 완료로 처리하고 건너뜁니다">
              <input type="checkbox" data-job-ready="${escapeHtml(job.id)}" aria-label="${index + 1}번 장면 완료로 지정" ${job.status === "completed" ? "checked" : ""} ${state.activeJobId || ["running", "waiting", "pausing"].includes(state.status) ? "disabled" : ""} />
              <span aria-hidden="true">✓</span>
            </label>
            ${canRemove && job.status !== "completed" ? `<button class="remove-job" data-remove-job="${escapeHtml(job.id)}" type="button" aria-label="${index + 1}번 작업 삭제">×</button>` : ""}
            ${job.status === "manual" && canUseManual ? `<button class="job-complete-button" data-complete-manual-job="${escapeHtml(job.id)}" type="button">생성 완료 처리</button>` : ""}
          </div>
        </div>
        ${job.status === "pending" && job.lastTransientError
          ? `<p class="job-retry-note">${escapeHtml(job.lastTransientError)}</p>`
          : ""}
        ${job.status === "manual"
          ? `<p class="job-manual-note">Flow에서 직접 생성한 뒤 결과를 확인하고 완료 처리하세요.</p>`
          : ""}
        ${Number(job.resultAssetOverflowCount || 0) > 0
          ? `<p class="job-retry-note">자동 연결 결과가 ${Number(job.resultAssetOverflowCount) + resultAssets.length}장 감지되어 최신 ${resultAssets.length}장만 연결했습니다. 나머지는 이미지 매핑에서 직접 지정할 수 있습니다.</p>`
          : ""}
        ${job.error ? `<p class="job-error">${escapeHtml(job.error)}</p>` : ""}
      </article>
    `;
  }).join("");
}

function renderCharacters() {
  const characters = state.characters || [];
  elements.characterSection.hidden = !characters.length && inputMode !== "intro";
  if (!characters.length) {
    elements.characterList.innerHTML = '<div class="empty-state compact-empty"><span>↔</span><p>Flow와 동기화하면<br />등록된 캐릭터를 읽습니다.</p></div>';
    elements.characterListCaption.textContent = "Flow 등록 캐릭터를 읽어 인트로·썸네일에 연결합니다";
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
        <div class="character-copy" title="${escapeHtml([character.prompt, character.submissionDiagnostic].filter(Boolean).join("\n\n최근 전송 진단: "))}">
          <div class="character-name">${escapeHtml(character.displayName)} <code>@${escapeHtml(character.key)}</code></div>
          <div class="character-meta">${escapeHtml(character.stage || "생성 대기")} · 장면 ${Number(character.referenceCount || 0)}회</div>
          ${character.submissionDiagnostic ? `<div class="character-diagnostic" title="${escapeHtml(character.submissionDiagnostic)}">${escapeHtml(character.submissionDiagnostic)}</div>` : ""}
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

function renderAssetMapping() {
  const catalog = Array.isArray(state.assetCatalog) ? state.assetCatalog : [];
  const jobs = (state.jobs || []).filter((job) => !["character"].includes(job.sourceMode));
  const mappedById = new Map();
  const assetKeys = (asset) => [asset?.assetId, asset?.detailUrl, asset?.url].map((key) => String(key || "").trim()).filter(Boolean);
  jobs.forEach((job) => {
    (job.resultAssets || []).forEach((asset) => assetKeys(asset).forEach((key) => {
      if (!mappedById.has(key)) mappedById.set(key, { jobId: job.id, source: "auto" });
    }));
  });
  jobs.forEach((job) => (job.mappedAssetIds || []).forEach((id) => {
    mappedById.set(String(id), { jobId: job.id, source: "manual" });
  }));
  const unassignedCount = catalog.filter((asset) => !assetKeys(asset).some((key) => mappedById.has(key))).length;
  const visibleCatalog = showUnassignedOnly
    ? catalog.filter((asset) => assetKeys(asset).every((key) => !mappedById.has(key)))
    : catalog;
  const canEdit = !state.activeJobId && !["running", "waiting", "pausing"].includes(state.status);
  const jobLabel = (job) => {
    const mode = job.sourceMode === "thumbnail" ? "썸네일" : job.sourceMode === "intro" ? `인트로 ${job.sourceNumber || job.number}` : `장면 ${String(job.sourceNumber || job.number).padStart(3, "0")}`;
    return `${mode} · ${job.title || "프롬프트"}`;
  };
  const catalogKeys = new Set(catalog.flatMap(assetKeys));
  const orphanAssignments = [];
  const orphanSeen = new Map();
  jobs.forEach((job) => {
    (job.resultAssets || []).forEach((asset) => {
      const keys = assetKeys(asset);
      if (keys.some((key) => catalogKeys.has(key))) return;
      const key = keys[0];
      if (!key || keys.some((alias) => orphanSeen.has(`${job.id}:${alias}`))) return;
      keys.forEach((alias) => orphanSeen.set(`${job.id}:${alias}`, true));
      orphanAssignments.push({ job, key, asset });
    });
    (job.mappedAssetIds || []).forEach((key) => {
      const normalizedKey = String(key).trim();
      if (catalogKeys.has(normalizedKey) || orphanSeen.has(`${job.id}:${normalizedKey}`)) return;
      orphanSeen.set(`${job.id}:${normalizedKey}`, true);
      orphanAssignments.push({ job, key: String(key), asset: null });
    });
  });
  const orphanMarkup = orphanAssignments.length
    ? `<div class="asset-orphan-heading">Flow 목록에 없는 연결 ${orphanAssignments.length}개</div>${orphanAssignments.map(({ job, key, asset }) => `<div class="asset-orphan-row"><div class="asset-orphan-thumb">${asset?.url ? `<img src="${escapeHtml(asset.url)}" alt="" />` : "!"}</div><div class="asset-mapping-copy"><strong>${escapeHtml(jobLabel(job))}</strong><small title="${escapeHtml(key)}">삭제되었거나 현재 Flow 목록에서 사라진 이미지</small></div><button class="asset-orphan-remove" data-remove-job-asset="${escapeHtml(job.id)}" data-asset-key="${escapeHtml(key)}" type="button">연결 해제</button></div>`).join("")}`
    : "";
  elements.assetMappingCaption.textContent = catalog.length
    ? `${catalog.length}개 이미지 · 미지정 ${unassignedCount}개${orphanAssignments.length ? ` · 오래된 연결 ${orphanAssignments.length}개` : ""}`
    : orphanAssignments.length ? `Flow 목록 외 연결 ${orphanAssignments.length}개` : "Flow asset ID를 장면에 고정합니다";
  elements.scanAssetsButton.disabled = !canEdit;
  const fillAssetOptions = catalog.map((asset, index) => {
    const key = asset.assetId || asset.detailUrl || asset.url;
    return `<option value="${escapeHtml(key)}" ${mappingStartAssetKey === key ? "selected" : ""}>${String(index + 1).padStart(3, "0")} · ${escapeHtml(String(key).slice(0, 18))}</option>`;
  }).join("");
  const fillJobOptions = jobs.map((job) => `<option value="${escapeHtml(job.id)}" ${mappingStartJobId === job.id ? "selected" : ""}>${escapeHtml(jobLabel(job))}</option>`).join("");
  if (!catalog.some((asset) => (asset.assetId || asset.detailUrl || asset.url) === mappingStartAssetKey)) mappingStartAssetKey = catalog[0]?.assetId || catalog[0]?.detailUrl || catalog[0]?.url || "";
  if (!jobs.some((job) => job.id === mappingStartJobId)) mappingStartJobId = jobs[0]?.id || "";
  elements.fillFromAssetSelect.innerHTML = fillAssetOptions;
  elements.fillFromJobSelect.innerHTML = fillJobOptions;
  elements.fillFromAssetSelect.value = mappingStartAssetKey;
  elements.fillFromJobSelect.value = mappingStartJobId;
  elements.fillFromAssetSelect.disabled = !canEdit || !catalog.length;
  elements.fillFromJobSelect.disabled = !canEdit || !jobs.length;
  elements.fillAssetRangeButton.disabled = !canEdit || !catalog.length || !jobs.length || !mappingStartAssetKey || !mappingStartJobId;
  elements.fillAssetRangeButton.title = "선택한 이미지와 장면부터 이후 매핑을 번호 순서대로 다시 지정합니다";
  elements.unassignedOnlyToggle.checked = showUnassignedOnly;
  elements.unassignedOnlyToggle.disabled = !catalog.length;
  if (!catalog.length) {
    elements.assetMappingList.innerHTML = orphanMarkup || '<div class="empty-state compact-empty"><span>↔</span><p>Flow 목록을 새로고침하면<br />매핑할 이미지가 표시됩니다.</p></div>';
    return;
  }
  if (!visibleCatalog.length) {
    elements.assetMappingList.innerHTML = orphanMarkup || '<div class="empty-state compact-empty"><span>✓</span><p>모든 Flow 이미지가 장면에 연결되어 있습니다.</p></div>';
    return;
  }
  const catalogMarkup = visibleCatalog.map((asset) => {
    const index = catalog.indexOf(asset);
    const key = asset.assetId || asset.detailUrl || asset.url;
    const assignment = mappedById.get(key);
    const selectedJobId = assignment?.jobId || "";
    const options = [`<option value="">미지정</option>`].concat(jobs.map((job) => `<option value="${escapeHtml(job.id)}" ${selectedJobId === job.id ? "selected" : ""}>${escapeHtml(jobLabel(job))}</option>`));
    return `<div class="asset-mapping-row">
      <img src="${escapeHtml(asset.url)}" alt="Flow 이미지 ${index + 1}" loading="lazy" />
      <div class="asset-mapping-copy"><strong>${String(index + 1).padStart(3, "0")} ${assignment ? `<em class="asset-mapping-source">${assignment.source === "manual" ? "수동" : "자동"}</em>` : ""}</strong><small title="${escapeHtml(key)}">${escapeHtml(key)}</small></div>
      <select data-map-asset="${escapeHtml(key)}" aria-label="Flow 이미지 ${index + 1} 장면 매핑" ${canEdit ? "" : "disabled"}>${options.join("")}</select>
    </div>`;
  }).join("");
  elements.assetMappingList.innerHTML = `${orphanMarkup}${catalogMarkup}`;
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
  const totalTasks = summary.totalTasks;
  const completedTasks = summary.completedTasks;
  const refinedPercent = totalTasks
    ? Math.round(((completedTasks + (active ? Number(active.progress || 0) / 100 : 0)) / totalTasks) * 100)
    : 0;

  elements.queueStatusTitle.textContent = meta[0];
  elements.statusBadge.textContent = meta[1];
  elements.statusBadge.className = `status-badge ${meta[2]}`;
  elements.overallProgressBar.style.width = `${Math.min(100, refinedPercent)}%`;
  elements.completedStat.textContent = String(summary.completedTasks);
  elements.imageStat.textContent = String(summary.generatedImages);
  elements.characterStat.textContent = `${summary.charactersCompleted}/${summary.charactersTotal}`;
  elements.remainingStat.textContent = String(summary.remainingTasks);
  const delaySeconds = Math.round(state.options.delayMs / 1000);
  elements.delayRange.value = String(delaySeconds);
  elements.delayRange.disabled = Boolean(state.activeJobId) || Boolean(state.options.randomDelay);
  elements.delayValue.value = `${delaySeconds}초`;
  elements.delayValue.textContent = `${delaySeconds}초`;
  elements.delayValueLabel.textContent = state.options.randomDelay ? "60~90초 사이 랜덤으로 대기합니다" : `${delaySeconds}초`;
  elements.randomDelayDescription.textContent = state.options.randomDelay
    ? "고정 시간 대신 매 작업마다 60~90초 사이 랜덤"
    : "고정 대기시간을 사용합니다";
  elements.randomDelayToggle.checked = Boolean(state.options.randomDelay);
  elements.randomDelayToggle.disabled = Boolean(state.activeJobId);
  elements.modelSelect.value = state.options.model;
  elements.modelSelect.disabled = Boolean(state.activeJobId);
  elements.aspectRatioSelect.value = state.options.aspectRatio;
  elements.aspectRatioSelect.disabled = Boolean(state.activeJobId);
  elements.imageCountSelect.value = String(state.options.imagesPerPrompt);
  elements.imageCountSelect.disabled = Boolean(state.activeJobId);
  setConnected(Boolean(state.flowConnected), state.flowConnected ? "Flow 연결됨" : "연결 안 됨");
  elements.openFlowButton.hidden = Boolean(state.flowConnected);

  const waiting = state.status === "waiting" && state.nextRunAt;
  elements.countdownRow.hidden = !waiting;
  if (waiting) elements.countdownText.textContent = `${retryingJob ? "자동 재시도까지" : "다음 작업까지"} ${formatDuration(state.nextRunAt - Date.now())}`;

  elements.errorBanner.hidden = !state.lastError;
  elements.errorBanner.textContent = state.lastError || "";

  const hasPending = state.jobs.some((job) => job.status === "pending") || state.characters.some((character) => character.status === "pending");
  const hasFailed = state.jobs.some((job) => job.status === "failed") || state.characters.some((character) => character.status === "failed");
  if (state.status === "completed" && hasFailed) {
    const failedCount = state.jobs.filter((job) => job.status === "failed").length
      + state.characters.filter((character) => character.status === "failed").length;
    meta[0] = "작업 완료 · 실패 있음";
    meta[1] = `실패 ${failedCount}개`;
    meta[2] = "status-error";
  }
  const activeState = ["running", "waiting", "pausing"].includes(state.status) || Boolean(state.activeJobId);
  elements.startButton.hidden = activeState || state.status === "paused";
  elements.startButtonHint.hidden = elements.startButton.hidden;
  elements.startButton.textContent = state.characters.some((character) => character.status === "pending")
    ? "캐릭터부터 생성 시작"
    : state.queueMode === "intro" ? "인트로·썸네일 생성 시작" : "장면 생성 시작";
  const startReason = startQueueDisabledReason({ hasPending, hasFailed, activeState });
  setDisabledReason(
    elements.startButton,
    elements.startButtonHint,
    startReason,
    elements.startButton.hidden ? null : elements.queueControlReason
  );
  if (elements.startButton.hidden) {
    elements.queueControlReason.hidden = true;
    elements.queueControlReason.textContent = "";
  }
  elements.pauseButton.hidden = !["running", "waiting", "pausing"].includes(state.status);
  elements.pauseButton.disabled = state.status === "pausing";
  elements.pauseButton.textContent = "대기열 중단";
  elements.resumeButton.hidden = state.status !== "paused" || hasFailed;
  elements.resumeButton.disabled = !hasPending || Boolean(state.activeJobId);
  elements.retryFailedButton.hidden = !hasFailed || Boolean(state.activeJobId);
  elements.retryFailedFooterButton.hidden = !hasFailed || Boolean(state.activeJobId);
  elements.retryFailedFooterButton.disabled = Boolean(state.activeJobId);
  elements.syncCharactersButton.disabled = activeState;
  elements.resetButton.disabled = !(state.jobs.length || state.characters.length) || Boolean(state.activeJobId);
  renderApplyQueueAvailability();
  const hasDownloadSequence = state.jobs.length > 0 || state.characters.length > 0;
  elements.downloadProjectButton.disabled = !hasDownloadSequence || activeState || downloadBusy;
  elements.downloadProjectButton.innerHTML = downloadBusy
    ? '<span aria-hidden="true">…</span><span class="download-button-label">ZIP 준비 중</span>'
    : '<span aria-hidden="true">⇩</span><span class="download-button-label">전체 다운로드</span>';

  renderJobs();
  renderCharacters();
  renderAssetMapping();
}

function renderAnalysis() {
  const hasPrompts = analysis.prompts.length > 0;
  const intro = inputMode === "intro";
  const introCount = analysis.prompts.filter((prompt) => prompt.sourceMode === "intro").length;
  const thumbnailCount = analysis.prompts.filter((prompt) => prompt.sourceMode === "thumbnail").length;
  const characterCount = intro ? knownCharacterKeys().length : analysis.characters?.length || 0;
  const taskCount = intro ? analysis.prompts.length : characterCount + analysis.prompts.length;
  elements.analysisSummary.hidden = !hasPrompts;
  elements.detectedJobCount.textContent = `${taskCount}개 작업`;
  elements.detectedCharacterCount.textContent = intro
    ? `- 기존 캐릭터 ${characterCount}명 /`
    : `- 캐릭터 ${characterCount}명 /`;
  elements.detectedImageCount.textContent = intro
    ? `인트로 ${introCount}장 · 썸네일 ${thumbnailCount}장`
    : `장면 ${analysis.prompts.length}장`;
  elements.analysisWarning.hidden = !analysis.warnings.length;
  elements.analysisWarning.textContent = analysis.warnings.join(" ");
  elements.applyQueueButton.textContent = intro ? "인트로·썸네일 작업 큐에 적용" : "분석 결과를 작업 큐에 적용";
  renderApplyQueueAvailability();
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
  let characterSyncMessage = "";
  if (inputMode === "intro") {
    try {
      const result = await send("ENSURE_CURRENT_PROJECT_CHARACTERS");
      state = result.state;
      const count = result.matchedKeys?.length || result.registeredKeys?.length || state.characters.length;
      characterSyncMessage = ` · 캐릭터 ${count}명 자동 동기화`;
    } catch (error) {
      characterSyncMessage = ` · 캐릭터 자동 동기화 실패: ${String(error?.message || error)}`;
    }
  }
  analyzeSource();
  renderState();
  const summary = inputMode === "intro"
    ? `인트로 ${analysis.prompts.filter((prompt) => prompt.sourceMode === "intro").length}개`
    : `캐릭터 ${analysis.characters?.length || 0}명, 장면 ${analysis.prompts.length}개`;
  showToast(`${file.name}에서 ${summary}를 찾았습니다.${characterSyncMessage}`);
}

async function applyQueue() {
  if (!analysis.prompts.length) return;
  await send("UPDATE_OPTIONS", { options: optionsFromControls() });
  state = await send("SET_QUEUE", {
    prompts: analysis.prompts,
    characters: analysis.characters || [],
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
  await send("UPDATE_OPTIONS", { options: optionsFromControls() });
  state = await send(type);
  renderState();
}

function optionsFromControls() {
  const seconds = Math.min(MAX_DELAY_MS / 1_000, Math.max(MIN_DELAY_MS / 1_000, Number(elements.delayRange.value || 60)));
  return {
    delayMs: seconds * 1_000,
    model: elements.modelSelect.value,
    aspectRatio: elements.aspectRatioSelect.value,
    imagesPerPrompt: Number(elements.imageCountSelect.value || 2),
    randomDelay: elements.randomDelayToggle.checked
  };
}

async function retryAndResume(type, payload = {}) {
  state = await send(type, payload);
  renderState();
  await startOrResume("RESUME_QUEUE");
}

async function checkFlow({ notify = true } = {}) {
  if (flowCheckInFlight) return null;
  flowCheckInFlight = true;
  elements.connectionLabel.textContent = "확인 중";
  try {
    const result = await send("CHECK_FLOW");
    setConnected(Boolean(result.connected), result.connected ? "Flow 연결됨" : "연결 안 됨");
    elements.openFlowButton.hidden = Boolean(result.connected);
    if (!notify) return result;
    if (!result.connected) showToast(result.error || "Flow 프로젝트 탭을 열어 주세요.");
    else if (result.project?.restoredMappingCount || result.project?.restoredCharacterCount) {
      const mappingCount = result.project.restoredMappingCount || 0;
      const mappingNote = mappingCount
        ? "Flow 목록 새로고침으로 실제 이미지도 확인하세요."
        : "저장된 장면 매핑은 없어 캐릭터만 복원했습니다. 기존 장면은 수동 매핑이 필요합니다.";
      showToast(`Flow 프로젝트와 연결되었습니다. 저장된 캐릭터 ${result.project.restoredCharacterCount || 0}명과 매핑 ${mappingCount}개를 불러왔습니다. ${mappingNote}`);
    } else if (result.project?.savedProfile) {
      const mappingCount = result.project.savedProfile.mappingCount || 0;
      showToast(mappingCount
        ? `Flow 프로젝트와 연결되었습니다. 저장된 캐릭터 ${result.project.savedProfile.characterCount}명과 매핑 ${mappingCount}개를 확인했습니다.`
        : `Flow 프로젝트와 연결되었습니다. 캐릭터 ${result.project.savedProfile.characterCount}명만 복원되었습니다. 이 프로젝트에는 저장된 장면 매핑이 없어 기존 장면은 자동 복원할 수 없습니다.`);
    }
    else showToast("Flow 프로젝트와 연결되었습니다. 캐릭터 작업은 이 프로젝트 ID에 자동 보관됩니다.");
    return result;
  } finally {
    flowCheckInFlight = false;
  }
}

async function clearPromptDrafts() {
  clearTimeout(sourceSaveTimer);
  sceneSource = "";
  introSource = "";
  thumbnailSource = "";
  introFileName = "";
  elements.fileInput.value = "";
  elements.promptSource.value = "";
  renderInputMode();
  analysis = inputMode === "intro"
    ? analyzeIntroAssets({ introText: "", thumbnailText: "", knownCharacterKeys: knownCharacterKeys() })
    : analyzePrompts("", { mode: "scene", knownCharacterKeys: knownCharacterKeys() });
  renderAnalysis();
  await chrome.storage.local.remove(PROMPT_DRAFT_KEYS);
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
  renderState();
  chrome.storage.local.set({ flowBatchInputMode: inputMode }).catch(() => {});
});
elements.introModeButton.addEventListener("click", () => {
  if (inputMode === "intro") return;
  inputMode = "intro";
  renderInputMode();
  analyzeSource();
  renderState();
  chrome.storage.local.set({ flowBatchInputMode: inputMode }).catch(() => {});
});
elements.fileInput.addEventListener("change", withUiError(async () => readFile(elements.fileInput.files?.[0])));
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
  await clearPromptDrafts();
  renderState();
  showToast("작업 큐를 초기화했습니다.");
}));
elements.openFlowButton.addEventListener("click", withUiError(async () => {
  await send("OPEN_FLOW");
  window.setTimeout(() => checkFlow({ notify: false }).catch(() => {}), 500);
}));
elements.checkFlowButton.addEventListener("click", withUiError(checkFlow));
elements.syncCharactersButton.addEventListener("click", withUiError(async () => {
  const result = await send("SYNC_FLOW_STATE");
  state = result.state;
  analyzeSource();
  renderState();
  showToast(`Flow에서 등록된 캐릭터 ${result.matchedKeys?.length || result.registeredKeys?.length || 0}명을 읽었습니다.`);
}));
elements.downloadProjectButton.addEventListener("click", withUiError(async () => {
  downloadBusy = true;
  elements.downloadProgress.hidden = false;
  elements.downloadProgress.classList.remove("error");
  elements.downloadProgressBar.style.width = "4%";
  elements.downloadStatus.textContent = "Flow 모든 미디어 카드에서 자산 ID와 원본 이미지를 수집하는 중";
  renderState();
  try {
    const result = await send("DOWNLOAD_PROJECT");
    const missing = [
      result.missingScenes?.length ? `장면 ${result.missingScenes.join(", ")}` : "",
      result.missingIntros?.length ? `인트로 ${result.missingIntros.join(", ")}` : "",
      result.missingThumbnails?.length ? "썸네일" : "",
      result.missingCharacters?.length ? `캐릭터 ${result.missingCharacters.join(", ")}` : ""
    ].filter(Boolean);
    elements.downloadProgressBar.style.width = "100%";
    const mappedCount = Number(result.mappedSceneCount ?? result.scannedSceneCount ?? 0);
    const totalMedia = result.removedCharacterMediaCount
      ? `전체 ${result.allMediaCount}장 → 매핑 ${mappedCount}장`
      : `카드 ${result.scannedSceneCount}장 · 매핑 ${mappedCount}장`;
    const extras = result.extraSceneCount ? ` · 추가 카드 ${result.extraSceneCount}장 제외` : "";
    const mappingWarnings = result.mappingWarnings?.length ? ` · 매핑 확인 ${result.mappingWarnings.length}건` : "";
    const types = [
      result.sceneCount ? `장면 ${result.sceneCount}장` : "",
      result.introCount ? `인트로 ${result.introCount}장` : "",
      result.thumbnailCount ? `썸네일 ${result.thumbnailCount}장` : "",
      result.characterCount ? `캐릭터 ${result.characterCount}장` : ""
    ].filter(Boolean).join(" · ");
    elements.downloadStatus.textContent = `${result.archiveFilename} · ${totalMedia} · ${types}${extras}${mappingWarnings}${missing.length ? ` · 미확인 ${missing.join(" / ")}` : ""}`;
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
elements.delayRange.addEventListener("input", () => {
  const seconds = Math.min(MAX_DELAY_MS / 1_000, Math.max(MIN_DELAY_MS / 1_000, Number(elements.delayRange.value || 60)));
  elements.delayValue.value = `${seconds}초`;
  elements.delayValue.textContent = `${seconds}초`;
  elements.delayValueLabel.textContent = elements.randomDelayToggle.checked ? "60~90초 사이 랜덤으로 대기합니다" : `${seconds}초`;
});
elements.delayRange.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: optionsFromControls() });
  renderState();
}));
elements.randomDelayToggle.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: optionsFromControls() });
  renderState();
}));
elements.modelSelect.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: { model: elements.modelSelect.value } });
  renderState();
  showToast(`${state.options.model} 모델로 변경했습니다. 다음 생성부터 Flow에도 적용됩니다.`);
}));
elements.aspectRatioSelect.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: { aspectRatio: elements.aspectRatioSelect.value } });
  renderState();
}));
elements.imageCountSelect.addEventListener("change", withUiError(async () => {
  state = await send("UPDATE_OPTIONS", { options: { imagesPerPrompt: Number(elements.imageCountSelect.value) } });
  renderState();
}));
async function copyPrompt(jobId) {
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job) throw new Error("복사할 프롬프트 작업을 찾지 못했습니다.");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(job.prompt);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = job.prompt;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("프롬프트를 클립보드에 복사하지 못했습니다.");
    textarea.remove();
  }
  showToast(`${job.title} 프롬프트를 복사했습니다.`);
}
elements.jobList.addEventListener("click", withUiError(async (event) => {
  const removeAssetButton = event.target.closest("[data-remove-job-asset]");
  if (removeAssetButton) {
    state = await send("UNMAP_ASSET_FROM_JOB", {
      assetId: removeAssetButton.dataset.assetKey,
      jobId: removeAssetButton.dataset.removeJobAsset
    });
    renderState();
    showToast("장면에서 이미지 연결을 해제했습니다.");
    return;
  }
  const copyButton = event.target.closest("[data-copy-prompt]");
  if (copyButton) {
    await copyPrompt(copyButton.dataset.copyPrompt);
    return;
  }
  const assetButton = event.target.closest("[data-open-asset]");
  if (assetButton) {
    if (Date.now() < suppressAssetOpenUntil) return;
    await send("OPEN_ASSET", { url: assetButton.dataset.openAsset });
    return;
  }
  const imageButton = event.target.closest("[data-open-image]");
  if (imageButton) {
    if (Date.now() < suppressAssetOpenUntil) return;
    await send("OPEN_IMAGE", { url: imageButton.dataset.openImage });
    return;
  }
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
function clearJobDropTargets() {
  elements.jobList.querySelectorAll(".job-item.drag-over").forEach((item) => item.classList.remove("drag-over"));
}
elements.jobList.addEventListener("dragstart", (event) => {
  const imageButton = event.target.closest("[data-drag-asset]");
  if (!imageButton || imageButton.draggable !== true) return;
  draggingAsset = {
    assetKey: imageButton.dataset.dragAsset,
    sourceJobId: imageButton.dataset.dragSource
  };
  imageButton.classList.add("dragging");
  event.dataTransfer?.setData("application/x-flow-asset", draggingAsset.assetKey);
  event.dataTransfer?.setData("text/plain", draggingAsset.assetKey);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});
elements.jobList.addEventListener("dragover", (event) => {
  const target = event.target.closest("[data-drop-job]");
  if (!draggingAsset || !target || target.dataset.dropJob === draggingAsset.sourceJobId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  clearJobDropTargets();
  target.classList.add("drag-over");
});
elements.jobList.addEventListener("dragleave", (event) => {
  const target = event.target.closest("[data-drop-job]");
  if (target && !target.contains(event.relatedTarget)) target.classList.remove("drag-over");
});
elements.jobList.addEventListener("dragend", (event) => {
  event.target.closest("[data-drag-asset]")?.classList.remove("dragging");
  draggingAsset = null;
  suppressAssetOpenUntil = Date.now() + 350;
  clearJobDropTargets();
});
elements.jobList.addEventListener("drop", withUiError(async (event) => {
  const target = event.target.closest("[data-drop-job]");
  const assetKey = draggingAsset?.assetKey || event.dataTransfer?.getData("application/x-flow-asset") || event.dataTransfer?.getData("text/plain");
  const sourceJobId = draggingAsset?.sourceJobId;
  if (!target || !assetKey || target.dataset.dropJob === sourceJobId) return;
  event.preventDefault();
  clearJobDropTargets();
  const destination = state.jobs.find((job) => job.id === target.dataset.dropJob);
  state = await send("MAP_ASSET_TO_JOB", { assetId: assetKey, jobId: target.dataset.dropJob });
  renderState();
  showToast(`이미지를 ${destination?.title || "선택한 장면"}으로 이동했습니다.`);
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
elements.scanAssetsButton.addEventListener("click", withUiError(async () => {
  const result = await send("SCAN_PROJECT_ASSETS");
  state = result.state;
  renderState();
  showToast(`Flow 이미지 ${result.assetCount}개를 읽었습니다.${result.removedMappings ? ` 삭제된 이미지 매핑 ${result.removedMappings}건을 해제했습니다.` : " 장면별로 매핑할 수 있습니다."}`);
}));
elements.fillFromAssetSelect.addEventListener("change", () => {
  mappingStartAssetKey = elements.fillFromAssetSelect.value;
});
elements.fillFromJobSelect.addEventListener("change", () => {
  mappingStartJobId = elements.fillFromJobSelect.value;
});
elements.fillAssetRangeButton.addEventListener("click", withUiError(async () => {
  const result = await send("REASSIGN_ASSETS_FROM_POSITION", {
    startAssetKey: mappingStartAssetKey,
    startJobId: mappingStartJobId
  });
  state = result.state;
  renderState();
  showToast(`선택한 시작점부터 ${result.mappedCount}개 이미지를 번호 순서대로 다시 매핑했습니다.`);
}));
elements.unassignedOnlyToggle.addEventListener("change", () => {
  showUnassignedOnly = elements.unassignedOnlyToggle.checked;
  renderState();
});
elements.assetMappingList.addEventListener("change", withUiError(async (event) => {
  const select = event.target.closest("[data-map-asset]");
  if (!select) return;
  const assetId = select.dataset.mapAsset;
  if (select.value) {
    state = await send("MAP_ASSET_TO_JOB", { assetId, jobId: select.value });
    showToast("이미지를 선택한 장면에 고정 매핑했습니다.");
  } else {
    const current = (state.jobs || []).find((job) => (job.mappedAssetIds || []).includes(assetId));
    state = await send("UNMAP_ASSET_FROM_JOB", { assetId, jobId: current?.id || "" });
    showToast("이미지 매핑을 해제했습니다.");
  }
  renderState();
}));
elements.assetMappingList.addEventListener("click", withUiError(async (event) => {
  const removeButton = event.target.closest("[data-remove-job-asset]");
  if (!removeButton) return;
  state = await send("UNMAP_ASSET_FROM_JOB", {
    assetId: removeButton.dataset.assetKey,
    jobId: removeButton.dataset.removeJobAsset
  });
  renderState();
  showToast("삭제되었거나 잘못된 이미지 연결을 해제했습니다.");
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
  await checkFlow({ notify: false }).catch(() => {});
}

withUiError(initialize)();
