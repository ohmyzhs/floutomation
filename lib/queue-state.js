export const STATE_KEY = "flowBatchState";
export const QUEUE_ALARM = "flow-batch-next-job";
export const MIN_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 120_000;
export const RANDOM_DELAY_MAX_MS = 90_000;
export const MAX_AUTOMATIC_RETRIES = 1;
export const MAX_TRACKED_RESULT_ASSETS = 4;
export const AUTO_RETRY_BASE_MS = 15_000;
export const AUTO_RETRY_MAX_MS = 60_000;
export const SUPPORTED_MODELS = Object.freeze([
  "Nano Banana Pro",
  "Nano Banana 2",
  "Nano Banana 2 Lite"
]);
export const SUPPORTED_ASPECT_RATIOS = Object.freeze([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16"
]);

export const DEFAULT_OPTIONS = Object.freeze({
  model: "Nano Banana 2",
  aspectRatio: "16:9",
  imagesPerPrompt: 2,
  delayMs: MIN_DELAY_MS,
  randomDelay: false,
  generationTimeoutMs: 10 * 60_000
});

export function createInitialState() {
  return {
    schemaVersion: 12,
    revision: 0,
    status: "idle",
    phase: "idle",
    queueMode: "scene",
    executionMode: "automatic",
    characters: [],
    jobs: [],
    activeJobId: null,
    activeTaskType: null,
    tabId: null,
    flowProjectId: "",
    flowProjectTitle: "",
    nextRunAt: null,
    pauseRequested: false,
    manualPause: false,
    flowConnected: false,
    flowSurface: null,
    lastFlowSyncAt: null,
    lastFlowRegisteredKeys: [],
    lastFlowSceneImageCount: null,
    lastFlowImageSyncAt: null,
    assetCatalog: [],
    lastError: null,
    updatedAt: Date.now(),
    options: { ...DEFAULT_OPTIONS }
  };
}

export function normalizeOptions(value = {}) {
  const requestedDelay = Number(value.delayMs);
  const requestedTimeout = Number(value.generationTimeoutMs);
  const requestedImages = Number(value.imagesPerPrompt);
  const requestedModel = SUPPORTED_MODELS.includes(String(value.model || ""))
    ? String(value.model)
    : DEFAULT_OPTIONS.model;
  const requestedAspectRatio = SUPPORTED_ASPECT_RATIOS.includes(String(value.aspectRatio || ""))
    ? String(value.aspectRatio)
    : DEFAULT_OPTIONS.aspectRatio;
  return {
    ...DEFAULT_OPTIONS,
    ...value,
    model: requestedModel,
    aspectRatio: requestedAspectRatio,
    imagesPerPrompt: Number.isFinite(requestedImages)
      ? Math.min(4, Math.max(1, Math.round(requestedImages)))
      : DEFAULT_OPTIONS.imagesPerPrompt,
    delayMs: Number.isFinite(requestedDelay)
      ? Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(requestedDelay / 1_000) * 1_000))
      : MIN_DELAY_MS,
    randomDelay: Boolean(value.randomDelay),
    generationTimeoutMs: Math.max(2 * 60_000, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_OPTIONS.generationTimeoutMs)
  };
}

export function nextTaskDelayMs(options = {}, random = Math.random) {
  const normalized = normalizeOptions(options);
  if (!normalized.randomDelay) return normalized.delayMs;
  const sample = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  return (60 + Math.floor(sample * 31)) * 1_000;
}

export function isBlockingFlowError(value) {
  return /(?:로봇이\s*아님|사람인지\s*확인|captcha|verify (?:that )?you(?:'re| are) human|로그인|sign\s*in|계정|account|크레딧.{0,12}부족|not enough credits|quota|limit reached|한도|devtools|디버거|debugger)/i
    .test(String(value || ""));
}

export function automaticRetryDelayMs(attempt) {
  const safeAttempt = Math.max(1, Number(attempt || 1));
  return Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * (2 ** Math.min(2, safeAttempt - 1)));
}

export function prepareSceneAutomaticRetry(job, error, now = Date.now()) {
  if (!job || typeof job !== "object") return null;
  if (!canAutomaticallyRetry(job)) return null;
  job.autoRetryCount = Number(job.autoRetryCount || 0) + 1;
  const delayMs = automaticRetryDelayMs(job.autoRetryCount);
  const submitted = Boolean(job.requestSubmittedAt);
  job.status = "pending";
  job.stage = `자동 재시도 ${job.autoRetryCount}회 · ${Math.ceil(delayMs / 1000)}초 후${submitted ? " · 기존 생성 추적" : ""}`;
  job.progress = submitted ? Math.max(24, Number(job.progress || 0)) : 0;
  job.resultAssets = [];
  job.generationPercentages = [];
  job.error = null;
  job.lastTransientError = String(error || "Flow 작업을 다시 시도합니다.");
  job.lastRetryAt = Number(now);
  return { delayMs, submitted };
}

export function canAutomaticallyRetry(job) {
  return Number(job?.autoRetryCount || 0) < MAX_AUTOMATIC_RETRIES;
}

export function markSceneFailedAndContinue(state, jobId, error, now = Date.now()) {
  const job = (state?.jobs || []).find((entry) => entry.id === jobId);
  if (!job) return false;
  job.status = "failed";
  job.stage = "실패 · 다음 작업으로 진행";
  job.progress = Math.min(95, Number(job.progress || 0));
  job.completedAt = null;
  job.imagesGenerated = 0;
  job.resultAssets = [];
  job.generationPercentages = [];
  job.baselineMedia = [];
  job.baselineCapturedAt = null;
  job.baselineFailureCount = null;
  job.requestSubmittedAt = null;
  job.recoveryAttempts = 0;
  job.lastRecoveryAt = null;
  job.lastTransientError = null;
  job.error = String(error || "Flow 이미지 생성에 실패했습니다.");

  if (state.activeJobId === jobId) {
    state.activeJobId = null;
    state.activeTaskType = null;
  }
  state.pauseRequested = false;
  state.manualPause = false;
  state.lastError = null;
  if (hasPendingTasks(state)) {
    state.status = "waiting";
    state.nextRunAt = Number(now) + nextTaskDelayMs(state.options);
  } else {
    state.status = "completed";
    state.phase = "completed";
    state.nextRunAt = null;
  }
  return true;
}

export function prepareSceneNavigationRecovery(job, now = Date.now()) {
  if (!job || typeof job !== "object") return null;
  const submitted = Boolean(job.requestSubmittedAt);
  job.status = submitted ? "generating" : "configuring";
  job.stage = "Flow 화면 재연결 · 현재 생성 상태 확인 중";
  job.progress = Math.max(submitted ? 28 : 18, Number(job.progress || 0));
  job.recoveryAttempts = Number(job.recoveryAttempts || 0) + 1;
  job.lastRecoveryAt = Number(now);
  job.error = null;
  job.lastHeartbeatAt = Number(now);
  return submitted ? "monitor" : "inspect";
}

export function hydrateState(value) {
  const initial = createInitialState();
  if (!value || typeof value !== "object") return initial;
  const jobs = Array.isArray(value.jobs)
    ? value.jobs.map((job) => ({
      ...job,
      resultAssets: Array.isArray(job.resultAssets) ? job.resultAssets.slice(0, MAX_TRACKED_RESULT_ASSETS) : [],
      resultAssetOverflowCount: Math.max(
        Number(job.resultAssetOverflowCount || 0),
        Math.max(0, (Array.isArray(job.resultAssets) ? job.resultAssets.length : 0) - MAX_TRACKED_RESULT_ASSETS)
      ),
      mappedAssetIds: Array.isArray(job.mappedAssetIds) ? [...new Set(job.mappedAssetIds.map(String).filter(Boolean))] : []
    }))
    : [];
  const characters = Array.isArray(value.characters)
    ? value.characters.map((character) => ({ ...character, resultAssets: Array.isArray(character.resultAssets) ? character.resultAssets : [] }))
    : [];
  return {
    ...initial,
    ...value,
    characters,
    jobs,
    activeTaskType: value.activeTaskType || (value.activeJobId ? "scene" : null),
    queueMode: value.queueMode === "intro" ? "intro" : "scene",
    executionMode: value.executionMode === "manual" ? "manual" : "automatic",
    flowProjectId: String(value.flowProjectId || "").trim(),
    flowProjectTitle: String(value.flowProjectTitle || "").trim(),
    phase: value.phase || (characters.length ? "characters" : jobs.length ? "scenes" : "idle"),
    options: normalizeOptions(value.options),
    assetCatalog: Array.isArray(value.assetCatalog) ? value.assetCatalog : []
  };
}

export function createJobs(prompts) {
  const now = Date.now();
  return prompts.map((entry, index) => ({
    id: `job-${now}-${index + 1}`,
    index,
    title: String(entry.title || `이미지 ${index + 1}`),
    prompt: String(entry.prompt || "").trim(),
    number: Number(entry.number || index + 1),
    sourceNumber: Number(entry.sourceNumber || entry.number || index + 1),
    characterRefs: Array.isArray(entry.characterRefs) ? entry.characterRefs.map(String) : [],
    script: String(entry.script || "").trim(),
    sourceMode: String(entry.sourceMode || "scene").trim() || "scene",
    status: "pending",
    progress: 0,
    stage: "대기 중",
    attempts: 0,
    startedAt: null,
    completedAt: null,
    imagesGenerated: 0,
    resultAssets: [],
    resultAssetOverflowCount: 0,
    mappedAssetIds: [],
    supplementing: false,
    supplementTargetTotal: null,
    supplementBaseAssetCount: null,
    supplementRequestedImages: null,
    generationPercentages: [],
    generationMode: "direct",
    baselineMedia: [],
    baselineCapturedAt: null,
    baselineFailureCount: null,
    requestSubmittedAt: null,
    recoveryAttempts: 0,
    lastRecoveryAt: null,
    autoRetryCount: 0,
    lastRetryAt: null,
    lastTransientError: null,
    error: null
  })).filter((job) => job.prompt);
}

export function sceneSupplementPlan(job, defaultTargetTotal = 3) {
  if (!job || job.status !== "completed" || String(job.sourceMode || "scene") !== "scene" || !String(job.prompt || "").trim()) {
    return null;
  }
  const identities = new Set((Array.isArray(job.resultAssets) ? job.resultAssets : [])
    .map((asset) => asset?.assetId || asset?.detailUrl || asset?.url)
    .filter(Boolean));
  const currentImages = identities.size;
  const rememberedTarget = Math.max(0, Number(job.supplementTargetTotal || 0));
  if (!rememberedTarget && currentImages !== 1) return null;
  const targetTotal = Math.max(1, rememberedTarget || Number(defaultTargetTotal || 3));
  if (currentImages < 1 || currentImages >= targetTotal) return null;
  return {
    currentImages,
    targetTotal,
    requestedImages: Math.min(2, targetTotal - currentImages)
  };
}

export function createCharacters(characters, { alreadyRegistered = false } = {}) {
  const now = Date.now();
  return characters.map((entry, index) => ({
    id: `character-${now}-${index + 1}`,
    index,
    key: String(entry.key || "").trim(),
    displayName: String(entry.displayName || entry.key || `캐릭터 ${index + 1}`).trim(),
    description: String(entry.description || "").trim(),
    chapterRange: String(entry.chapterRange || "").trim(),
    prompt: String(entry.prompt || "").trim(),
    referenceCount: Math.max(0, Number(entry.referenceCount || 0)),
    status: alreadyRegistered ? "completed" : "pending",
    progress: alreadyRegistered ? 100 : 0,
    stage: alreadyRegistered ? "기존 Flow 캐릭터 사용" : "생성 대기",
    attempts: 0,
    startedAt: null,
    completedAt: alreadyRegistered ? now : null,
    referenceImages: 0,
    resultAssets: [],
    error: null
  })).filter((character) => character.key && character.prompt);
}

export function summarizeState(state) {
  const jobs = state.jobs || [];
  const characters = state.characters || [];
  const counts = jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  const completed = counts.completed || 0;
  const recordedGeneratedImages = jobs.reduce((sum, job) => sum + Math.max(
    Number(job.imagesGenerated || 0),
    Array.isArray(job.resultAssets) ? job.resultAssets.length : 0
  ), 0);
  const scannedSceneImageCount = state.lastFlowSceneImageCount == null
    ? Number.NaN
    : Number(state.lastFlowSceneImageCount);
  const expectedSceneImageCount = jobs.length * Math.max(1, Number(state.options?.imagesPerPrompt || 2));
  const generatedImages = Number.isInteger(scannedSceneImageCount) && scannedSceneImageCount >= 0
    ? Math.min(expectedSceneImageCount, scannedSceneImageCount)
    : recordedGeneratedImages;
  const charactersTotal = characters.length;
  const charactersCompleted = characters.filter((character) => character.status === "completed").length;
  const totalTasks = jobs.length + charactersTotal;
  const completedTasks = completed + charactersCompleted;
  return {
    total: jobs.length,
    completed,
    failed: counts.failed || 0,
    pending: (counts.pending || 0) + (counts.configuring || 0) + (counts.generating || 0),
    generatedImages,
    percent: jobs.length ? Math.round((completed / jobs.length) * 100) : 0,
    charactersTotal,
    charactersCompleted,
    charactersFailed: characters.filter((character) => character.status === "failed").length,
    charactersReview: characters.filter((character) => character.status === "review").length,
    totalTasks,
    completedTasks,
    remainingTasks: Math.max(0, totalTasks - completedTasks)
  };
}

export function hasPendingJobs(state) {
  return state.jobs.some((job) => job.status === "pending");
}

export function findNextJob(state) {
  return state.jobs.find((job) => job.status === "pending") || null;
}

export function hasPendingTasks(state) {
  return (state.characters || []).some((character) => character.status === "pending") || hasPendingJobs(state);
}

export function findNextTask(state) {
  const character = (state.characters || []).find((entry) => entry.status === "pending");
  if (character) return { type: "character", item: character };

  const charactersReady = (state.characters || []).every((entry) => entry.status === "completed");
  if (!charactersReady) return null;
  const job = findNextJob(state);
  return job ? { type: "scene", item: job } : null;
}

export function retryFailedTasks(state, { characterId = null, jobId = null } = {}) {
  let resetCount = 0;
  const reset = (task) => {
    if (task.status !== "failed") return;
    task.status = "pending";
    task.stage = "재시도 대기";
    task.progress = 0;
    task.startedAt = null;
    task.completedAt = null;
    task.error = null;
    if ("generationMode" in task) {
      task.resultAssets = [];
      task.generationMode = "direct";
      task.generationPercentages = [];
      task.baselineMedia = [];
      task.baselineCapturedAt = null;
      task.baselineFailureCount = null;
      task.requestSubmittedAt = null;
      task.recoveryAttempts = 0;
      task.lastRecoveryAt = null;
      task.autoRetryCount = 0;
      task.lastRetryAt = null;
      task.lastTransientError = null;
    }
    resetCount += 1;
  };

  for (const character of state.characters || []) {
    if (!characterId || character.id === characterId) reset(character);
  }
  for (const job of state.jobs || []) {
    if (!jobId || job.id === jobId) reset(job);
  }

  if (resetCount > 0) {
    state.status = "paused";
    state.phase = (state.characters || []).some((character) => character.status === "pending") ? "characters" : "scenes";
    state.activeJobId = null;
    state.activeTaskType = null;
    state.nextRunAt = null;
    state.pauseRequested = false;
    state.lastError = null;
  }
  return resetCount;
}

export function rollbackUnverifiedCompletedScenes(state, beforeJobId = null, reason = "Flow 실패 결과 감지") {
  const jobs = state.jobs || [];
  const expectedImages = Math.max(1, Number(state.options?.imagesPerPrompt || DEFAULT_OPTIONS.imagesPerPrompt));
  const boundary = beforeJobId ? jobs.findIndex((job) => job.id === beforeJobId) : jobs.length;
  if (boundary < 0) return [];

  const rolledBack = [];
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    if (job.status !== "completed") break;
    if (Array.isArray(job.resultAssets) && job.resultAssets.length >= expectedImages) break;

    job.status = "pending";
    job.stage = "결과 이미지 없음 · 재생성 대기";
    job.progress = 0;
    job.completedAt = null;
    job.imagesGenerated = 0;
    job.resultAssets = [];
    job.generationPercentages = [];
    job.baselineMedia = [];
    job.baselineCapturedAt = null;
    job.baselineFailureCount = null;
    job.requestSubmittedAt = null;
    job.recoveryAttempts = 0;
    job.lastRecoveryAt = null;
    job.autoRetryCount = 0;
    job.lastRetryAt = null;
    job.lastTransientError = String(reason || "Flow 실패 결과 감지");
    job.error = null;
    rolledBack.unshift(job.id);
  }
  return rolledBack;
}

export function setCharacterReady(state, characterId, ready, stage = null) {
  const character = (state.characters || []).find((entry) => entry.id === characterId);
  if (!character) return false;

  if (ready) {
    character.status = "completed";
    character.stage = stage || "사용자 지정: Flow 등록됨";
    character.progress = 100;
    character.completedAt = Date.now();
    character.referenceImages = Math.max(1, Number(character.referenceImages || 0));
    character.error = null;
  } else {
    character.status = "pending";
    character.stage = stage || "사용자 지정: 생성 대기";
    character.progress = 0;
    character.startedAt = null;
    character.completedAt = null;
    character.referenceImages = 0;
    character.resultAssets = [];
    character.error = null;
  }
  return true;
}

export function setJobReady(state, jobId, ready, stage = null) {
  const job = (state.jobs || []).find((entry) => entry.id === jobId);
  if (!job) return false;

  if (ready) {
    job.status = "completed";
    job.stage = stage || "사용자 지정: 생성 건너뜀";
    job.progress = 100;
    job.completedAt = Date.now();
    job.error = null;
  } else {
    job.status = "pending";
    job.stage = stage || "사용자 지정: 생성 대기";
    job.progress = 0;
    job.startedAt = null;
    job.completedAt = null;
    job.imagesGenerated = 0;
    job.resultAssets = [];
    job.supplementing = false;
    job.supplementTargetTotal = null;
    job.supplementBaseAssetCount = null;
    job.supplementRequestedImages = null;
    job.generationPercentages = [];
    job.generationMode = "direct";
    job.baselineMedia = [];
    job.baselineCapturedAt = null;
    job.baselineFailureCount = null;
    job.requestSubmittedAt = null;
    job.recoveryAttempts = 0;
    job.lastRecoveryAt = null;
    job.autoRetryCount = 0;
    job.lastRetryAt = null;
    job.lastTransientError = null;
    job.error = null;
  }
  return true;
}

export function applyRegisteredCharacterKeys(state, keys) {
  const registered = new Set((keys || []).map((key) => String(key).trim().toLowerCase()).filter(Boolean));
  const matched = [];
  for (const character of state.characters || []) {
    if (!registered.has(String(character.key || "").trim().toLowerCase())) continue;
    setCharacterReady(state, character.id, true, "Flow 동기화: 등록 확인");
    matched.push(character.key);
  }
  return matched;
}

export function carryForwardCompletedTasks(nextState, previousState) {
  const previousCharacters = new Map(
    (previousState.characters || [])
      .filter((character) => character.status === "completed")
      .map((character) => [String(character.key || "").trim().toLowerCase(), character])
  );
  for (const character of nextState.characters || []) {
    const previous = previousCharacters.get(String(character.key || "").trim().toLowerCase());
    if (!previous) continue;
    setCharacterReady(nextState, character.id, true, previous.stage || "이전 큐 완료 상태 유지");
    character.referenceImages = Math.max(1, Number(previous.referenceImages || 1));
    character.resultAssets = Array.isArray(previous.resultAssets) ? previous.resultAssets.map((asset) => ({ ...asset })) : [];
  }

  const previousJobs = new Map(
    (previousState.jobs || [])
      .filter((job) => job.status === "completed")
      .map((job) => [`${String(job.sourceMode || "scene")}\u0000${Number(job.number || 0)}\u0000${String(job.prompt || "").trim()}`, job])
  );
  for (const job of nextState.jobs || []) {
    const previous = previousJobs.get(`${String(job.sourceMode || "scene")}\u0000${Number(job.number || 0)}\u0000${String(job.prompt || "").trim()}`);
    if (!previous) continue;
    job.status = "completed";
    job.stage = previous.stage || "이전 큐 완료 상태 유지";
    job.progress = 100;
    job.completedAt = previous.completedAt || Date.now();
    job.imagesGenerated = Math.max(0, Number(previous.imagesGenerated || 0));
    job.resultAssets = Array.isArray(previous.resultAssets) ? previous.resultAssets.map((asset) => ({ ...asset })) : [];
    job.resultAssetOverflowCount = Math.max(0, Number(previous.resultAssetOverflowCount || 0));
    job.mappedAssetIds = Array.isArray(previous.mappedAssetIds) ? [...new Set(previous.mappedAssetIds.map(String).filter(Boolean))] : [];
    job.error = null;
  }
}
