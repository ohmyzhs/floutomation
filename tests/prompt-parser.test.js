import test from "node:test";
import assert from "node:assert/strict";

import { analyzeIntroAssets, analyzePrompts, formatLabel } from "../lib/prompt-parser.js";

test("Markdown heading sections become independent prompts", () => {
  const result = analyzePrompts(`
# 전체 이미지 프롬프트

## 비 오는 골목
시네마틱한 네온 골목, 빗물 반사, 와이드 숏

## 해변의 석양
주황빛 석양 아래 고요한 바다, 35mm 필름
  `);

  assert.equal(result.format, "markdown-headings");
  assert.equal(result.prompts.length, 2);
  assert.equal(result.prompts[0].title, "비 오는 골목");
  assert.match(result.prompts[1].prompt, /고요한 바다/);
  assert.equal(result.totalImages, 4);
});

test("numbered lists keep indented continuation lines", () => {
  const result = analyzePrompts(`
1. 우주 정거장의 정원
   새벽의 푸른 조명, 초광각 렌즈
2. 사막의 유리 도시
   정오의 강한 태양, 대칭 구도
  `);

  assert.equal(result.format, "markdown-list");
  assert.equal(result.prompts.length, 2);
  assert.match(result.prompts[0].prompt, /초광각 렌즈/);
  assert.match(result.prompts[1].prompt, /대칭 구도/);
});

test("prompt labels take precedence over blank paragraph splitting", () => {
  const result = analyzePrompts(`
Prompt 1: A red paper boat on a black lake

soft fog and rim light

프롬프트 2: 거대한 달 아래 작은 오두막

눈 내리는 밤
  `);

  assert.equal(result.format, "prompt-labels");
  assert.equal(result.prompts.length, 2);
  assert.match(result.prompts[0].prompt, /soft fog/);
  assert.match(result.prompts[1].prompt, /눈 내리는 밤/);
});

test("frontmatter is ignored and delimiter blocks are supported", () => {
  const result = analyzePrompts(`---
title: image batch
---
첫 번째 이미지 프롬프트
---
두 번째 이미지 프롬프트`);

  assert.equal(result.format, "delimiters");
  assert.deepEqual(result.prompts.map((item) => item.prompt), [
    "첫 번째 이미지 프롬프트",
    "두 번째 이미지 프롬프트"
  ]);
});

test("a single paragraph stays one prompt", () => {
  const result = analyzePrompts("A cinematic mountain village at dawn");
  assert.equal(result.format, "single");
  assert.equal(result.prompts.length, 1);
  assert.equal(formatLabel(result.format), "단일 프롬프트");
});

test("an empty source returns a useful warning", () => {
  const result = analyzePrompts("  \n\n  ");
  assert.equal(result.prompts.length, 0);
  assert.equal(result.totalImages, 0);
  assert.ok(result.warnings.length > 0);
});

test("Flow character documents map character definitions, scripts, and scene references", () => {
  const result = analyzePrompts(`
STEP 1
=== hero (주인공, a brave merchant / 챕터 1~2) ===
=== hero UPLOAD ===
Single figure portrait of a brave merchant on a neutral gray background

=== elder (원로, a wise elder / 챕터 1~2) ===
=== elder UPLOAD ===
Single figure portrait of a wise elder on a neutral gray background

[대본 1~2]
1. 주인공이 원로를 만났다.
2. 주인공은 길을 떠났다.

===프롬프트===
[영어 프롬프트 1~2]
1. @hero greets @elder in a quiet hall
2. @hero walks along a mountain road
  `);

  assert.equal(result.format, "flow-character-document");
  assert.equal(result.characters.length, 2);
  assert.deepEqual(result.characters.map((character) => character.key), ["hero", "elder"]);
  assert.deepEqual(result.characters.map((character) => character.referenceCount), [2, 1]);
  assert.equal(result.characters[0].displayName, "주인공");
  assert.equal(result.prompts.length, 2);
  assert.deepEqual(result.prompts[0].characterRefs, ["hero", "elder"]);
  assert.equal(result.prompts[0].script, "주인공이 원로를 만났다.");
  assert.equal(result.prompts[1].title, "장면 002 · @hero");
  assert.deepEqual(result.warnings, []);
});

test("Flow documents report unknown @character references", () => {
  const result = analyzePrompts(`
=== hero (주인공, a brave merchant) ===
=== hero UPLOAD ===
Single figure portrait of a brave merchant
[영어 프롬프트 1~1]
1. @missing stands beside @hero
  `);
  assert.equal(result.format, "flow-character-document");
  assert.deepEqual(result.unknownRefs, [{ scene: 1, key: "missing" }]);
  assert.match(result.warnings[0], /@missing/);
});

test("intro-hook mode extracts only each scene's A image prompt and keeps existing character bindings", () => {
  const result = analyzePrompts(`
인트로 강도 곡선

===== 씬 1 =====
[등장] @dongnae / @insun
[A] 이미지 프롬프트 (영어, 복사용):
\`\`\`
@dongnae shields @insun from a crowd, no text, 16:9 aspect ratio.
Drawn illustration in webtoon manhwa comic style.
\`\`\`
[B] 영상 프롬프트:
\`\`\`
CAMERA: Hard push-in. This must not be used as an image prompt.
\`\`\`

===== 씬 2 =====
[A] 이미지 프롬프트:
\`\`\`
Extreme close-up of @insun's injured cheek, no text, 16:9 aspect ratio.
\`\`\`
  `, { mode: "intro", knownCharacterKeys: ["dongnae", "insun"] });

  assert.equal(result.format, "intro-hook-document");
  assert.equal(result.prompts.length, 2);
  assert.deepEqual(result.prompts[0].characterRefs, ["dongnae", "insun"]);
  assert.match(result.prompts[0].prompt, /webtoon manhwa/);
  assert.doesNotMatch(result.prompts[0].prompt, /CAMERA/);
  assert.equal(result.prompts[0].title, "인트로 001 · @dongnae + @insun");
  assert.deepEqual(result.warnings, []);
});

test("intro-hook repeated character mentions stay one binding per character", () => {
  const result = analyzePrompts(`
===== 씬 1 =====
[A] 이미지 프롬프트:
\`\`\`
@seoon faces @jeongin across the cliff. @jeongin stands frozen in the wind.
\`\`\`
  `, { mode: "intro", knownCharacterKeys: ["seoon", "jeongin"] });

  assert.deepEqual(result.prompts[0].characterRefs, ["seoon", "jeongin"]);
});

test("intro-hook mode warns and blocks references absent from the current project", () => {
  const result = analyzePrompts(`
===== 씬 1 =====
[A] 이미지 프롬프트:
\`\`\`
@dongnae stands beside @insun.
\`\`\`
  `, { mode: "intro", knownCharacterKeys: ["dongnae"] });

  assert.deepEqual(result.unknownRefs, [{ scene: 1, key: "insun" }]);
  assert.match(result.warnings[0], /@insun/);
});

test("intro assets combine file scenes and one pasted thumbnail prompt with character bindings", () => {
  const result = analyzeIntroAssets({
    introText: `
===== 씬 1 =====
[A] 이미지 프롬프트:
\`\`\`
@dongnae shields @insun in a market square.
\`\`\``,
    thumbnailText: "@dongnae and @insun stand on the right side of a 16:9 thumbnail composition, no text.",
    knownCharacterKeys: ["dongnae", "insun"]
  });

  assert.equal(result.format, "intro-assets");
  assert.equal(result.totalImages, 4);
  assert.deepEqual(result.prompts.map((prompt) => prompt.sourceMode), ["intro", "thumbnail"]);
  assert.equal(result.prompts[1].title, "썸네일 · @dongnae + @insun");
  assert.deepEqual(result.warnings, []);
});
