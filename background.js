import {
  QUEUE_ALARM,
  STATE_KEY,
  applyRegisteredCharacterKeys,
  carryForwardCompletedTasks,
  canAutomaticallyRetry,
  createCharacters,
  createInitialState,
  createJobs,
  findNextTask,
  hasPendingTasks,
  markSceneFailedAndContinue,
  MAX_AUTOMATIC_RETRIES,
  MAX_TRACKED_RESULT_ASSETS,
  hydrateState,
  isBlockingFlowError,
  normalizeOptions,
  nextTaskDelayMs,
  prepareSceneAutomaticRetry,
  prepareSceneNavigationRecovery,
  rollbackUnverifiedCompletedScenes,
  retryFailedTasks,
  sceneSupplementPlan,
  setCharacterReady,
  setJobReady
} from "./lib/queue-state.js";
import {
  buildDownloadManifest,
  uniqueAssets
} from "./lib/download-manifest.js";
import { assetAliases, buildAssetSuffixAssignments } from "./lib/asset-mapping.js";
import { requireArchiveResult } from "./lib/archive-result.js";
import {
  PROJECT_HISTORY_KEY,
  buildProjectCharacterProfile,
  characterDetailFromFlowUrl,
  findProjectCharacterProfile,
  FLOW_TAB_URL_PATTERNS,
  isFlowUrl,
  normalizeProjectHistory,
  projectIdFromFlowUrl,
  projectTitleFromTabTitle,
  upsertProjectCharacterProfile
} from "./lib/project-history.js";

let stateMutation = Promise.resolve();
let projectHistoryMutation = Promise.resolve();
let launchInProgress = false;
let downloadInProgress = false;

function shouldKeepDisplayAwake(state) {
  return downloadInProgress
    || Boolean(state?.activeJobId)
    || ["running", "waiting", "pausing"].includes(String(state?.status || ""));
}

function syncPowerState(state) {
  if (shouldKeepDisplayAwake(state)) {
    chrome.power.requestKeepAwake("display");
  } else {
    chrome.power.releaseKeepAwake();
  }
}

async function readState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return hydrateState(stored[STATE_KEY]);
}

function broadcastState(state) {
  chrome.runtime.sendMessage({ type: "STATE_UPDATED", state }).catch(() => {});
}

function updateState(mutator) {
  const operation = stateMutation.then(async () => {
    const state = await readState();
    await mutator(state);
    state.revision = Number(state.revision || 0) + 1;
    state.updatedAt = Date.now();
    await chrome.storage.local.set({ [STATE_KEY]: state });
    syncPowerState(state);
    broadcastState(state);
    return state;
  });
  stateMutation = operation.catch(() => {});
  return operation;
}

function isFlowAssetUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return isFlowUrl(parsed.href)
      && /\/project\/[^/?#]+\/edit\/[^/?#]+$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function reconcileMappedAssets(state, catalog) {
  const available = new Set((catalog || []).flatMap((asset) => [asset?.assetId, asset?.detailUrl, asset?.url]).filter(Boolean));
  let removed = 0;
  for (const job of state.jobs || []) {
    const before = Array.isArray(job.mappedAssetIds) ? job.mappedAssetIds : [];
    job.mappedAssetIds = before.filter((id) => available.has(String(id)));
    removed += before.length - job.mappedAssetIds.length;
    if (Array.isArray(job.resultAssets) && available.size) {
      job.resultAssets = job.resultAssets.filter((asset) => [asset?.assetId, asset?.detailUrl, asset?.url].some((key) => key && available.has(key)));
    }
  }
  return removed;
}

function isTrackedImageUrl(state, url) {
  const target = String(url || "").trim();
  if (!/^https:\/\//i.test(target)) return false;
  const assets = [
    ...(state.assetCatalog || []),
    ...(state.jobs || []).flatMap((job) => job.resultAssets || []),
    ...(state.characters || []).flatMap((character) => character.resultAssets || [])
  ];
  return assets.some((asset) => asset.url === target || asset.detailUrl === target);
}

function flowProjectFromTab(tab) {
  const projectId = projectIdFromFlowUrl(tab?.url);
  return projectId ? {
    tab,
    projectId,
    projectTitle: projectTitleFromTabTitle(tab?.title)
  } : null;
}

async function findActiveFlowTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTabs.find((tab) => isFlowUrl(tab.url)) || null;
}

async function findCurrentFlowProject(preferredTabId, { preferActive = false } = {}) {
  const tab = preferActive
    ? await findActiveFlowTab() || await findFlowTab(preferredTabId)
    : await findFlowTab(preferredTabId);
  return flowProjectFromTab(tab);
}

function projectProfileSummary(profile) {
  if (!profile) return null;
  return {
    projectId: profile.projectId,
    projectTitle: profile.projectTitle,
    characterCount: profile.characters.length,
    registeredCount: profile.registeredKeys.length,
    mappingCount: Array.isArray(profile.mappingJobs) ? profile.mappingJobs.length : 0,
    updatedAt: profile.updatedAt
  };
}

async function readProjectHistory() {
  const stored = await chrome.storage.local.get(PROJECT_HISTORY_KEY);
  return normalizeProjectHistory(stored[PROJECT_HISTORY_KEY]);
}

function archiveProjectCharacters(state) {
  if (!state?.flowProjectId || !Array.isArray(state.characters) || !state.characters.length) {
    return Promise.resolve(null);
  }
  const profile = buildProjectCharacterProfile({
    projectId: state.flowProjectId,
    projectTitle: state.flowProjectTitle,
    characters: state.characters,
    registeredKeys: state.lastFlowRegisteredKeys
  });
  const operation = projectHistoryMutation.then(async () => {
    const history = await readProjectHistory();
    const next = upsertProjectCharacterProfile(history, profile);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: next });
    return findProjectCharacterProfile(next, profile.projectId);
  });
  projectHistoryMutation = operation.catch(() => {});
  return operation;
}

function mappingSlotKey(job) {
  const sourceMode = String(job?.sourceMode || "scene").trim() || "scene";
  const sourceNumber = Math.max(1, Number(job?.sourceNumber || job?.number || 1));
  return `${sourceMode}:${sourceNumber}`;
}

function projectMappingSnapshot(state) {
  const catalog = Array.isArray(state?.assetCatalog) ? state.assetCatalog : [];
  return (state?.jobs || []).flatMap((job) => {
    const mappedIds = [...new Set((job.mappedAssetIds || []).map(String).filter(Boolean))];
    const mappedAssets = mappedIds
      .map((id) => catalog.find((asset) => [asset?.assetId, asset?.detailUrl, asset?.url].includes(id)))
      .filter(Boolean);
    const assets = uniqueAssets([...(job.resultAssets || []), ...mappedAssets]);
    const title = String(job.title || "");
    const characterRefs = job.characterRefs || [];
    // Snapshot the scene roster too, so reconnecting to a project restores its
    // scenes and character bindings even before any image has been generated.
    if (!assets.length && !mappedIds.length && !title && !characterRefs.length) return [];
    return [{
      sourceMode: job.sourceMode || "scene",
      sourceNumber: job.sourceNumber || job.number,
      number: job.number || job.sourceNumber,
      title,
      characterRefs,
      imagesGenerated: Math.max(Number(job.imagesGenerated || 0), assets.length),
      assets,
      mappedAssetIds: mappedIds
    }];
  });
}

function restoreProjectMappings(jobs, profile) {
  const savedBySlot = new Map((profile?.mappingJobs || []).map((job) => [mappingSlotKey(job), job]));
  let restored = 0;
  for (const job of jobs || []) {
    const saved = savedBySlot.get(mappingSlotKey(job));
    if (!saved) continue;
    const assets = uniqueAssets([...(job.resultAssets || []), ...(saved.assets || [])]);
    const mappedIds = [...new Set([...(job.mappedAssetIds || []), ...(saved.mappedAssetIds || [])].map(String).filter(Boolean))];
    if (!assets.length && !mappedIds.length) continue;
    job.resultAssets = assets.slice(0, MAX_TRACKED_RESULT_ASSETS);
    job.resultAssetOverflowCount = Math.max(0, assets.length - MAX_TRACKED_RESULT_ASSETS);
    job.mappedAssetIds = mappedIds;
    job.imagesGenerated = Math.max(Number(job.imagesGenerated || 0), Number(saved.imagesGenerated || 0), assets.length);
    job.status = "completed";
    job.stage = "저장된 프로젝트 매핑 복원";
    job.progress = 100;
    job.completedAt = job.completedAt || Date.now();
    job.error = null;
    restored += 1;
  }
  return restored;
}

function createRestoredMappingJobs(profile) {
  const prompts = (profile?.mappingJobs || []).map((saved, index) => ({
    number: Math.max(1, Number(saved.sourceNumber || saved.number || index + 1)),
    sourceNumber: Math.max(1, Number(saved.sourceNumber || saved.number || index + 1)),
    sourceMode: saved.sourceMode || "scene",
    title: saved.title || `장면 ${String(saved.sourceNumber || saved.number || index + 1).padStart(3, "0")}`,
    prompt: "",
    characterRefs: saved.characterRefs || []
  }));
  const jobs = createJobs(prompts).map((job, index) => ({ ...job, index }));
  restoreProjectMappings(jobs, profile);
  return jobs;
}

function archiveProjectMappings(state) {
  if (!state?.flowProjectId) return Promise.resolve(null);
  const snapshot = projectMappingSnapshot(state);
  const currentSlots = new Set((state.jobs || []).map(mappingSlotKey));
  const operation = projectHistoryMutation.then(async () => {
    const history = await readProjectHistory();
    const previous = findProjectCharacterProfile(history, state.flowProjectId);
    // An intro-only queue must not erase the scene mappings previously saved
    // for this project. Replace records only for slots that are actually in
    // the current queue; an empty current slot intentionally clears its map.
    const mappingJobs = [
      ...(previous?.mappingJobs || []).filter((job) => !currentSlots.has(mappingSlotKey(job))),
      ...snapshot
    ];
    const profile = buildProjectCharacterProfile({
      projectId: state.flowProjectId,
      projectTitle: state.flowProjectTitle,
      characters: state.characters,
      registeredKeys: state.lastFlowRegisteredKeys,
      mappingJobs
    });
    const next = upsertProjectCharacterProfile(history, profile);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: next });
    return findProjectCharacterProfile(next, profile.projectId);
  });
  projectHistoryMutation = operation.catch(() => {});
  return operation;
}

async function findFlowTab(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (isFlowUrl(preferred.url)) return preferred;
    } catch {
      // The stored tab may have been closed.
    }
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeFlow = activeTabs.find((tab) => isFlowUrl(tab.url));
  if (activeFlow) return activeFlow;

  const flowTabs = await chrome.tabs.query({ url: FLOW_TAB_URL_PATTERNS });
  return flowTabs
    .filter((tab) => isFlowUrl(tab.url))
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error));
    if (!noReceiver) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function dispatchTextFallback(target, text) {
  for (const character of Array.from(text)) {
    if (character === "\n") {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });
      continue;
    }
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "char",
      key: character,
      text: character,
      unmodifiedText: character
    });
  }
}

async function withFlowDebugger(tabId, operation) {
  if (!Number.isInteger(tabId)) throw new Error("Flow 탭을 확인할 수 없습니다.");
  const tab = await chrome.tabs.get(tabId);
  if (!isFlowUrl(tab.url)) throw new Error("신뢰 입력은 Google Flow 탭에서만 사용할 수 있습니다.");

  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    return await operation(target);
  } catch (error) {
    const message = String(error?.message || error);
    if (/another debugger|already attached|debugger is already/i.test(message)) {
      throw new Error("Flow 탭에 DevTools 또는 다른 디버거가 연결되어 있습니다. 해당 창을 닫은 뒤 재시도해 주세요.");
    }
    throw new Error(`Flow 실제 조작 전달에 실패했습니다: ${message}`);
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function flowSelectAllModifier() {
  const platform = await chrome.runtime.getPlatformInfo();
  // Chrome DevTools Protocol modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
  // Flow runs on macOS and Windows/Linux, so never hard-code Cmd for all hosts.
  return platform?.os === "mac" ? 4 : 2;
}

async function insertTrustedText(tabId, text, { clear = false } = {}) {
  if (typeof text !== "string" || text.length > 50_000) throw new Error("입력할 프롬프트가 올바르지 않거나 너무 깁니다.");
  return withFlowDebugger(tabId, async (target) => {
    if (clear) {
      const selectAllModifier = await flowSelectAllModifier();
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "a",
        code: "KeyA",
        modifiers: selectAllModifier,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        commands: ["selectAll"]
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: selectAllModifier,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        commands: ["deleteBackward"]
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8
      });
    }

    if (text) {
      try {
        await chrome.debugger.sendCommand(target, "Input.insertText", { text });
      } catch {
        await dispatchTextFallback(target, text);
      }
    }
    return { inserted: text.length, cleared: Boolean(clear) };
  });
}

async function pressTrustedKey(tabId, key) {
  if (!["@", "Enter", "Escape"].includes(key)) throw new Error("허용되지 않은 Flow 특수 키 입력입니다.");
  return withFlowDebugger(tabId, async (target) => {
    if (key === "Enter" || key === "Escape") {
      const keyCode = key === "Enter" ? 13 : 27;
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode
      });
      return { pressed: key };
    }
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: 8,
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 56,
      location: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "@",
      code: "Digit2",
      modifiers: 8,
      text: "@",
      unmodifiedText: "2",
      windowsVirtualKeyCode: 50,
      nativeVirtualKeyCode: 19
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "@",
      code: "Digit2",
      modifiers: 8,
      windowsVirtualKeyCode: 50,
      nativeVirtualKeyCode: 19
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: 0,
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 56,
      location: 1
    });
    return { pressed: key };
  });
}

async function clickTrustedPoint(tabId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("클릭할 Flow 화면 좌표가 올바르지 않습니다.");
  }
  return withFlowDebugger(tabId, async (target) => {
    const point = { x: Math.round(x), y: Math.round(y) };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    return { clicked: true, ...point };
  });
}

function getTaskCollection(state, taskType) {
  return taskType === "character" ? state.characters : state.jobs;
}

function findTask(state, taskId, taskType = state.activeTaskType) {
  return getTaskCollection(state, taskType).find((entry) => entry.id === taskId) || null;
}

function decorateTaskAssets(task, assets) {
  return (Array.isArray(assets) ? assets : []).map((asset) => ({
    ...asset,
    prompt: asset?.prompt || task?.prompt || "",
    title: asset?.title || task?.title || task?.displayName || "",
    sourceMode: asset?.sourceMode || task?.sourceMode || (task?.key ? "character" : "scene"),
    number: asset?.number || task?.sourceNumber || task?.number || task?.index + 1,
    kind: asset?.kind || (task?.key ? "character" : task?.sourceMode || "scene")
  }));
}

async function pauseWithError(message, taskId = null, taskType = null) {
  const snapshot = await readState();
  const activeId = taskId || snapshot.activeJobId;
  const activeType = taskType || snapshot.activeTaskType || "scene";
  if (activeType === "scene" && findTask(snapshot, activeId, activeType)?.supplementing) {
    return finishSceneSupplementFailure(activeId, message);
  }
  await chrome.alarms.clear(QUEUE_ALARM);
  return updateState((state) => {
    const activeId = taskId || state.activeJobId;
    const activeType = taskType || state.activeTaskType || "scene";
    const task = findTask(state, activeId, activeType);
    const rolledBack = activeType === "scene" && /(?:일일\s*한도|quota|limit reached|generation limit)/i.test(String(message || ""))
      ? rollbackUnverifiedCompletedScenes(state, activeId, message)
      : [];
    const resolvedMessage = rolledBack.length
      ? `${message} 결과 이미지가 없던 직전 ${rolledBack.length}개 완료 작업도 재생성 대기로 되돌렸습니다.`
      : message;
    if (task && task.status !== "completed") {
      task.status = "failed";
      task.stage = "확인 필요";
      task.progress = Math.min(95, Number(task.progress || 0));
      task.error = resolvedMessage;
    }
    state.activeJobId = null;
    state.activeTaskType = null;
    state.nextRunAt = null;
    state.pauseRequested = false;
    state.status = "paused";
    state.lastError = resolvedMessage;
  });
}

async function scheduleSceneAutomaticRetry(message, jobId = null) {
  const snapshot = await readState();
  const supplementJob = snapshot.jobs.find((entry) => entry.id === (jobId || snapshot.activeJobId));
  if (supplementJob?.supplementing) return finishSceneSupplementFailure(supplementJob.id, message);
  if (isBlockingFlowError(message)) return pauseWithError(message, jobId, "scene");

  await chrome.alarms.clear(QUEUE_ALARM);
  const state = await updateState((draft) => {
    const activeId = jobId || draft.activeJobId;
    const job = draft.jobs.find((entry) => entry.id === activeId);
    if (!job || job.status === "completed") return;
    if (!draft.activeJobId && job.status === "pending" && draft.status === "waiting" && Number(draft.nextRunAt || 0) > Date.now()) {
      return;
    }

    if (draft.pauseRequested || draft.manualPause) {
      job.status = "pending";
      job.stage = "사용자 중단";
      job.error = null;
      draft.activeJobId = null;
      draft.activeTaskType = null;
      draft.pauseRequested = false;
      draft.manualPause = true;
      draft.status = "paused";
      draft.nextRunAt = null;
      draft.lastError = null;
      return;
    }

    if (!canAutomaticallyRetry(job) || Number(job.autoRetryCount || 0) >= MAX_AUTOMATIC_RETRIES) {
      markSceneFailedAndContinue(draft, activeId, message);
      return;
    }
    const retry = prepareSceneAutomaticRetry(job, message);
    if (!retry) {
      markSceneFailedAndContinue(draft, activeId, message);
      return;
    }
    draft.activeJobId = null;
    draft.activeTaskType = null;
    draft.pauseRequested = false;
    draft.manualPause = false;
    draft.status = "waiting";
    draft.nextRunAt = Date.now() + retry.delayMs;
    draft.lastError = null;
  });

  if (state.status === "waiting" && state.nextRunAt) {
    await chrome.alarms.create(QUEUE_ALARM, { when: state.nextRunAt });
  }
  return state;
}

async function launchNextJob() {
  if (launchInProgress) return;
  launchInProgress = true;
  let selectedTask = null;

  try {
    const state = await updateState((draft) => {
      if (draft.status !== "running" || draft.activeJobId) return;
      const next = findNextTask(draft);
      if (!next) {
        const blockedByCharacter = draft.jobs.some((job) => job.status === "pending")
          && draft.characters.some((character) => character.status !== "completed");
        draft.status = blockedByCharacter ? "paused" : (draft.jobs.length || draft.characters.length ? "completed" : "idle");
        if (blockedByCharacter) draft.lastError = "모든 캐릭터 등록을 완료해야 장면 생성을 시작할 수 있습니다.";
        draft.nextRunAt = null;
        return;
      }

      const resumeSubmitted = next.type === "scene" && Boolean(next.item.requestSubmittedAt);
      selectedTask = { id: next.item.id, type: next.type, resumeSubmitted };
      draft.activeJobId = next.item.id;
      draft.activeTaskType = next.type;
      draft.phase = next.type === "character" ? "characters" : "scenes";
      draft.nextRunAt = null;
      next.item.status = resumeSubmitted ? "generating" : "configuring";
      next.item.stage = resumeSubmitted ? "기존 생성 상태 추적 재개 중" : "Flow 연결 중";
      next.item.progress = resumeSubmitted ? Math.max(28, Number(next.item.progress || 0)) : 5;
      next.item.attempts += 1;
      next.item.startedAt = Date.now();
      next.item.completedAt = null;
      next.item.error = null;
      if (next.type === "scene" && !resumeSubmitted) {
        next.item.generationMode = "direct";
        next.item.resultAssets = [];
        next.item.generationPercentages = [];
        next.item.baselineMedia = [];
        next.item.baselineCapturedAt = null;
        next.item.baselineFailureCount = null;
        next.item.requestSubmittedAt = null;
        next.item.recoveryAttempts = 0;
        next.item.lastRecoveryAt = null;
      }
    });

    if (!selectedTask) return;
    const task = findTask(state, selectedTask.id, selectedTask.type);
    const tab = await findFlowTab(state.tabId);
    if (!tab?.id) {
      await updateState((draft) => {
        const active = findTask(draft, selectedTask.id, selectedTask.type);
        if (active) {
          active.status = "pending";
          active.stage = "Flow 탭 필요";
          active.progress = 0;
        }
        draft.activeJobId = null;
        draft.activeTaskType = null;
        draft.status = "paused";
        draft.lastError = "Google Flow 프로젝트 탭을 연 뒤 이어하기를 눌러 주세요.";
      });
      return;
    }

    await updateState((draft) => {
      draft.tabId = tab.id;
      draft.flowConnected = true;
      const active = findTask(draft, selectedTask.id, selectedTask.type);
      if (active) {
        active.stage = selectedTask.type === "character"
          ? "캐릭터 생성 화면 준비 중"
          : selectedTask.resumeSubmitted ? "모든 미디어에서 기존 생성 결과 확인 중" : "모든 미디어 일반 생성 준비 중";
        active.progress = selectedTask.resumeSubmitted ? Math.max(28, Number(active.progress || 0)) : 10;
      }
    });

    const response = selectedTask.type === "character"
      ? await sendToTab(tab.id, {
        type: "RUN_FLOW_CHARACTER",
        character: {
          id: task.id,
          key: task.key,
          displayName: task.displayName,
          description: task.description,
          prompt: task.prompt
        },
        options: state.options
      })
      : await sendToTab(tab.id, selectedTask.resumeSubmitted
        ? {
          type: "RECONCILE_FLOW_JOB",
          job: sceneMessagePayload(task),
          options: state.options
        }
        : {
          type: "RUN_FLOW_JOB",
          job: sceneMessagePayload(task),
          options: state.options
        });

    if (!response?.accepted) {
      throw new Error(response?.error || "Flow 페이지가 작업을 시작하지 못했습니다.");
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (selectedTask?.type === "scene") await scheduleSceneAutomaticRetry(message, selectedTask.id);
    else await pauseWithError(message, selectedTask?.id, selectedTask?.type);
  } finally {
    launchInProgress = false;
  }
}

async function completeTask(taskId, taskType, imagesGenerated, assets = []) {
  if (taskType === "scene") {
    const snapshot = await readState();
    const task = findTask(snapshot, taskId, taskType);
    const incomingAssets = decorateTaskAssets(task, assets);
    const verifiedAssets = uniqueAssets([...(task?.resultAssets || []), ...incomingAssets]);
    const supplementBaseCount = Math.max(0, Number(task?.supplementBaseAssetCount || 0));
    if (task?.supplementing && verifiedAssets.length <= supplementBaseCount) {
      return finishSceneSupplementFailure(taskId, "Flow 생성이 끝났지만 새로 추가된 결과 이미지를 확인하지 못했습니다.");
    }
    if (!verifiedAssets.length) {
      return scheduleSceneAutomaticRetry(
        "Flow 완료 신호를 받았지만 다운로드 가능한 결과 이미지를 확인하지 못했습니다.",
        taskId
      );
    }
  }
  await chrome.alarms.clear(QUEUE_ALARM);
  const state = await updateState((draft) => {
    if (draft.activeJobId !== taskId || draft.activeTaskType !== taskType) return;
    const task = findTask(draft, taskId, taskType);
    if (!task) return;
    const supplementing = taskType === "scene" && Boolean(task.supplementing);

    task.status = "completed";
    task.stage = taskType === "character" ? `@${task.key} 등록 완료` : "완료";
    task.progress = 100;
    task.completedAt = Date.now();
    if (taskType === "character") {
      task.referenceImages = Math.max(1, Number(imagesGenerated || 1));
      task.resultAssets = uniqueAssets([...(task.resultAssets || []), ...decorateTaskAssets(task, assets)]).slice(0, 1);
    }
    else {
      // Preserve variable-size results up to Flow's four-image UI limit.
      const allResultAssets = uniqueAssets([...(task.resultAssets || []), ...decorateTaskAssets(task, assets)]);
      const requestedImages = supplementing
        ? Math.max(1, Number(task.supplementRequestedImages || 1))
        : Math.max(1, Number(draft.options.imagesPerPrompt || 2));
      const actualImages = allResultAssets.length || Math.max(0, Number(imagesGenerated || 0));
      task.imagesGenerated = actualImages;
      if (supplementing) {
        const baseCount = Math.max(0, Number(task.supplementBaseAssetCount || 0));
        const addedImages = Math.max(0, actualImages - baseCount);
        const targetTotal = Math.max(3, Number(task.supplementTargetTotal || 3));
        task.stage = addedImages < requestedImages
          ? `완료 · 보충 ${addedImages}/${requestedImages}장 추가 · 총 ${actualImages}장`
          : `완료 · ${addedImages}장 보충 · 총 ${actualImages}장`;
        if (actualImages >= targetTotal) task.supplementTargetTotal = null;
        clearSceneSupplementRun(task);
      } else {
        task.stage = actualImages < requestedImages ? `완료 · ${actualImages}/${requestedImages}장 생성` : "완료";
      }
      task.resultAssetOverflowCount = Math.max(0, allResultAssets.length - MAX_TRACKED_RESULT_ASSETS);
      task.resultAssets = allResultAssets.slice(0, MAX_TRACKED_RESULT_ASSETS);
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
    task.error = null;
    draft.activeJobId = null;
    draft.activeTaskType = null;
    draft.lastError = null;

    if (supplementing) {
      draft.pauseRequested = false;
      draft.status = hasPendingTasks(draft) ? "paused" : "completed";
      draft.phase = draft.status === "completed" ? "completed" : "scenes";
      draft.manualPause = draft.status === "paused";
      draft.nextRunAt = null;
    } else if (!hasPendingTasks(draft)) {
      draft.pauseRequested = false;
      draft.status = "completed";
      draft.phase = "completed";
      draft.nextRunAt = null;
    } else if (draft.pauseRequested) {
      draft.pauseRequested = false;
      draft.status = "paused";
      draft.nextRunAt = null;
    } else {
      draft.status = "waiting";
      draft.nextRunAt = Date.now() + nextTaskDelayMs(draft.options);
    }
  });
  if (taskType === "character") await archiveProjectCharacters(state);
  if (taskType === "scene") await archiveProjectMappings(state);

  if (state.status === "waiting" && state.nextRunAt) {
    await chrome.alarms.create(QUEUE_ALARM, { when: state.nextRunAt });
  }
}

function characterMessagePayload(character) {
  return {
    id: character.id,
    key: character.key,
    displayName: character.displayName,
    description: character.description,
    prompt: character.prompt,
    flowCharacterId: String(character.flowCharacterId || ""),
    flowDetailUrl: String(character.flowDetailUrl || ""),
    nameSubmittedAt: character.nameSubmittedAt || null
  };
}

function sceneMessagePayload(job) {
  return {
    id: job.id,
    prompt: job.prompt,
    title: job.title,
    number: job.number,
    sourceNumber: job.sourceNumber,
    sourceMode: job.sourceMode,
    characterRefs: job.characterRefs,
    script: job.script,
    progress: job.progress,
    generationMode: job.generationMode || "direct",
    baselineMedia: Array.isArray(job.baselineMedia) ? job.baselineMedia : [],
    baselineCapturedAt: job.baselineCapturedAt || null,
    baselineFailureCount: Number.isInteger(job.baselineFailureCount) ? job.baselineFailureCount : null,
    requestSubmittedAt: job.requestSubmittedAt || null
  };
}

function sceneGenerationOptions(state, job) {
  const requestedImages = job?.supplementing
    ? Math.max(1, Number(job.supplementRequestedImages || 1))
    : Math.max(1, Number(state.options.imagesPerPrompt || 2));
  return { ...state.options, imagesPerPrompt: requestedImages };
}

function clearSceneSupplementRun(job) {
  job.supplementing = false;
  job.supplementBaseAssetCount = null;
  job.supplementRequestedImages = null;
  job.generationPercentages = [];
  job.baselineMedia = [];
  job.baselineCapturedAt = null;
  job.baselineFailureCount = null;
  job.requestSubmittedAt = null;
  job.recoveryAttempts = 0;
  job.lastRecoveryAt = null;
  job.autoRetryCount = 0;
  job.lastRetryAt = null;
  job.lastTransientError = null;
}

async function finishSceneSupplementFailure(jobId, message) {
  await chrome.alarms.clear(QUEUE_ALARM);
  const state = await updateState((draft) => {
    const job = draft.jobs.find((entry) => entry.id === jobId);
    if (!job?.supplementing) return;
    const existingCount = uniqueAssets(job.resultAssets || []).length;
    job.status = "completed";
    job.stage = `완료 · 보충 실패 · 기존 ${existingCount}장 유지`;
    job.progress = 100;
    job.imagesGenerated = existingCount;
    job.error = String(message || "추가 이미지 생성에 실패했습니다.");
    clearSceneSupplementRun(job);
    draft.activeJobId = null;
    draft.activeTaskType = null;
    draft.pauseRequested = false;
    draft.nextRunAt = null;
    draft.status = hasPendingTasks(draft) ? "paused" : "completed";
    draft.phase = draft.status === "completed" ? "completed" : "scenes";
    draft.manualPause = draft.status === "paused";
    draft.lastError = job.error;
  });
  await archiveProjectMappings(state);
  return state;
}

async function startSceneSupplement(jobId) {
  const current = await readState();
  if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
    throw new Error("현재 작업이 끝나거나 대기열을 중단한 뒤 이미지를 보충해 주세요.");
  }
  if (current.characters.some((character) => character.status !== "completed")) {
    throw new Error("모든 캐릭터가 Flow에 준비된 뒤 이미지를 보충할 수 있습니다.");
  }
  const currentJob = current.jobs.find((entry) => entry.id === jobId);
  const plan = sceneSupplementPlan(currentJob);
  if (!plan) throw new Error("1장만 생성된 완료 장면 또는 보충 중인 장면만 추가 생성할 수 있습니다.");
  const tab = await findFlowTab(current.tabId);
  if (!tab?.id) throw new Error("추가 이미지를 생성할 Google Flow 프로젝트 탭이 없습니다.");

  await chrome.alarms.clear(QUEUE_ALARM);
  const preparedState = await updateState((draft) => {
    if (draft.activeJobId || ["running", "waiting", "pausing"].includes(draft.status)) {
      throw new Error("다른 작업이 먼저 시작되어 추가 생성을 실행할 수 없습니다.");
    }
    const job = draft.jobs.find((entry) => entry.id === jobId);
    const freshPlan = sceneSupplementPlan(job);
    if (!freshPlan) throw new Error("보충할 장면의 이미지 상태가 변경되었습니다.");
    job.supplementing = true;
    job.supplementTargetTotal = freshPlan.targetTotal;
    job.supplementBaseAssetCount = freshPlan.currentImages;
    job.supplementRequestedImages = freshPlan.requestedImages;
    job.status = "configuring";
    job.stage = `추가 이미지 ${freshPlan.requestedImages}장 생성 준비 중 · 목표 ${freshPlan.targetTotal}장`;
    job.progress = 5;
    job.startedAt = Date.now();
    job.completedAt = null;
    job.error = null;
    job.generationPercentages = [];
    job.baselineMedia = [];
    job.baselineCapturedAt = null;
    job.baselineFailureCount = null;
    job.requestSubmittedAt = null;
    job.recoveryAttempts = 0;
    job.lastRecoveryAt = null;
    draft.activeJobId = job.id;
    draft.activeTaskType = "scene";
    draft.status = "running";
    draft.phase = "scenes";
    draft.manualPause = false;
    draft.pauseRequested = false;
    draft.nextRunAt = null;
    draft.lastFlowSceneImageCount = null;
    draft.lastFlowImageSyncAt = null;
    draft.lastError = null;
    draft.tabId = tab.id;
    draft.flowConnected = true;
  });

  const job = preparedState.jobs.find((entry) => entry.id === jobId);
  try {
    const response = await sendToTab(tab.id, {
      type: "RUN_FLOW_JOB",
      job: sceneMessagePayload(job),
      options: sceneGenerationOptions(preparedState, job)
    });
    if (!response?.accepted) throw new Error(response?.error || "Flow에서 추가 이미지 생성을 시작하지 못했습니다.");
    return preparedState;
  } catch (error) {
    await finishSceneSupplementFailure(jobId, String(error?.message || error));
    throw error;
  }
}

async function reconcileActiveCharacter(tabId, state) {
  if (state.activeTaskType !== "character" || !state.activeJobId) return;
  const character = state.characters.find((entry) => entry.id === state.activeJobId);
  if (!character) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const currentDetail = characterDetailFromFlowUrl(tab.url);
    const storedDetail = characterDetailFromFlowUrl(character.flowDetailUrl);
    if (storedDetail
      && storedDetail.projectId === state.flowProjectId
      && currentDetail?.characterId !== storedDetail.characterId
      && !character.nameSubmittedAt) {
      await chrome.tabs.update(tabId, { url: storedDetail.url });
      return;
    }
    const response = await sendToTab(tabId, {
      type: "RECONCILE_FLOW_CHARACTER",
      character: characterMessagePayload(character),
      options: state.options
    });
    if (!response?.accepted) throw new Error(response?.error || "캐릭터 등록 상태 복구를 시작하지 못했습니다.");
  } catch (error) {
    await pauseWithError(
      `Flow 화면 전환 후 캐릭터 상태를 복구하지 못했습니다: ${String(error?.message || error)}`,
      character.id,
      "character"
    );
  }
}

async function captureActiveCharacterDetailRoute(tabId, value) {
  const detail = characterDetailFromFlowUrl(value);
  if (!detail || !Number.isInteger(tabId)) return null;
  const current = await readState();
  if (current.activeTaskType !== "character" || !current.activeJobId) return null;
  if (current.tabId != null && current.tabId !== tabId) return null;
  if (current.flowProjectId && current.flowProjectId !== detail.projectId) return null;
  let captured = false;
  const state = await updateState((draft) => {
    if (draft.activeTaskType !== "character" || !draft.activeJobId) return;
    if (draft.tabId != null && draft.tabId !== tabId) return;
    if (draft.flowProjectId && draft.flowProjectId !== detail.projectId) return;
    const character = draft.characters.find((entry) => entry.id === draft.activeJobId);
    if (!character || character.status === "completed") return;
    character.flowCharacterId = detail.characterId;
    character.flowDetailUrl = detail.url;
    character.submissionDiagnostic = "";
    if (!character.nameSubmittedAt) character.stage = "Flow 캐릭터 상세 URL 확인 · 이름 저장 중";
    character.progress = Math.max(35, Number(character.progress || 0));
    character.lastHeartbeatAt = Date.now();
    draft.tabId = tabId;
    draft.flowConnected = true;
    captured = true;
  });
  return captured ? state : null;
}

async function restoreActiveCharacterDetailRoute(tabId, value) {
  const projectId = projectIdFromFlowUrl(value);
  if (!Number.isInteger(tabId) || !projectId || characterDetailFromFlowUrl(value)) return false;
  const state = await readState();
  if (state.activeTaskType !== "character" || !state.activeJobId || state.flowProjectId !== projectId) return false;
  if (state.tabId != null && state.tabId !== tabId) return false;
  const character = state.characters.find((entry) => entry.id === state.activeJobId);
  const storedDetail = characterDetailFromFlowUrl(character?.flowDetailUrl);
  if (!storedDetail || storedDetail.projectId !== projectId || character.nameSubmittedAt) return false;
  await chrome.tabs.update(tabId, { url: storedDetail.url });
  return true;
}

async function reconcileActiveScene(tabId, state, deliveryAttempt = 0) {
  if (state.activeTaskType !== "scene" || !state.activeJobId) return;
  const job = state.jobs.find((entry) => entry.id === state.activeJobId);
  if (!job) return;
  try {
    const response = await sendToTab(tabId, {
      type: "RECONCILE_FLOW_JOB",
      job: sceneMessagePayload(job),
      options: sceneGenerationOptions(state, job)
    });
    if (!response?.accepted) throw new Error(response?.error || "일반 이미지 생성 상태 복구를 시작하지 못했습니다.");
  } catch (error) {
    const latest = await updateState((draft) => {
      if (draft.activeTaskType !== "scene" || draft.activeJobId !== job.id) return;
      const active = draft.jobs.find((entry) => entry.id === job.id);
      if (!active || active.status === "completed") return;
      active.status = active.requestSubmittedAt ? "generating" : "configuring";
      active.stage = `Flow 재연결 중 · 상태 확인 재시도 ${deliveryAttempt + 1}`;
      active.error = null;
      active.lastHeartbeatAt = Date.now();
      draft.status = "running";
      draft.lastError = null;
    });
    if (deliveryAttempt < 4 && latest.activeTaskType === "scene" && latest.activeJobId === job.id) {
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (deliveryAttempt + 1)));
      const current = await readState();
      if (current.activeTaskType === "scene" && current.activeJobId === job.id) {
        return reconcileActiveScene(tabId, current, deliveryAttempt + 1);
      }
    }
  }
}

async function synchronizeFlowCharacters() {
  const current = await readState();
  if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
    throw new Error("실행 중인 큐를 먼저 중단한 뒤 Flow 상태를 동기화해 주세요.");
  }
  if (!current.characters.length) return loadCurrentProjectCharacters();

  const flowProject = await findCurrentFlowProject(current.tabId);
  if (!flowProject?.tab?.id) throw new Error("Flow 캐릭터 상태를 확인할 프로젝트 탭이 없습니다.");
  if (!current.flowProjectId && current.characters.length) {
    throw new Error("이전 작업의 캐릭터 원본 프로젝트를 확인할 수 없습니다. 프로젝트 캐릭터 불러오기로 현재 Flow 등록 정보를 먼저 읽어 주세요.");
  }
  if (current.flowProjectId && current.flowProjectId !== flowProject.projectId) {
    throw new Error("현재 Flow 프로젝트가 작업 큐의 캐릭터 프로젝트와 다릅니다. 프로젝트 캐릭터 불러오기를 먼저 실행해 주세요.");
  }
  const scan = await sendToTab(flowProject.tab.id, {
    type: "SCAN_FLOW_CHARACTERS",
    characterKeys: current.characters.map((character) => character.key)
  });
  if (!scan?.ready) throw new Error(scan?.error || "Flow 캐릭터 목록을 읽지 못했습니다.");
  if (scan.inProgress) {
    throw new Error("Flow에서 캐릭터 생성이 진행 중입니다. 완료될 때까지 현재 화면을 유지해 주세요.");
  }

  let matchedKeys = [];
  let repairedKeys = [];
  const state = await updateState((draft) => {
    matchedKeys = applyRegisteredCharacterKeys(draft, scan.registeredKeys || []);
    const registered = new Set((scan.registeredKeys || []).map((key) => String(key).trim().toLowerCase()).filter(Boolean));
    for (const character of draft.characters) {
      const automaticCompletion = character.status === "completed"
        && String(character.stage || "").trim() === `@${character.key} 등록 완료`;
      if (!automaticCompletion || registered.has(String(character.key || "").trim().toLowerCase())) continue;
      setCharacterReady(draft, character.id, false, "Flow 이름 미확인 · 다시 생성 대기");
      repairedKeys.push(character.key);
    }
    const scannedAssets = new Map(
      (scan.characterAssets || []).map((asset) => [String(asset.name || "").trim().toLowerCase(), asset])
    );
    for (const character of draft.characters) {
      const asset = scannedAssets.get(String(character.key || "").trim().toLowerCase());
      if (asset) character.resultAssets = uniqueAssets([asset]).slice(0, 1);
    }
    draft.tabId = flowProject.tab.id;
    draft.flowProjectId = flowProject.projectId;
    draft.flowProjectTitle = flowProject.projectTitle;
    draft.flowConnected = true;
    draft.flowSurface = String(scan.surface || "unknown");
    draft.lastFlowSyncAt = Date.now();
    draft.lastFlowRegisteredKeys = Array.isArray(scan.registeredKeys) ? scan.registeredKeys.map(String) : [];
    if (draft.characters.some((character) => character.status === "pending")) {
      draft.phase = "characters";
    } else if (draft.jobs.some((job) => job.status === "pending")) {
      draft.phase = "scenes";
    }
    if (matchedKeys.length && /새로고침|캐릭터.*실패|등록 상태/i.test(String(draft.lastError || ""))) {
      draft.lastError = null;
    }
    if (repairedKeys.length) {
      draft.status = draft.jobs.length ? "paused" : "idle";
      draft.manualPause = Boolean(draft.jobs.length);
      draft.nextRunAt = null;
      draft.lastError = `Flow에서 이름을 확인하지 못한 캐릭터 ${repairedKeys.length}명을 다시 생성 대기로 되돌렸습니다.`;
    }
  });
  if (repairedKeys.length) await chrome.alarms.clear(QUEUE_ALARM);
  await archiveProjectCharacters(state);

  return {
    state,
    registeredKeys: Array.isArray(scan.registeredKeys) ? scan.registeredKeys : [],
    matchedKeys,
    repairedKeys,
    surface: scan.surface || "unknown"
  };
}

async function loadCurrentProjectCharacters() {
  const current = await readState();
  if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
    throw new Error("실행 중인 큐를 먼저 중단한 뒤 프로젝트 캐릭터를 불러와 주세요.");
  }
  const flowProject = await findCurrentFlowProject(current.tabId, { preferActive: true });
  if (!flowProject?.tab?.id) throw new Error("주소에 프로젝트 ID가 있는 Flow 프로젝트 탭을 열어 주세요.");
  const history = await readProjectHistory();
  const profile = findProjectCharacterProfile(history, flowProject.projectId);
  if (!profile) {
    const scan = await sendToTab(flowProject.tab.id, { type: "DISCOVER_FLOW_CHARACTERS" });
    if (!scan?.ready) throw new Error(scan?.error || "Flow 캐릭터 라이브러리를 읽지 못했습니다.");
    if (scan.inProgress) throw new Error("Flow에서 캐릭터 생성이 진행 중입니다. 완료될 때까지 현재 화면을 유지해 주세요.");
    const keys = Array.from(new Set((scan.registeredKeys || []).map(String).filter(Boolean)));
    if (!keys.length) throw new Error("이 Flow 프로젝트에서 @이름 형식의 등록 캐릭터를 찾지 못했습니다.");
    const imported = await updateState((state) => {
      state.characters = createCharacters(keys.map((key) => ({
        key,
        displayName: key,
        description: "Flow 프로젝트에 이미 등록된 캐릭터",
        prompt: `Flow 프로젝트에 이미 등록된 @${key} 캐릭터`,
        referenceCount: 0
      })), { alreadyRegistered: true });
      state.jobs = [];
      state.queueMode = "scene";
      state.executionMode = "automatic";
      state.status = "idle";
      state.phase = "scenes";
      state.activeJobId = null;
      state.activeTaskType = null;
      state.nextRunAt = null;
      state.pauseRequested = false;
      state.manualPause = false;
      state.flowConnected = true;
      state.flowSurface = String(scan.surface || "unknown");
      state.flowProjectId = flowProject.projectId;
      state.flowProjectTitle = flowProject.projectTitle;
      state.tabId = flowProject.tab.id;
      state.lastFlowRegisteredKeys = keys;
      state.lastFlowSyncAt = Date.now();
      state.lastFlowSceneImageCount = null;
      state.lastFlowImageSyncAt = null;
      state.lastError = null;
    });
    const saved = await archiveProjectCharacters(imported);
    return {
      state: imported,
      registeredKeys: keys,
      matchedKeys: keys,
      surface: scan.surface || "unknown",
      profile: projectProfileSummary(saved),
      importedFromFlow: true
    };
  }

  const loaded = await updateState((state) => {
    state.characters = createCharacters(profile.characters);
    state.jobs = [];
    state.queueMode = "scene";
    state.executionMode = "automatic";
    state.status = "idle";
    state.phase = state.characters.length ? "characters" : "idle";
    state.activeJobId = null;
    state.activeTaskType = null;
    state.nextRunAt = null;
    state.pauseRequested = false;
    state.manualPause = false;
    state.flowConnected = true;
    state.flowSurface = null;
    state.flowProjectId = flowProject.projectId;
    state.flowProjectTitle = flowProject.projectTitle;
    state.tabId = flowProject.tab.id;
    state.lastFlowRegisteredKeys = [];
    state.lastFlowSyncAt = null;
    state.lastFlowSceneImageCount = null;
    state.lastFlowImageSyncAt = null;
    state.lastError = null;
  });
  await archiveProjectCharacters(loaded);
  const sync = await synchronizeFlowCharacters();
  return {
    ...sync,
    profile: projectProfileSummary(profile),
    importedFromFlow: false
  };
}

async function ensureCurrentProjectCharacters() {
  const current = await readState();
  if (!current.characters.length) return loadCurrentProjectCharacters();
  try {
    return await synchronizeFlowCharacters();
  } catch (error) {
    const message = String(error?.message || error);
    if (/캐릭터 프로젝트와 다릅니다|캐릭터 원본 프로젝트를 확인할 수 없습니다/.test(message)) {
      return loadCurrentProjectCharacters();
    }
    throw error;
  }
}

async function handleFlowEvent(message, sender) {
  const tabId = sender.tab?.id ?? null;

  if (message.type === "FLOW_TRUSTED_TYPE") {
    if (!tabId || !isFlowUrl(sender.url || sender.tab?.url)) {
      throw new Error("Google Flow 콘텐츠에서 보낸 입력 요청만 허용됩니다.");
    }
    return insertTrustedText(tabId, String(message.text || ""), { clear: Boolean(message.clear) });
  }

  if (message.type === "FLOW_TRUSTED_KEY") {
    if (!tabId || !isFlowUrl(sender.url || sender.tab?.url)) {
      throw new Error("Google Flow 콘텐츠에서 보낸 키 입력 요청만 허용됩니다.");
    }
    return pressTrustedKey(tabId, String(message.key || ""));
  }

  if (message.type === "FLOW_TRUSTED_SUBMIT") {
    if (!tabId || !isFlowUrl(sender.url || sender.tab?.url)) {
      throw new Error("Google Flow 콘텐츠에서 보낸 전송 요청만 허용됩니다.");
    }
    return pressTrustedKey(tabId, "Enter");
  }

  if (message.type === "FLOW_TRUSTED_CLICK") {
    if (!tabId || !isFlowUrl(sender.url || sender.tab?.url)) {
      throw new Error("Google Flow 콘텐츠에서 보낸 클릭 요청만 허용됩니다.");
    }
    return clickTrustedPoint(tabId, Number(message.x), Number(message.y));
  }

  if (message.type === "FLOW_READY") {
    let shouldReconcileCharacter = false;
    let shouldReconcileScene = false;
    const readyDetail = characterDetailFromFlowUrl(message.url || sender.url || sender.tab?.url);
    const state = await updateState((state) => {
      const sessionChanged = state.pageSessionId && state.pageSessionId !== message.pageSessionId;
      const active = state.activeJobId ? findTask(state, state.activeJobId) : null;
      const activeTabMatches = !active || state.tabId == null || state.tabId === tabId;
      if (readyDetail
        && active
        && activeTabMatches
        && state.activeTaskType === "character"
        && (!state.flowProjectId || state.flowProjectId === readyDetail.projectId)) {
        active.flowCharacterId = readyDetail.characterId;
        active.flowDetailUrl = readyDetail.url;
        active.submissionDiagnostic = "";
        if (!active.nameSubmittedAt) active.stage = "Flow 캐릭터 상세 URL 확인 · 이름 저장 중";
        active.progress = Math.max(35, Number(active.progress || 0));
      }
      if ((sessionChanged || readyDetail) && active && activeTabMatches && ["configuring", "generating"].includes(active.status)) {
        if (state.activeTaskType === "character") {
          active.status = "generating";
          active.stage = "Flow 화면 전환 · 등록 상태 복구 중";
          active.progress = Math.max(30, Number(active.progress || 0));
          active.error = null;
          active.lastHeartbeatAt = Date.now();
          state.status = "running";
          state.lastError = null;
          shouldReconcileCharacter = true;
        } else {
          prepareSceneNavigationRecovery(active);
          state.status = "running";
          state.lastError = null;
          shouldReconcileScene = true;
        }
      }
      if (!active && message.generationFailureMessage) {
        const rolledBack = rollbackUnverifiedCompletedScenes(state, null, message.generationFailureMessage);
        if (rolledBack.length) {
          const firstFailedJob = state.jobs.find((job) => job.id === rolledBack[0]);
          if (firstFailedJob) {
            firstFailedJob.status = "failed";
            firstFailedJob.stage = "일일 한도 확인 필요";
            firstFailedJob.error = message.generationFailureMessage;
          }
          state.status = "paused";
          state.phase = "scenes";
          state.nextRunAt = null;
          state.lastError = `${message.generationFailureMessage} 결과 이미지가 없던 최근 ${rolledBack.length}개 완료 작업을 재생성 대기로 되돌렸습니다.`;
        }
      }
      if (activeTabMatches) {
        state.tabId = tabId;
        state.pageSessionId = message.pageSessionId;
        state.flowConnected = true;
      }
    });
    if (shouldReconcileCharacter && tabId) void reconcileActiveCharacter(tabId, state);
    if (shouldReconcileScene && tabId) void reconcileActiveScene(tabId, state);
    return state;
  }

  if (message.type === "FLOW_ROUTE_CHANGED") {
    const url = String(message.url || sender.url || sender.tab?.url || "");
    const captured = await captureActiveCharacterDetailRoute(tabId, url);
    if (captured) return captured;
    await restoreActiveCharacterDetailRoute(tabId, url);
    return readState();
  }

  if (message.type === "FLOW_JOB_PROGRESS") {
    return updateState((state) => {
      if (state.activeJobId !== message.jobId || state.activeTaskType !== "scene") return;
      const job = state.jobs.find((entry) => entry.id === message.jobId);
      if (!job || job.status === "completed") return;
      job.status = message.phase === "configuring" ? "configuring" : "generating";
      job.stage = String(message.stage || job.stage);
      job.progress = Math.max(job.progress, Math.min(96, Number(message.progress || 0)));
      job.detectedImages = Math.max(Number(job.detectedImages || 0), Number(message.detectedImages || 0));
      if (Array.isArray(message.generationPercentages)) {
        const expectedImageCount = job.supplementing
          ? Math.max(1, Number(job.supplementRequestedImages || 1))
          : Math.max(1, Number(state.options.imagesPerPrompt || 2));
        job.generationPercentages = message.generationPercentages
          .map(Number)
          .filter(Number.isFinite)
          .map((value) => Math.max(0, Math.min(100, value)))
          .slice(0, expectedImageCount);
      }
      if (Array.isArray(message.baselineMedia)) {
        job.baselineMedia = message.baselineMedia.map(String);
        job.baselineCapturedAt = Number(message.baselineCapturedAt || Date.now());
      }
      if (Number.isInteger(message.baselineFailureCount)) {
        job.baselineFailureCount = Math.max(0, message.baselineFailureCount);
      }
      if (Array.isArray(message.assets) && message.assets.length) {
        const allResultAssets = uniqueAssets([
          ...job.resultAssets,
          ...decorateTaskAssets(job, message.assets)
        ]);
        job.resultAssetOverflowCount = Math.max(0, allResultAssets.length - MAX_TRACKED_RESULT_ASSETS);
        job.resultAssets = allResultAssets.slice(0, MAX_TRACKED_RESULT_ASSETS);
      }
      if (message.requestSubmittedAt) job.requestSubmittedAt = Number(message.requestSubmittedAt);
      if (message.generationMode) job.generationMode = String(message.generationMode);
      if (message.submissionDiagnostic) job.submissionDiagnostic = String(message.submissionDiagnostic);
      job.lastHeartbeatAt = Date.now();
      state.flowConnected = true;
      state.tabId = tabId;
    });
  }

  if (message.type === "FLOW_JOB_COMPLETED") {
    return completeTask(message.jobId, "scene", message.imagesGenerated, message.assets);
  }

  if (message.type === "FLOW_CHARACTER_PROGRESS") {
    return updateState((state) => {
      if (state.activeJobId !== message.characterId || state.activeTaskType !== "character") return;
      const character = state.characters.find((entry) => entry.id === message.characterId);
      if (!character || character.status === "completed") return;
      character.status = message.phase === "configuring" ? "configuring" : "generating";
      character.stage = String(message.stage || character.stage);
      character.progress = Math.max(character.progress, Math.min(96, Number(message.progress || 0)));
      character.detectedImages = Math.max(Number(character.detectedImages || 0), Number(message.detectedImages || 0));
      if (Object.prototype.hasOwnProperty.call(message, "submissionDiagnostic")) {
        character.submissionDiagnostic = String(message.submissionDiagnostic || "");
      }
      character.lastHeartbeatAt = Date.now();
      state.flowConnected = true;
      state.tabId = tabId;
    });
  }

  if (message.type === "FLOW_CHARACTER_NAME_SUBMITTED") {
    const detail = characterDetailFromFlowUrl(message.flowDetailUrl || sender.url || sender.tab?.url);
    return updateState((state) => {
      if (state.activeJobId !== message.characterId || state.activeTaskType !== "character") return;
      const character = state.characters.find((entry) => entry.id === message.characterId);
      if (!character || character.status === "completed") return;
      if (detail && (!state.flowProjectId || state.flowProjectId === detail.projectId)) {
        character.flowCharacterId = detail.characterId;
        character.flowDetailUrl = detail.url;
      }
      character.nameSubmittedAt = Date.now();
      character.submissionDiagnostic = "";
      character.stage = `@${character.key} 이름 입력 · Flow 저장 확인 중`;
      character.progress = Math.max(92, Number(character.progress || 0));
      character.lastHeartbeatAt = Date.now();
      state.flowConnected = true;
      state.tabId = tabId;
    });
  }

  if (message.type === "FLOW_CHARACTER_COMPLETED") {
    if (message.registrationVerified !== true) {
      return pauseWithError(
        "Flow 캐릭터 이름 저장을 확인하지 못해 완료 처리하지 않았습니다. 제목 없는 캐릭터 카드와 이름을 확인해 주세요.",
        message.characterId,
        "character"
      );
    }
    return completeTask(message.characterId, "character", message.referenceImages, message.assets);
  }

  if (message.type === "FLOW_CHARACTER_NEEDS_REVIEW") {
    await chrome.alarms.clear(QUEUE_ALARM);
    return updateState((state) => {
      if (state.activeJobId !== message.characterId || state.activeTaskType !== "character") return;
      const character = state.characters.find((entry) => entry.id === message.characterId);
      if (!character) return;
      character.status = "review";
      character.stage = "Flow에서 이미지 선택·이름 저장 필요";
      character.progress = Math.max(85, Number(character.progress || 0));
      character.detectedImages = Math.max(Number(character.detectedImages || 0), Number(message.referenceImages || 0));
      state.status = "paused";
      state.pauseRequested = false;
      state.nextRunAt = null;
      state.lastError = `Flow에서 참조 이미지 1~2장을 선택하고 캐릭터 이름을 '${character.key}'로 저장한 뒤 등록 확인을 눌러 주세요.`;
    });
  }

  if (message.type === "FLOW_JOB_PAUSED") {
    await chrome.alarms.clear(QUEUE_ALARM);
    return updateState((state) => {
      if (state.activeJobId !== message.jobId || state.activeTaskType !== "scene") return;
      const job = state.jobs.find((entry) => entry.id === message.jobId);
      if (job) {
        if (job.supplementing) {
          const existingCount = uniqueAssets(job.resultAssets || []).length;
          job.status = "completed";
          job.stage = `완료 · 보충 중단 · 기존 ${existingCount}장 유지`;
          job.progress = 100;
          job.imagesGenerated = existingCount;
          clearSceneSupplementRun(job);
        } else {
          job.status = "pending";
          job.stage = "사용자 중단";
          job.progress = 0;
        }
      }
      state.activeJobId = null;
      state.activeTaskType = null;
      state.pauseRequested = false;
      state.status = "paused";
      state.nextRunAt = null;
    });
  }

  if (message.type === "FLOW_JOB_FAILED") {
    const state = await readState();
    const job = findTask(state, message.jobId, "scene");
    // Flow can show a terminal warning after it has already created only part
    // of a requested batch. Those verified assets are a usable success, not a
    // reason to submit the same prompt again and accidentally attach newer
    // cards from a later request.
    if (job?.supplementing) {
      const baseCount = Math.max(0, Number(job.supplementBaseAssetCount || 0));
      if (uniqueAssets(job.resultAssets || []).length > baseCount) {
        return completeTask(message.jobId, "scene", job.resultAssets.length, []);
      }
      return finishSceneSupplementFailure(message.jobId, String(message.error || "추가 이미지 생성에 실패했습니다."));
    }
    if (job?.resultAssets?.length) {
      return completeTask(message.jobId, "scene", job.resultAssets.length, []);
    }
    return scheduleSceneAutomaticRetry(String(message.error || "Flow 이미지 생성에 실패했습니다."), message.jobId);
  }

  if (message.type === "FLOW_CHARACTER_PAUSED") {
    await chrome.alarms.clear(QUEUE_ALARM);
    return updateState((state) => {
      if (state.activeJobId !== message.characterId || state.activeTaskType !== "character") return;
      const character = state.characters.find((entry) => entry.id === message.characterId);
      if (character) {
        character.status = "pending";
        character.stage = String(message.stage || "사용자 중단 · 다시 생성 대기");
        character.progress = 0;
        character.detectedImages = 0;
        character.referenceImages = 0;
        character.resultAssets = [];
        character.error = null;
      }
      state.activeJobId = null;
      state.activeTaskType = null;
      state.pauseRequested = false;
      state.status = "paused";
      state.nextRunAt = null;
    });
  }

  if (message.type === "FLOW_CHARACTER_FAILED") {
    return pauseWithError(String(message.error || "Flow 캐릭터 생성에 실패했습니다."), message.characterId, "character");
  }

  return null;
}

function broadcastDownloadProgress(phase, current, total, message) {
  chrome.runtime.sendMessage({
    type: "PROJECT_DOWNLOAD_PROGRESS",
    progress: { phase, current: Number(current || 0), total: Number(total || 0), message: String(message || "") }
  }).catch(() => {});
}

async function ensureArchiveDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create one ZIP Blob URL so project images download as a single archive."
  });
}

async function buildProjectArchive(entries) {
  await ensureArchiveDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "BUILD_PROJECT_ARCHIVE",
    entries
  });
  if (!response?.ok) throw new Error(response?.error || "프로젝트 ZIP 파일을 만들지 못했습니다.");
  return requireArchiveResult(response.result);
}

async function downloadProject() {
  const current = await readState();
  if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
    throw new Error("실행 중인 큐를 먼저 중단하거나 완료한 뒤 프로젝트를 다운로드해 주세요.");
  }
  if (!current.jobs.length && !current.characters.length) {
    throw new Error("다운로드 순서를 만들 작업 목록이 없습니다. 프롬프트 분석 결과를 먼저 작업 큐에 적용해 주세요.");
  }

  const mainTab = await findFlowTab(current.tabId);
  if (!mainTab?.id) throw new Error("이미지를 가져올 Google Flow 프로젝트 탭이 없습니다.");
  downloadInProgress = true;
  syncPowerState(current);
  try {
    broadcastDownloadProgress("scanning", 0, 1, "Flow 모든 미디어 카드에서 원본 URL을 순서대로 수집하는 중");
    const scan = await sendToTab(mainTab.id, {
      type: "SCAN_FLOW_PROJECT_ASSETS",
      characterKeys: current.characters.map((character) => character.key)
    });
    if (!scan?.ready) throw new Error(scan?.error || "Flow 프로젝트의 이미지 URL을 수집하지 못했습니다.");

    const synchronizedState = await updateState((draft) => {
      const charactersByName = new Map(
        (scan.characterAssets || []).map((asset) => [String(asset.name || "").trim().toLowerCase(), asset])
      );
      for (const character of draft.characters) {
        const asset = charactersByName.get(String(character.key || "").trim().toLowerCase());
        if (asset) character.resultAssets = uniqueAssets([asset]);
      }
      draft.tabId = mainTab.id;
      draft.flowConnected = true;
      draft.assetCatalog = uniqueAssets(scan.sceneAssets || []);
      reconcileMappedAssets(draft, draft.assetCatalog);
      draft.lastFlowSceneImageCount = Array.isArray(scan.sceneAssets) ? scan.sceneAssets.length : null;
      draft.lastFlowImageSyncAt = Date.now();
    });
    await archiveProjectMappings(synchronizedState);

    const manifest = buildDownloadManifest({
      state: synchronizedState,
      projectTitle: scan.projectTitle,
      orderedSceneAssets: scan.sceneAssets || [],
      characterAssets: scan.characterAssets || []
    });
    if (!manifest.entries.length) throw new Error("Flow 모든 미디어에서 다운로드할 원본 이미지를 찾지 못했습니다.");
    broadcastDownloadProgress(
      "scanned",
      0,
      manifest.entries.length,
      `Flow 장면 ${manifest.scannedSceneCount}/${manifest.expectedSceneCount}장 · 캐릭터 ${manifest.entries.filter((entry) => entry.kind === "character").length}장 확인`
    );

    const archive = await buildProjectArchive(manifest.entries);
    const zipUrl = archive.url;
    const archiveFilename = manifest.archiveFilename;
    broadcastDownloadProgress("downloading", archive.count, manifest.entries.length, "프로젝트 ZIP 파일 다운로드 요청 중");
    try {
      await chrome.downloads.download({
        url: zipUrl,
        filename: archiveFilename,
        saveAs: false,
        conflictAction: "uniquify"
      });
    } finally {
      chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE_PROJECT_ARCHIVE", url: zipUrl }).catch(() => {});
    }

    broadcastDownloadProgress("completed", archive.count, manifest.entries.length, `${archive.count}개 이미지를 ZIP 하나로 저장 요청 완료`);
    return {
      folder: manifest.folder,
      archiveFilename,
      downloaded: archive.count,
      total: manifest.entries.length,
      sceneCount: manifest.entries.filter((entry) => entry.kind === "scene").length,
      introCount: manifest.entries.filter((entry) => entry.kind === "intro").length,
      thumbnailCount: manifest.entries.filter((entry) => entry.kind === "thumbnail").length,
      characterCount: manifest.entries.filter((entry) => entry.kind === "character").length,
      missingScenes: manifest.missingScenes,
      missingIntros: manifest.missingIntros,
      missingThumbnails: manifest.missingThumbnails,
      missingCharacters: manifest.missingCharacters,
      scannedSceneCount: manifest.scannedSceneCount,
      mappedSceneCount: manifest.mappedSceneCount,
      expectedSceneCount: manifest.expectedSceneCount,
      extraSceneCount: manifest.extraSceneCount,
      mappingWarnings: manifest.mappingWarnings,
      sceneAssetCounts: manifest.sceneAssetCounts,
      allMediaCount: Number(scan.allMediaCount || manifest.scannedSceneCount),
      removedCharacterMediaCount: Number(scan.removedCharacterMediaCount || 0),
      failures: []
    };
  } finally {
    downloadInProgress = false;
    syncPowerState(await readState().catch(() => current));
  }
}

async function scanProjectAssets() {
  const current = await readState();
  if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
    throw new Error("이미지 생성 중에는 매핑 목록을 갱신할 수 없습니다.");
  }
  const mainTab = await findFlowTab(current.tabId);
  if (!mainTab?.id) throw new Error("이미지를 가져올 Google Flow 프로젝트 탭이 없습니다.");
  const scan = await sendToTab(mainTab.id, {
    type: "SCAN_FLOW_PROJECT_ASSETS",
    characterKeys: current.characters.map((character) => character.key)
  });
  if (!scan?.ready) throw new Error(scan?.error || "Flow 프로젝트의 이미지 URL을 수집하지 못했습니다.");
  let removedMappings = 0;
  const state = await updateState((draft) => {
    draft.assetCatalog = uniqueAssets(scan.sceneAssets || []);
    removedMappings = reconcileMappedAssets(draft, draft.assetCatalog);
    draft.tabId = mainTab.id;
    draft.flowConnected = true;
    draft.lastFlowSceneImageCount = draft.assetCatalog.length;
    draft.lastFlowImageSyncAt = Date.now();
  });
  await archiveProjectMappings(state);
  return { state, assetCount: state.assetCatalog.length, removedMappings, projectTitle: scan.projectTitle };
}

function assertMappingReady(state) {
  if (state.activeJobId || ["running", "waiting", "pausing"].includes(state.status)) {
    throw new Error("이미지 생성 중에는 매핑을 변경할 수 없습니다.");
  }
}

async function mapAssetToJob(assetId, jobId) {
  const normalizedAssetId = String(assetId || "").trim();
  if (!normalizedAssetId) throw new Error("매핑할 asset ID가 없습니다.");
  const state = await updateState((state) => {
    assertMappingReady(state);
    if (!state.assetCatalog.some((asset) => asset.assetId === normalizedAssetId || asset.detailUrl === normalizedAssetId || asset.url === normalizedAssetId)) {
      throw new Error("현재 Flow 미디어 목록에서 해당 이미지를 찾지 못했습니다. 먼저 이미지 목록을 새로고침하세요.");
    }
    const target = state.jobs.find((job) => job.id === jobId);
    if (!target) throw new Error("매핑할 장면을 찾지 못했습니다.");
    const asset = state.assetCatalog.find((entry) => entry.assetId === normalizedAssetId || entry.detailUrl === normalizedAssetId || entry.url === normalizedAssetId);
    const key = asset.assetId || asset.detailUrl || asset.url;
    const aliases = new Set([asset.assetId, asset.detailUrl, asset.url].map((value) => String(value || "").trim()).filter(Boolean));
    for (const job of state.jobs) {
      job.mappedAssetIds = (job.mappedAssetIds || []).filter((id) => !aliases.has(String(id).trim()));
      if (job.id !== target.id) {
        job.resultAssets = (job.resultAssets || []).filter((entry) => ![entry.assetId, entry.detailUrl, entry.url].some((value) => aliases.has(String(value || "").trim())));
      }
    }
    target.mappedAssetIds = [...(target.mappedAssetIds || []), key];
    target.error = null;
  });
  await archiveProjectMappings(state);
  return state;
}

function removeAssetAliasesFromJob(job, requestedKey) {
  const key = String(requestedKey || "").trim();
  if (!key) return;
  const aliases = new Set([key]);
  for (const asset of job.resultAssets || []) {
    const assetAliases = [asset?.assetId, asset?.detailUrl, asset?.url].map((value) => String(value || "").trim()).filter(Boolean);
    if (assetAliases.includes(key)) assetAliases.forEach((alias) => aliases.add(alias));
  }
  job.mappedAssetIds = (job.mappedAssetIds || []).filter((id) => !aliases.has(String(id).trim()));
  job.resultAssets = (job.resultAssets || []).filter((asset) => ![asset?.assetId, asset?.detailUrl, asset?.url].some((value) => aliases.has(String(value || "").trim())));
}

async function unmapAssetFromJob(assetId, jobId) {
  const key = String(assetId || "").trim();
  const state = await updateState((state) => {
    assertMappingReady(state);
    const target = state.jobs.find((job) => job.id === jobId);
    if (target) {
      removeAssetAliasesFromJob(target, key);
      return;
    }
    for (const job of state.jobs) removeAssetAliasesFromJob(job, key);
  });
  await archiveProjectMappings(state);
  return state;
}

async function reassignAssetsFromPosition(startAssetKey, startJobId) {
  let plan;
  const state = await updateState((draft) => {
    assertMappingReady(draft);
    plan = buildAssetSuffixAssignments({
      catalog: draft.assetCatalog,
      jobs: draft.jobs,
      startAssetKey,
      startJobId,
      imagesPerPrompt: draft.options.imagesPerPrompt
    });
    const jobsById = new Map((draft.jobs || []).map((job) => [job.id, job]));
    const suffixAliases = new Set();
    (draft.assetCatalog || []).forEach((asset) => {
      const key = asset.assetId || asset.detailUrl || asset.url;
      if (plan.suffixAssetKeys.has(key)) assetAliases(asset).forEach((alias) => suffixAliases.add(alias));
    });
    (draft.jobs || []).forEach((job) => {
      if (plan.targetJobIds.has(job.id)) {
        job.mappedAssetIds = [];
        job.resultAssets = [];
        job.resultAssetOverflowCount = 0;
        return;
      }
      job.mappedAssetIds = (job.mappedAssetIds || []).filter((id) => !suffixAliases.has(String(id).trim()));
      job.resultAssets = (job.resultAssets || []).filter((asset) => !assetAliases(asset).some((alias) => suffixAliases.has(alias)));
    });
    plan.assignments.forEach(({ assetKey, jobId }) => {
      const job = jobsById.get(jobId);
      if (!job) return;
      if (!(job.mappedAssetIds || []).includes(assetKey)) job.mappedAssetIds = [...(job.mappedAssetIds || []), assetKey];
      job.error = null;
    });
  });
  await archiveProjectMappings(state);
  return { state, mappedCount: plan.assignments.length, startAssetIndex: plan.startAssetIndex, startJobIndex: plan.startJobIndex };
}

async function handleUiMessage(message) {
  if (message.type === "GET_STATE") return readState();

  if (message.type === "DOWNLOAD_PROJECT") return downloadProject();

  if (message.type === "SCAN_PROJECT_ASSETS") return scanProjectAssets();
  if (message.type === "MAP_ASSET_TO_JOB") return mapAssetToJob(message.assetId, message.jobId);
  if (message.type === "UNMAP_ASSET_FROM_JOB") return unmapAssetFromJob(message.assetId, message.jobId);
  if (message.type === "REASSIGN_ASSETS_FROM_POSITION") return reassignAssetsFromPosition(message.startAssetKey, message.startJobId);
  if (message.type === "FILL_SCENE_WITH_MORE_IMAGES") return startSceneSupplement(String(message.jobId || ""));

  if (message.type === "SET_QUEUE") {
    await chrome.alarms.clear(QUEUE_ALARM);
    const current = await readState();
    const reuseExistingCharacters = Boolean(message.reuseExistingCharacters);
    const flowProject = await findCurrentFlowProject(current.tabId, { preferActive: true });
    const savedProjectProfile = flowProject?.projectId
      ? findProjectCharacterProfile(await readProjectHistory(), flowProject.projectId)
      : null;
    if (reuseExistingCharacters
      && current.characters.length
      && (!current.flowProjectId || !flowProject?.projectId || current.flowProjectId !== flowProject.projectId)) {
      throw new Error("현재 Flow 프로젝트가 기존 캐릭터 작업내역과 다릅니다. 프로젝트 캐릭터 불러오기를 먼저 실행해 주세요.");
    }
    const nextState = await updateState((state) => {
      if (state.activeJobId) throw new Error("진행 중인 이미지 작업이 끝난 뒤 새 큐를 적용해 주세요.");
      const previousState = { characters: state.characters, jobs: state.jobs };
      const isIntroQueue = message.queueMode === "intro";
      const existingJobs = reuseExistingCharacters
        ? state.jobs
          .filter((job) => !isIntroQueue || ["intro", "thumbnail"].includes(String(job.sourceMode || "")))
          .map((job) => ({ ...job }))
        : [];
      const queuedPrompts = (Array.isArray(message.prompts) ? message.prompts : []).map((prompt, index) => ({
        ...prompt,
        number: Number(prompt.number || prompt.sourceNumber || index + 1),
        sourceNumber: Number(prompt.sourceNumber || prompt.number || index + 1),
        sourceMode: isIntroQueue ? prompt.sourceMode || "intro" : prompt.sourceMode || "scene"
      }));
      const jobs = [...existingJobs, ...createJobs(queuedPrompts)]
        .map((job, index) => ({ ...job, index }));
      const characters = reuseExistingCharacters
        ? state.characters.map((character) => ({ ...character }))
        : createCharacters(Array.isArray(message.characters) ? message.characters : [], {
          alreadyRegistered: false
        });
      carryForwardCompletedTasks({ characters, jobs }, previousState);
      restoreProjectMappings(jobs, savedProjectProfile);
      state.jobs = jobs;
      state.characters = characters;
      state.queueMode = isIntroQueue ? "intro" : "scene";
      state.executionMode = "automatic";
      if (flowProject?.projectId && state.flowProjectId && state.flowProjectId !== flowProject.projectId) {
        // Asset IDs are project-scoped; never expose the previous project's
        // catalog as if it belonged to the newly selected queue.
        state.assetCatalog = [];
      }
      state.lastFlowSceneImageCount = null;
      state.lastFlowImageSyncAt = null;
      state.status = "idle";
      state.phase = characters.some((character) => character.status === "pending") ? "characters" : "scenes";
      state.activeJobId = null;
      state.activeTaskType = null;
      state.nextRunAt = null;
      state.pauseRequested = false;
      state.manualPause = false;
      state.lastError = null;
      if (flowProject) {
        state.tabId = flowProject.tab.id;
        state.flowProjectId = flowProject.projectId;
        state.flowProjectTitle = flowProject.projectTitle;
        state.flowConnected = true;
      } else if (!reuseExistingCharacters) {
        state.tabId = null;
        state.flowProjectId = "";
        state.flowProjectTitle = "";
        state.assetCatalog = [];
      }
    });
    await archiveProjectCharacters(nextState);
    await archiveProjectMappings(nextState);
    return nextState;
  }

  if (message.type === "SYNC_FLOW_STATE") {
    return synchronizeFlowCharacters();
  }

  if (message.type === "ENSURE_CURRENT_PROJECT_CHARACTERS") {
    return ensureCurrentProjectCharacters();
  }

  if (message.type === "LOAD_PROJECT_CHARACTERS") {
    return loadCurrentProjectCharacters();
  }

  if (message.type === "SET_CHARACTER_READY") {
    return updateState((state) => {
      if (state.activeJobId || ["running", "waiting", "pausing"].includes(state.status)) {
        throw new Error("실행 중인 큐를 먼저 중단한 뒤 시작 단계를 변경해 주세요.");
      }
      const ready = Boolean(message.ready);
      if (!setCharacterReady(state, String(message.characterId || ""), ready)) {
        throw new Error("상태를 변경할 캐릭터를 찾지 못했습니다.");
      }
      state.nextRunAt = null;
      state.pauseRequested = false;
      state.lastError = null;
      if (!ready) {
        state.phase = "characters";
        state.status = state.status === "idle" ? "idle" : "paused";
      } else if (state.characters.every((character) => character.status === "completed")) {
        state.phase = state.jobs.some((job) => job.status === "pending") ? "scenes" : "completed";
        if (state.status === "completed" && state.jobs.some((job) => job.status === "pending")) state.status = "paused";
      }
    });
  }

  if (message.type === "SET_JOB_READY") {
    return updateState((state) => {
      if (state.activeJobId || ["running", "waiting", "pausing"].includes(state.status)) {
        throw new Error("실행 중인 큐를 먼저 중단한 뒤 시작 단계를 변경해 주세요.");
      }
      const ready = Boolean(message.ready);
      if (!setJobReady(state, String(message.jobId || ""), ready)) {
        throw new Error("상태를 변경할 장면 작업을 찾지 못했습니다.");
      }
      state.nextRunAt = null;
      state.pauseRequested = false;
      state.lastError = null;
      if (!ready) {
        state.phase = state.characters.every((character) => character.status === "completed") ? "scenes" : "characters";
        state.status = state.status === "idle" ? "idle" : "paused";
      } else if (state.characters.every((character) => character.status === "completed")
        && state.jobs.every((job) => job.status === "completed")) {
        state.phase = "completed";
        state.status = "completed";
      }
    });
  }

  if (message.type === "PREPARE_MANUAL_SCENE") {
    const current = await readState();
    if (current.activeJobId || ["running", "waiting", "pausing"].includes(current.status)) {
      throw new Error("자동 큐를 먼저 중단한 뒤 수동 프롬프트를 준비해 주세요.");
    }
    const jobId = String(message.jobId || "");
    const job = current.jobs.find((entry) => entry.id === jobId);
    if (!job || job.status === "completed") throw new Error("수동으로 준비할 장면 작업을 찾지 못했습니다.");
    if (current.characters.some((character) => character.status !== "completed")) {
      throw new Error("수동 프롬프트를 보내기 전에 모든 캐릭터가 Flow에 준비되어야 합니다.");
    }
    const tab = await findFlowTab(current.tabId);
    if (!tab?.id) throw new Error("수동 프롬프트를 보낼 열린 Flow 프로젝트 탭이 없습니다.");

    const response = await sendToTab(tab.id, {
      type: "PREPARE_MANUAL_SCENE_PROMPT",
      job: sceneMessagePayload(job),
      options: current.options
    });
    if (!response?.accepted || !response?.prepared) {
      throw new Error(response?.error || "Flow 입력창에 수동 프롬프트를 준비하지 못했습니다.");
    }
    await chrome.alarms.clear(QUEUE_ALARM);
    return updateState((state) => {
      const target = state.jobs.find((entry) => entry.id === jobId);
      if (!target) return;
      target.status = "manual";
      target.stage = "Flow 입력 완료 · 직접 생성 후 완료 처리";
      target.progress = Math.max(20, Number(target.progress || 0));
      target.error = null;
      state.status = "paused";
      state.phase = "scenes";
      state.manualPause = true;
      state.pauseRequested = false;
      state.nextRunAt = null;
      state.tabId = tab.id;
      state.flowConnected = true;
      state.lastError = null;
    });
  }

  if (message.type === "COMPLETE_MANUAL_SCENE") {
    return updateState((state) => {
      if (state.activeJobId) throw new Error("현재 진행 중인 작업이 끝난 뒤 완료 처리해 주세요.");
      const jobId = String(message.jobId || "");
      const job = state.jobs.find((entry) => entry.id === jobId);
      if (!job || job.status !== "manual") throw new Error("Flow 입력이 준비된 수동 작업만 완료 처리할 수 있습니다.");
      setJobReady(state, jobId, true, "사용자 확인: Flow 생성 완료");
      state.manualPause = true;
      state.pauseRequested = false;
      state.nextRunAt = null;
      state.activeJobId = null;
      state.activeTaskType = null;
      state.lastError = null;
      state.phase = state.jobs.every((entry) => entry.status === "completed") ? "completed" : "scenes";
      state.status = state.phase === "completed" ? "completed" : "paused";
    });
  }

  if (message.type === "UPDATE_OPTIONS") {
    return updateState((state) => {
      if (state.activeJobId) throw new Error("진행 중에는 생성 설정을 변경할 수 없습니다.");
      const previousModel = state.options.model;
      state.options = normalizeOptions({ ...state.options, ...message.options });
      if (state.options.model === previousModel) return;

      const quotaPattern = /(?:quota|limit|한도|다른\s*모델)/i;
      if (quotaPattern.test(String(state.lastError || ""))) state.lastError = null;
      for (const task of [...(state.characters || []), ...(state.jobs || [])]) {
        if (task.status !== "failed" || !quotaPattern.test(String(task.error || ""))) continue;
        task.stage = `${state.options.model}로 재시도 가능`;
        task.error = `${state.options.model}로 변경했습니다. 실패 작업 다시 실행을 눌러 주세요.`;
      }
    });
  }

  if (message.type === "START_QUEUE" || message.type === "RESUME_QUEUE") {
    const beforeSync = await readState();
    if (!beforeSync.activeJobId && beforeSync.characters.some((character) => character.status !== "completed")) {
      await synchronizeFlowCharacters();
    }
    const state = await updateState((draft) => {
      if (draft.activeJobId) return;
      if (!hasPendingTasks(draft)) throw new Error("실행할 대기 작업이 없습니다.");
      draft.status = "running";
      draft.pauseRequested = false;
      draft.manualPause = false;
      draft.lastError = null;
      draft.nextRunAt = null;
      draft.lastFlowSceneImageCount = null;
      draft.lastFlowImageSyncAt = null;
    });
    await chrome.alarms.clear(QUEUE_ALARM);
    void launchNextJob();
    return state;
  }

  if (message.type === "PAUSE_QUEUE") {
    const beforePause = await readState();
    const interruptedTaskId = beforePause.activeJobId;
    const interruptedTaskType = beforePause.activeTaskType;
    const state = await updateState((draft) => {
      draft.manualPause = true;
      draft.pauseRequested = false;
      if (interruptedTaskId) {
        if (interruptedTaskType === "character") {
          setCharacterReady(draft, interruptedTaskId, false, "대기열 중단 · 다시 생성 대기");
        } else {
          const interruptedJob = draft.jobs.find((job) => job.id === interruptedTaskId);
          if (interruptedJob?.supplementing) {
            const existingCount = uniqueAssets(interruptedJob.resultAssets || []).length;
            interruptedJob.status = "completed";
            interruptedJob.stage = `완료 · 보충 중단 · 기존 ${existingCount}장 유지`;
            interruptedJob.progress = 100;
            interruptedJob.imagesGenerated = existingCount;
            clearSceneSupplementRun(interruptedJob);
          } else {
            setJobReady(draft, interruptedTaskId, false, "대기열 중단 · 다시 생성 대기");
          }
        }
        draft.activeJobId = null;
        draft.activeTaskType = null;
      } else {
        draft.activeJobId = null;
        draft.activeTaskType = null;
      }
      draft.status = "paused";
      draft.nextRunAt = null;
    });
    await chrome.alarms.clear(QUEUE_ALARM);
    if (interruptedTaskId && state.tabId) {
      sendToTab(state.tabId, {
        type: "STOP_FLOW_TASK",
        taskId: interruptedTaskId,
        taskType: interruptedTaskType
      }).catch(() => {});
    }
    return state;
  }

  if (message.type === "RETRY_FAILED") {
    return updateState((state) => {
      if (state.activeJobId) throw new Error("현재 생성이 끝난 뒤 재시도해 주세요.");
      if (!retryFailedTasks(state)) throw new Error("재시도할 실패 작업이 없습니다.");
    });
  }

  if (message.type === "RETRY_CHARACTER") {
    return updateState((state) => {
      const characterId = String(message.characterId || "");
      const character = state.characters.find((entry) => entry.id === characterId);
      if (state.activeJobId && !(state.activeJobId === characterId && character?.status === "review")) {
        throw new Error("현재 생성이 끝난 뒤 재시도해 주세요.");
      }
      if (character?.status === "review") {
        setCharacterReady(state, characterId, false, "재생성 대기");
        state.status = "paused";
        state.phase = "characters";
        state.activeJobId = null;
        state.activeTaskType = null;
        state.nextRunAt = null;
        state.pauseRequested = false;
        state.lastError = null;
        return;
      }
      if (!retryFailedTasks(state, { characterId, jobId: "__none__" })) {
        throw new Error("재시도할 실패 캐릭터를 찾지 못했습니다.");
      }
    });
  }

  if (message.type === "CONFIRM_CHARACTER") {
    const current = await readState();
    if (current.activeTaskType !== "character" || current.activeJobId !== message.characterId) {
      throw new Error("등록 확인을 기다리는 캐릭터가 없습니다.");
    }
    const character = current.characters.find((entry) => entry.id === message.characterId);
    if (character?.status !== "review") throw new Error("이 캐릭터는 수동 확인 상태가 아닙니다.");
    return completeTask(message.characterId, "character", character.detectedImages || 1);
  }

  if (message.type === "REMOVE_JOB") {
    return updateState((state) => {
      if (state.activeJobId) throw new Error("진행 중에는 작업을 삭제할 수 없습니다.");
      state.jobs = state.jobs
        .filter((job) => job.id !== message.jobId)
        .map((job, index) => ({ ...job, index }));
      if (!state.jobs.length) state.status = "idle";
    });
  }

  if (message.type === "RESET_QUEUE") {
    await chrome.alarms.clear(QUEUE_ALARM);
    return updateState((state) => {
      if (state.activeJobId) throw new Error("현재 생성이 끝난 뒤 큐를 초기화해 주세요.");
      const fresh = createInitialState();
      fresh.options = state.options;
      fresh.tabId = state.tabId;
      fresh.pageSessionId = state.pageSessionId;
      fresh.flowConnected = state.flowConnected;
      Object.assign(state, fresh);
    });
  }

  if (message.type === "OPEN_FLOW") {
    const state = await readState();
    const existing = await findFlowTab(state.tabId);
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
      return { opened: true, tabId: existing.id };
    }
    const tab = await chrome.tabs.create({ url: "https://flow.google.com/" });
    return { opened: true, tabId: tab.id };
  }

  if (message.type === "OPEN_ASSET") {
    const url = String(message.url || "");
    if (!isFlowAssetUrl(url)) throw new Error("Flow 이미지 상세보기 주소가 올바르지 않습니다.");
    const tab = await chrome.tabs.create({ url, active: true });
    return { opened: true, tabId: tab.id };
  }

  if (message.type === "OPEN_IMAGE") {
    const url = String(message.url || "");
    const state = await readState();
    if (!isTrackedImageUrl(state, url)) throw new Error("현재 큐에 연결된 이미지가 아닙니다.");
    const tab = await chrome.tabs.create({ url, active: true });
    return { opened: true, tabId: tab.id };
  }

  if (message.type === "CHECK_FLOW") {
    const state = await readState();
    const flowProject = await findCurrentFlowProject(state.tabId, { preferActive: true });
    if (!flowProject?.tab?.id) return { connected: false, error: "열린 Flow 프로젝트 탭이 없습니다." };
    try {
      const diagnostics = await sendToTab(flowProject.tab.id, { type: "GET_FLOW_DIAGNOSTICS" });
      let profile = findProjectCharacterProfile(await readProjectHistory(), flowProject.projectId);
      let restoredMappingCount = 0;
      let restoredCharacterCount = 0;
      let importedFromFlow = false;
      const projectChanged = Boolean(state.flowProjectId && state.flowProjectId !== flowProject.projectId);
      const stateIsEmpty = !state.jobs.length && !state.characters.length;

      // Older projects may predate project-history snapshots. Discover the
      // registered Flow characters so an intro/thumbnail run can still reuse
      // them without requiring the old scene prompt file to be dropped again.
      // Exact scene mappings remain unavailable until a mapping snapshot exists.
      if (!profile && !state.activeJobId && (stateIsEmpty || projectChanged)) {
        try {
          const imported = await loadCurrentProjectCharacters();
          importedFromFlow = Boolean(imported?.importedFromFlow);
          profile = findProjectCharacterProfile(await readProjectHistory(), flowProject.projectId);
        } catch {
          // Keep CHECK_FLOW useful even when the current Flow surface cannot
          // expose its character library yet; the normal file-drop recovery
          // path can retry discovery later.
        }
      }
      await updateState((draft) => {
        draft.flowConnected = Boolean(diagnostics?.ready);
        if (draft.activeJobId) return;
        const hadNoProject = !draft.flowProjectId;
        const draftProjectChanged = Boolean(draft.flowProjectId && draft.flowProjectId !== flowProject.projectId);
        const draftStateIsEmpty = !draft.jobs.length && !draft.characters.length;
        draft.tabId = flowProject.tab.id;
        draft.flowProjectId = flowProject.projectId;
        draft.flowProjectTitle = flowProject.projectTitle;
        const hasSavedMappings = Boolean(profile?.mappingJobs?.length);
        const noCurrentJobs = !draft.jobs.length;
        const shouldRestore = draftStateIsEmpty
          || draftProjectChanged
          || (hadNoProject && Boolean(profile))
          || (noCurrentJobs && hasSavedMappings);
        if (!shouldRestore) return;

        draft.assetCatalog = draftProjectChanged ? [] : draft.assetCatalog;
        if (profile) {
          draft.characters = createCharacters(profile.characters, { alreadyRegistered: true });
          draft.jobs = createRestoredMappingJobs(profile);
          draft.queueMode = "scene";
          draft.executionMode = "automatic";
          draft.status = draft.jobs.length ? "completed" : "idle";
          draft.phase = draft.jobs.length ? "scenes" : draft.characters.length ? "characters" : "idle";
          draft.activeJobId = null;
          draft.activeTaskType = null;
          draft.nextRunAt = null;
          draft.pauseRequested = false;
          draft.manualPause = false;
          draft.lastFlowRegisteredKeys = Array.isArray(profile.registeredKeys) ? profile.registeredKeys : [];
          draft.lastFlowSyncAt = null;
          draft.lastFlowSceneImageCount = null;
          draft.lastFlowImageSyncAt = null;
          draft.lastError = null;
          restoredCharacterCount = draft.characters.length;
          restoredMappingCount = draft.jobs.length;
        }
      });
      return {
        connected: Boolean(diagnostics?.ready),
        tabId: flowProject.tab.id,
        diagnostics,
        project: {
          projectId: flowProject.projectId,
          projectTitle: flowProject.projectTitle,
          savedProfile: projectProfileSummary(profile),
          restoredCharacterCount,
          restoredMappingCount,
          importedFromFlow,
          activeQueueProjectId: state.flowProjectId || ""
        }
      };
    } catch (error) {
      return { connected: false, error: String(error?.message || error) };
    }
  }

  throw new Error(`지원하지 않는 메시지입니다: ${message.type}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type || message.target === "offscreen" || message.type === "STATE_UPDATED" || message.type === "PROJECT_DOWNLOAD_PROGRESS") return false;
  const isFlowEvent = message.type.startsWith("FLOW_");
  const handler = isFlowEvent ? handleFlowEvent(message, sender) : handleUiMessage(message);
  Promise.resolve(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isFlowUrl(changeInfo.url)) return;
  if (characterDetailFromFlowUrl(changeInfo.url)) {
    void captureActiveCharacterDetailRoute(tabId, changeInfo.url);
  } else {
    void restoreActiveCharacterDetailRoute(tabId, changeInfo.url);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== QUEUE_ALARM) return;
  void updateState((state) => {
    if (state.status !== "waiting" || state.activeJobId) return;
    state.status = "running";
    state.nextRunAt = null;
  }).then(() => launchNextJob());
});

async function recoverQueue() {
  const state = await readState();
  syncPowerState(state);
  if (state.status === "paused" && !state.manualPause && !state.activeJobId) {
    const retryableFailure = state.jobs.find((job) => job.status === "failed" && !isBlockingFlowError(job.error));
    if (retryableFailure) {
      await scheduleSceneAutomaticRetry(retryableFailure.error || "중단된 장면 작업을 자동 복구합니다.", retryableFailure.id);
      return;
    }
  }
  if (state.status === "waiting" && state.nextRunAt) {
    if (state.nextRunAt > Date.now()) {
      await chrome.alarms.create(QUEUE_ALARM, { when: state.nextRunAt });
    } else {
      await updateState((draft) => {
        draft.status = "running";
        draft.nextRunAt = null;
      });
      void launchNextJob();
    }
  } else if (state.status === "running" && !state.activeJobId) {
    void launchNextJob();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  void recoverQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void recoverQueue();
});

void recoverQueue();
