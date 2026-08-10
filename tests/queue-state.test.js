import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_RETRY_BASE_MS,
  AUTO_RETRY_MAX_MS,
  MAX_AUTOMATIC_RETRIES,
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  RANDOM_DELAY_MAX_MS,
  SUPPORTED_MODELS,
  applyRegisteredCharacterKeys,
  carryForwardCompletedTasks,
  canAutomaticallyRetry,
  createCharacters,
  createInitialState,
  createJobs,
  findNextTask,
  findNextJob,
  hasPendingTasks,
  hydrateState,
  isBlockingFlowError,
  normalizeOptions,
  nextTaskDelayMs,
  automaticRetryDelayMs,
  prepareSceneAutomaticRetry,
  prepareSceneNavigationRecovery,
  markSceneFailedAndContinue,
  retryFailedTasks,
  rollbackUnverifiedCompletedScenes,
  setCharacterReady,
  setJobReady,
  summarizeState
} from "../lib/queue-state.js";

test("the request interval cannot be configured below 60 seconds", () => {
  assert.equal(normalizeOptions({ delayMs: 1_000 }).delayMs, MIN_DELAY_MS);
  assert.equal(normalizeOptions({ delayMs: 90_000 }).delayMs, 90_000);
});

test("Flow image settings accept supported ratio and image count values", () => {
  const options = normalizeOptions({
    model: "another model",
    aspectRatio: "1:1",
    imagesPerPrompt: 4
  });
  assert.equal(options.model, "Nano Banana 2");
  assert.equal(options.aspectRatio, "1:1");
  assert.equal(options.imagesPerPrompt, 4);
  assert.equal(normalizeOptions({ aspectRatio: "invalid", imagesPerPrompt: 9 }).aspectRatio, "16:9");
  assert.equal(normalizeOptions({ aspectRatio: "invalid", imagesPerPrompt: 9 }).imagesPerPrompt, 4);
});

test("delay settings stay within the UI range and random mode uses 60 to 90 seconds", () => {
  assert.equal(normalizeOptions({ delayMs: 1_000 }).delayMs, MIN_DELAY_MS);
  assert.equal(normalizeOptions({ delayMs: 600_000 }).delayMs, MAX_DELAY_MS);
  assert.equal(nextTaskDelayMs({ randomDelay: true }, () => 0), MIN_DELAY_MS);
  assert.equal(nextTaskDelayMs({ randomDelay: true }, () => 0.99999), RANDOM_DELAY_MAX_MS);
});

test("all supported Flow image models are preserved", () => {
  assert.deepEqual(SUPPORTED_MODELS, [
    "Nano Banana Pro",
    "Nano Banana 2",
    "Nano Banana 2 Lite"
  ]);
  for (const model of SUPPORTED_MODELS) {
    assert.equal(normalizeOptions({ model }).model, model);
  }
});

test("automatic retry delays back off predictably", () => {
  assert.equal(automaticRetryDelayMs(1), AUTO_RETRY_BASE_MS);
  assert.equal(automaticRetryDelayMs(2), 30_000);
  assert.equal(automaticRetryDelayMs(3), AUTO_RETRY_MAX_MS);
  assert.equal(automaticRetryDelayMs(100), AUTO_RETRY_MAX_MS);
});

test("scene failures allow one automatic retry and then become final failures", () => {
  const state = createInitialState();
  state.jobs = createJobs([
    { title: "scene 1", prompt: "scene 1" },
    { title: "scene 2", prompt: "scene 2" }
  ]);
  const active = state.jobs[0];
  state.activeJobId = active.id;
  state.activeTaskType = "scene";
  state.status = "running";
  active.status = "generating";
  active.resultAssets = [{ assetId: "failed-asset", url: "https://example.test/failed" }];

  assert.equal(MAX_AUTOMATIC_RETRIES, 1);
  assert.equal(canAutomaticallyRetry(active), true);
  prepareSceneAutomaticRetry(active, "guardrail");
  assert.equal(active.autoRetryCount, 1);
  assert.equal(canAutomaticallyRetry(active), false);

  markSceneFailedAndContinue(state, active.id, "가드레일로 생성이 차단되었습니다.", 1_000);

  assert.equal(active.status, "failed");
  assert.equal(active.resultAssets.length, 0);
  assert.equal(active.error, "가드레일로 생성이 차단되었습니다.");
  assert.equal(state.activeJobId, null);
  assert.equal(state.status, "waiting");
  assert.equal(state.jobs[1].status, "pending");
  assert.equal(state.nextRunAt, 61_000);
});

test("only user-action Flow errors block unattended retries", () => {
  assert.equal(isBlockingFlowError("@nurse가 실제 캐릭터 참조 칩으로 연결되지 않았습니다."), false);
  assert.equal(isBlockingFlowError("This prompt violates the safety guidelines."), false);
  assert.equal(isBlockingFlowError("Flow에서 CAPTCHA 사용자 확인이 필요합니다."), true);
  assert.equal(isBlockingFlowError("not enough credits"), true);
  assert.equal(isBlockingFlowError("Nano Banana 2 생성 일일 한도에 도달했습니다."), true);
});

test("daily-limit recovery rolls back only the consecutive completed scenes without image URLs", () => {
  const state = createInitialState();
  state.jobs = createJobs(Array.from({ length: 6 }, (_, index) => ({
    title: `scene ${index + 1}`,
    prompt: `prompt ${index + 1}`
  })));
  for (const job of state.jobs.slice(0, 5)) {
    job.status = "completed";
    job.progress = 100;
    job.imagesGenerated = 2;
  }
  state.jobs[0].resultAssets = [{ url: "https://example.test/1a" }, { url: "https://example.test/1b" }];
  state.jobs[1].resultAssets = [{ url: "https://example.test/2a" }, { url: "https://example.test/2b" }];
  state.jobs[5].status = "generating";

  const rolledBack = rollbackUnverifiedCompletedScenes(state, state.jobs[5].id, "daily limit");

  assert.deepEqual(rolledBack, state.jobs.slice(2, 5).map((job) => job.id));
  assert.deepEqual(state.jobs.slice(0, 2).map((job) => job.status), ["completed", "completed"]);
  assert.deepEqual(state.jobs.slice(2, 5).map((job) => job.status), ["pending", "pending", "pending"]);
  assert.deepEqual(state.jobs.slice(2, 5).map((job) => job.imagesGenerated), [0, 0, 0]);
});

test("jobs are created in source order and next pending job is stable", () => {
  const jobs = createJobs([
    { title: "첫 작업", prompt: "first" },
    { title: "둘째 작업", prompt: "second" }
  ]);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].index, 0);
  assert.equal(findNextJob({ jobs }).prompt, "first");

  jobs[0].status = "completed";
  assert.equal(findNextJob({ jobs }).prompt, "second");
});

test("queue summary counts completed images and overall progress", () => {
  const state = createInitialState();
  state.jobs = createJobs([
    { title: "one", prompt: "one" },
    { title: "two", prompt: "two" }
  ]);
  state.characters = createCharacters([
    { key: "hero", prompt: "hero" },
    { key: "villain", prompt: "villain" }
  ]);
  state.jobs[0].status = "completed";
  state.jobs[0].imagesGenerated = 2;
  state.characters[0].status = "completed";

  assert.deepEqual(summarizeState(state), {
    total: 2,
    completed: 1,
    failed: 0,
    pending: 1,
    generatedImages: 2,
    percent: 50,
    charactersTotal: 2,
    charactersCompleted: 1,
    charactersFailed: 0,
    charactersReview: 0,
    totalTasks: 4,
    completedTasks: 2,
    remainingTasks: 2
  });
});

test("queue summary reports total work from characters and scene jobs", () => {
  const state = createInitialState();
  state.characters = createCharacters(Array.from({ length: 5 }, (_, index) => ({
    key: `character-${index + 1}`,
    prompt: `character ${index + 1}`
  })));
  state.jobs = createJobs(Array.from({ length: 40 }, (_, index) => ({
    title: `scene ${index + 1}`,
    prompt: `scene ${index + 1}`
  })));

  assert.equal(summarizeState(state).totalTasks, 45);
  assert.equal(summarizeState(state).completedTasks, 0);
  assert.equal(summarizeState(state).remainingTasks, 45);
});

test("a Flow media scan replaces stale queue image counts", () => {
  const state = createInitialState();
  state.jobs = createJobs(Array.from({ length: 4 }, (_, index) => ({
    title: `scene ${index + 1}`,
    prompt: `prompt ${index + 1}`
  })));
  for (const job of state.jobs) job.status = "completed";
  state.jobs[0].imagesGenerated = 2;
  state.lastFlowSceneImageCount = 8;

  assert.equal(summarizeState(state).generatedImages, 8);
});

test("hydration restores defaults around a partial stored state", () => {
  const state = hydrateState({ status: "paused", options: { delayMs: 10_000 } });
  assert.equal(state.status, "paused");
  assert.deepEqual(state.jobs, []);
  assert.equal(state.options.delayMs, MIN_DELAY_MS);
});

test("hydration preserves the selected intro queue mode", () => {
  assert.equal(hydrateState({ queueMode: "intro" }).queueMode, "intro");
  assert.equal(hydrateState({ queueMode: "unexpected" }).queueMode, "scene");
});

test("hydration preserves manual execution mode only when explicitly selected", () => {
  assert.equal(hydrateState({ executionMode: "manual" }).executionMode, "manual");
  assert.equal(hydrateState({ executionMode: "unexpected" }).executionMode, "automatic");
});

test("hydration adds downloadable result arrays to older queue state", () => {
  const state = hydrateState({
    jobs: [{ id: "old-job", prompt: "scene" }],
    characters: [{ id: "old-character", key: "hero", prompt: "portrait" }]
  });
  assert.deepEqual(state.jobs[0].resultAssets, []);
  assert.deepEqual(state.characters[0].resultAssets, []);
});

test("hydration bounds polluted scene result arrays and records overflow", () => {
  const assets = Array.from({ length: 32 }, (_, index) => ({ url: `https://example.test/${index}` }));
  const state = hydrateState({ jobs: [{ id: "polluted-job", prompt: "scene", resultAssets: assets }] });
  assert.equal(state.jobs[0].resultAssets.length, 4);
  assert.equal(state.jobs[0].resultAssetOverflowCount, 28);
});

test("character tasks run before scene jobs", () => {
  const state = createInitialState();
  state.characters = createCharacters([
    { key: "hero", displayName: "주인공", prompt: "portrait", referenceCount: 2 }
  ]);
  state.jobs = createJobs([
    { title: "scene", prompt: "@hero walking", characterRefs: ["hero"] }
  ]);

  assert.equal(hasPendingTasks(state), true);
  assert.equal(findNextTask(state).type, "character");
  state.characters[0].status = "completed";
  assert.equal(findNextTask(state).type, "scene");
  assert.deepEqual(state.jobs[0].characterRefs, ["hero"]);
  assert.equal(state.jobs[0].sourceMode, "scene");
});

test("already registered characters start completed", () => {
  const characters = createCharacters([
    { key: "hero", displayName: "주인공", prompt: "portrait" }
  ], { alreadyRegistered: true });
  assert.equal(characters[0].status, "completed");
  assert.equal(characters[0].progress, 100);
});

test("a failed character can be retried without resetting other tasks", () => {
  const state = createInitialState();
  state.characters = createCharacters([
    { key: "first", prompt: "first portrait" },
    { key: "second", prompt: "second portrait" }
  ]);
  state.jobs = createJobs([{ title: "scene", prompt: "scene" }]);
  state.characters[0].status = "failed";
  state.characters[0].progress = 42;
  state.characters[0].error = "submit disabled";
  state.characters[1].status = "completed";
  state.characters[1].progress = 100;
  state.status = "paused";

  const count = retryFailedTasks(state, {
    characterId: state.characters[0].id,
    jobId: "__none__"
  });

  assert.equal(count, 1);
  assert.equal(state.characters[0].status, "pending");
  assert.equal(state.characters[0].progress, 0);
  assert.equal(state.characters[0].error, null);
  assert.equal(state.characters[1].status, "completed");
  assert.equal(findNextTask(state).item.id, state.characters[0].id);
});

test("retry all resets failed characters and scene jobs", () => {
  const state = createInitialState();
  state.characters = createCharacters([{ key: "hero", prompt: "portrait" }]);
  state.jobs = createJobs([{ title: "scene", prompt: "scene" }]);
  state.characters[0].status = "failed";
  state.jobs[0].status = "failed";
  state.lastError = "failed";

  assert.equal(retryFailedTasks(state), 2);
  assert.equal(state.characters[0].status, "pending");
  assert.equal(state.jobs[0].status, "pending");
  assert.equal(state.lastError, null);
});

test("scene retries clear stale direct-generation recovery metadata", () => {
  const state = createInitialState();
  state.jobs = createJobs([{ title: "scene", prompt: "scene" }]);
  state.jobs[0].status = "failed";
  state.jobs[0].generationMode = "direct";
  state.jobs[0].generationPercentages = [40, 35];
  state.jobs[0].baselineMedia = ["img:old-result"];
  state.jobs[0].baselineCapturedAt = 1200;
  state.jobs[0].requestSubmittedAt = 1234;
  state.jobs[0].recoveryAttempts = 2;
  state.jobs[0].lastRecoveryAt = 1300;
  state.jobs[0].autoRetryCount = 3;
  state.jobs[0].lastRetryAt = 1400;
  state.jobs[0].lastTransientError = "temporary";

  assert.equal(retryFailedTasks(state), 1);
  assert.equal(state.jobs[0].status, "pending");
  assert.equal(state.jobs[0].generationMode, "direct");
  assert.deepEqual(state.jobs[0].generationPercentages, []);
  assert.deepEqual(state.jobs[0].baselineMedia, []);
  assert.equal(state.jobs[0].baselineCapturedAt, null);
  assert.equal(state.jobs[0].requestSubmittedAt, null);
  assert.equal(state.jobs[0].recoveryAttempts, 0);
  assert.equal(state.jobs[0].lastRecoveryAt, null);
  assert.equal(state.jobs[0].autoRetryCount, 0);
  assert.equal(state.jobs[0].lastRetryAt, null);
  assert.equal(state.jobs[0].lastTransientError, null);
});

test("scene jobs persist navigation recovery metadata separately from submit state", () => {
  const [job] = createJobs([{ title: "scene", prompt: "scene" }]);

  assert.equal(job.baselineCapturedAt, null);
  assert.deepEqual(job.generationPercentages, []);
  assert.equal(job.requestSubmittedAt, null);
  assert.equal(job.recoveryAttempts, 0);
  assert.equal(job.lastRecoveryAt, null);
  assert.equal(job.autoRetryCount, 0);
  assert.equal(job.lastRetryAt, null);
  assert.equal(job.lastTransientError, null);
});

test("a character binding failure becomes an unattended scene retry", () => {
  const [job] = createJobs([{ title: "scene", prompt: "@nurse scene" }]);
  job.status = "configuring";
  job.progress = 18;

  const retry = prepareSceneAutomaticRetry(job, "@nurse reference chip missing", 5000);

  assert.deepEqual(retry, { delayMs: AUTO_RETRY_BASE_MS, submitted: false });
  assert.equal(job.status, "pending");
  assert.equal(job.progress, 0);
  assert.equal(job.autoRetryCount, 1);
  assert.equal(job.lastRetryAt, 5000);
  assert.match(job.stage, /자동 재시도 1회/);
});

test("a submitted scene retry preserves its baseline and resumes monitoring", () => {
  const [job] = createJobs([{ title: "scene", prompt: "scene" }]);
  job.status = "generating";
  job.progress = 42;
  job.baselineMedia = ["img:before"];
  job.baselineCapturedAt = 4000;
  job.requestSubmittedAt = 4500;

  const retry = prepareSceneAutomaticRetry(job, "temporary monitor error", 5000);

  assert.equal(retry.submitted, true);
  assert.equal(job.status, "pending");
  assert.equal(job.progress, 42);
  assert.deepEqual(job.baselineMedia, ["img:before"]);
  assert.equal(job.requestSubmittedAt, 4500);
  assert.match(job.stage, /기존 생성 추적/);
});

test("a pre-submit Flow reload stays active and inspects the page instead of failing", () => {
  const [job] = createJobs([{ title: "scene", prompt: "scene" }]);
  job.status = "configuring";
  job.progress = 12;
  job.error = "stale error";

  assert.equal(prepareSceneNavigationRecovery(job, 5000), "inspect");
  assert.equal(job.status, "configuring");
  assert.equal(job.stage, "Flow 화면 재연결 · 현재 생성 상태 확인 중");
  assert.equal(job.progress, 18);
  assert.equal(job.recoveryAttempts, 1);
  assert.equal(job.lastRecoveryAt, 5000);
  assert.equal(job.error, null);
});

test("a post-submit Flow reload resumes generation monitoring", () => {
  const [job] = createJobs([{ title: "scene", prompt: "scene" }]);
  job.status = "generating";
  job.progress = 24;
  job.requestSubmittedAt = 4500;

  assert.equal(prepareSceneNavigationRecovery(job, 5000), "monitor");
  assert.equal(job.status, "generating");
  assert.equal(job.progress, 28);
  assert.equal(job.recoveryAttempts, 1);
});

test("Flow character scan marks only matching keys completed", () => {
  const state = createInitialState();
  state.characters = createCharacters([
    { key: "saebyeol", prompt: "portrait one" },
    { key: "myeong", prompt: "portrait two" },
    { key: "nurse", prompt: "portrait three" }
  ]);

  assert.deepEqual(applyRegisteredCharacterKeys(state, ["SAEBYEOL", "myeong"]), ["saebyeol", "myeong"]);
  assert.equal(state.characters[0].status, "completed");
  assert.equal(state.characters[1].status, "completed");
  assert.equal(state.characters[2].status, "pending");
  assert.equal(findNextTask(state).item.key, "nurse");
});

test("manual character readiness checkbox changes the queue start point", () => {
  const state = createInitialState();
  state.characters = createCharacters([
    { key: "first", prompt: "portrait one" },
    { key: "second", prompt: "portrait two" }
  ]);

  assert.equal(setCharacterReady(state, state.characters[0].id, true), true);
  assert.equal(findNextTask(state).item.key, "second");
  assert.equal(setCharacterReady(state, state.characters[0].id, false), true);
  assert.equal(findNextTask(state).item.key, "first");
});

test("manual scene readiness checkbox skips completed scene jobs", () => {
  const state = createInitialState();
  state.jobs = createJobs([
    { number: 1, title: "first", prompt: "first scene" },
    { number: 2, title: "second", prompt: "second scene" }
  ]);

  assert.equal(setJobReady(state, state.jobs[0].id, true), true);
  assert.equal(findNextTask(state).item.number, 2);
  assert.equal(setJobReady(state, state.jobs[0].id, false), true);
  assert.equal(findNextTask(state).item.number, 1);
});

test("reapplying the same queue carries forward completed tasks", () => {
  const previous = createInitialState();
  previous.characters = createCharacters([{ key: "hero", prompt: "portrait" }]);
  previous.jobs = createJobs([{ number: 1, title: "scene", prompt: "@hero scene" }]);
  setCharacterReady(previous, previous.characters[0].id, true, "generated");
  previous.jobs[0].status = "completed";
  previous.jobs[0].progress = 100;
  previous.jobs[0].imagesGenerated = 2;

  const next = {
    characters: createCharacters([{ key: "hero", prompt: "portrait" }]),
    jobs: createJobs([{ number: 1, title: "scene", prompt: "@hero scene" }])
  };
  carryForwardCompletedTasks(next, previous);

  assert.equal(next.characters[0].status, "completed");
  assert.equal(next.jobs[0].status, "completed");
  assert.equal(next.jobs[0].imagesGenerated, 2);
});
