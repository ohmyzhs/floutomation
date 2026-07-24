const HEADING_PATTERN = /^\s{0,3}(#{2,4})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]\s+|(\d+)[.)]\s+)(.+)$/;
const LABEL_PATTERN = /^\s*(?:prompt|image\s*prompt|프롬프트|이미지\s*프롬프트)\s*(?:#?\d+)?\s*[:：-]\s*(.*)$/i;
const DELIMITER_PATTERN = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;
const INTRO_SCENE_PATTERN = /^\s*={5,}\s*씬\s*(\d+)\s*={5,}\s*$/i;
const INTRO_IMAGE_PROMPT_PATTERN = /^\s*\[A\]\s*이미지\s*프롬프트(?:\s*\([^)]*\))?\s*[:：-]?\s*$/i;

function cleanText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function stripFrontmatter(text) {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text;
  return text.slice(end + 4).replace(/^\n+/, "");
}

function normalizePrompt(value) {
  return cleanText(value)
    .replace(/^```(?:text|markdown|md)?\s*\n/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
}

function titleFromPrompt(prompt, index) {
  const firstLine = prompt.split("\n").find((line) => line.trim())?.trim() || `이미지 ${index + 1}`;
  const withoutMarkdown = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^[-*+]\s+/, "");
  return withoutMarkdown.length > 54 ? `${withoutMarkdown.slice(0, 51)}…` : withoutMarkdown;
}

function finalize(prompts, format, warnings = [], extras = {}) {
  const items = prompts
    .map((entry) => {
      if (typeof entry === "string") return { prompt: normalizePrompt(entry), heading: "" };
      return {
        ...entry,
        prompt: normalizePrompt(entry.prompt),
        heading: cleanText(entry.heading)
      };
    })
    .filter((entry) => entry.prompt.length > 0)
    .map((entry, index) => ({
      id: `prompt-${index + 1}`,
      index,
      title: entry.heading || titleFromPrompt(entry.prompt, index),
      prompt: entry.prompt,
      number: Number(entry.number || index + 1),
      characterRefs: Array.isArray(entry.characterRefs) ? entry.characterRefs : [],
      script: cleanText(entry.script || ""),
      sourceMode: cleanText(entry.sourceMode || "scene")
    }));

  return {
    format,
    prompts: items,
    characters: [],
    warnings,
    totalImages: items.length * 2,
    ...extras
  };
}

function parseNumberedSection(lines, startIndex, endIndex = lines.length) {
  const items = [];
  let current = null;

  for (const line of lines.slice(startIndex, endIndex)) {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (match) {
      if (current) items.push(current);
      current = { number: Number(match[1]), lines: [match[2]] };
    } else if (current && line.trim() && !/^\s*(?:===|\[)/.test(line)) {
      current.lines.push(line.trim());
    }
  }
  if (current) items.push(current);
  return items.map((item) => ({ number: item.number, text: normalizePrompt(item.lines.join("\n")) }));
}

function parseCharacterMeta(meta) {
  const [identity, chapter = ""] = meta.split(/\s*\/\s*/, 2);
  const commaIndex = identity.indexOf(",");
  return {
    displayName: cleanText(commaIndex >= 0 ? identity.slice(0, commaIndex) : identity),
    description: cleanText(commaIndex >= 0 ? identity.slice(commaIndex + 1) : ""),
    chapterRange: cleanText(chapter)
  };
}

export function parseFlowPromptDocument(rawText) {
  const text = cleanText(rawText);
  const lines = text.split("\n");
  const scriptMarker = lines.findIndex((line) => /^\s*\[대본\s+\d+\s*~\s*\d+\]\s*$/.test(line));
  const sceneMarker = lines.findIndex((line) => /^\s*\[영어\s*프롬프트\s+\d+\s*~\s*\d+\]\s*$/.test(line));
  if (sceneMarker < 0 || !lines.some((line) => /^\s*===\s*[A-Za-z][\w-]*\s+UPLOAD\s*===\s*$/i.test(line))) {
    return null;
  }

  const characters = [];
  const headerPattern = /^\s*===\s*([A-Za-z][\w-]*)\s*\((.+)\)\s*===\s*$/;
  for (let index = 0; index < (scriptMarker >= 0 ? scriptMarker : sceneMarker); index += 1) {
    const header = lines[index].match(headerPattern);
    if (!header) continue;
    const key = header[1];
    const uploadPattern = new RegExp(`^\\s*===\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+UPLOAD\\s*===\\s*$`, "i");
    let uploadIndex = -1;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 5); cursor += 1) {
      if (uploadPattern.test(lines[cursor])) {
        uploadIndex = cursor;
        break;
      }
    }
    if (uploadIndex < 0) continue;

    const promptLines = [];
    for (let cursor = uploadIndex + 1; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) {
        if (promptLines.length) break;
        continue;
      }
      if (/^\s*(?:===|\[)/.test(lines[cursor])) break;
      promptLines.push(lines[cursor].trim());
    }

    const meta = parseCharacterMeta(header[2]);
    characters.push({
      id: `character-${key}`,
      key,
      ...meta,
      metadata: cleanText(header[2]),
      prompt: normalizePrompt(promptLines.join("\n"))
    });
  }

  const sceneSectionEnd = lines.length;
  const sceneItems = parseNumberedSection(lines, sceneMarker + 1, sceneSectionEnd);
  const scriptItems = scriptMarker >= 0
    ? parseNumberedSection(lines, scriptMarker + 1, sceneMarker)
    : [];
  const scriptsByNumber = new Map(scriptItems.map((item) => [item.number, item.text]));
  const knownCharacters = new Set(characters.map((character) => character.key));
  const unknownRefs = [];
  const referenceCounts = Object.fromEntries(characters.map((character) => [character.key, 0]));

  const scenes = sceneItems.map((item) => {
    const characterRefs = [...item.text.matchAll(/@([A-Za-z][\w-]*)/g)]
      .map((match) => match[1])
      .filter((key, index, values) => values.indexOf(key) === index);
    for (const key of characterRefs) {
      if (knownCharacters.has(key)) referenceCounts[key] += 1;
      else unknownRefs.push({ scene: item.number, key });
    }
    const refLabel = characterRefs.length ? characterRefs.map((key) => `@${key}`).join(" + ") : "참조 없음";
    return {
      number: item.number,
      heading: `장면 ${String(item.number).padStart(3, "0")} · ${refLabel}`,
      prompt: item.text,
      characterRefs,
      script: scriptsByNumber.get(item.number) || ""
    };
  });

  const warnings = [];
  if (!characters.length) warnings.push("캐릭터 정의를 찾지 못했습니다.");
  if (unknownRefs.length) {
    warnings.push(`정의되지 않은 캐릭터 참조가 있습니다: ${unknownRefs.map((item) => `${item.scene}번 @${item.key}`).join(", ")}`);
  }
  if (!scenes.every((scene, index) => scene.number === index + 1)) {
    warnings.push("장면 번호가 1부터 연속적이지 않습니다.");
  }
  if (scriptsByNumber.size && scenes.some((scene) => !scene.script)) {
    warnings.push("일부 이미지 프롬프트에 대응하는 대본 문장이 없습니다.");
  }

  const enrichedCharacters = characters.map((character) => ({
    ...character,
    referenceCount: referenceCounts[character.key] || 0
  }));

  return finalize(scenes, "flow-character-document", warnings, {
    characters: enrichedCharacters,
    referenceCounts,
    scriptCount: scriptItems.length,
    unknownRefs
  });
}

function characterRefsIn(prompt) {
  return [...String(prompt || "").matchAll(/@([A-Za-z][\w-]*)/g)]
    .map((match) => match[1])
    .filter((key, index, values) => values.indexOf(key) === index);
}

function introPromptBlock(lines, startIndex, endIndex) {
  let cursor = startIndex;
  while (cursor < endIndex && !lines[cursor].trim()) cursor += 1;
  if (cursor >= endIndex) return "";

  if (/^\s*```/.test(lines[cursor])) {
    const promptLines = [];
    for (cursor += 1; cursor < endIndex; cursor += 1) {
      if (/^\s*```/.test(lines[cursor])) break;
      promptLines.push(lines[cursor]);
    }
    return normalizePrompt(promptLines.join("\n"));
  }

  const promptLines = [];
  for (; cursor < endIndex; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim() || /^\s*\[[A-Z]\]/i.test(line) || INTRO_SCENE_PATTERN.test(line)) break;
    promptLines.push(line);
  }
  return normalizePrompt(promptLines.join("\n"));
}

export function parseIntroHookPromptDocument(rawText, { knownCharacterKeys = [] } = {}) {
  const lines = cleanText(rawText).split("\n");
  const sceneHeaders = lines
    .map((line, index) => ({ index, match: line.match(INTRO_SCENE_PATTERN) }))
    .filter((entry) => entry.match);
  if (!sceneHeaders.length) return null;

  const knownCharacters = new Set((knownCharacterKeys || []).map((key) => String(key).trim()).filter(Boolean));
  const scenes = [];
  const missingPrompts = [];
  const unknownRefs = [];

  for (let index = 0; index < sceneHeaders.length; index += 1) {
    const scene = sceneHeaders[index];
    const endIndex = sceneHeaders[index + 1]?.index ?? lines.length;
    const promptLabelIndex = lines.slice(scene.index + 1, endIndex)
      .findIndex((line) => INTRO_IMAGE_PROMPT_PATTERN.test(line));
    const number = Number(scene.match[1]);
    if (promptLabelIndex < 0) {
      missingPrompts.push(number);
      continue;
    }
    const prompt = introPromptBlock(lines, scene.index + 1 + promptLabelIndex + 1, endIndex);
    if (!prompt) {
      missingPrompts.push(number);
      continue;
    }
    const characterRefs = characterRefsIn(prompt);
    for (const key of characterRefs) {
      if (!knownCharacters.has(key)) unknownRefs.push({ scene: number, key });
    }
    const refLabel = characterRefs.length ? characterRefs.map((key) => `@${key}`).join(" + ") : "참조 없음";
    scenes.push({
      number,
      heading: `인트로 ${String(number).padStart(3, "0")} · ${refLabel}`,
      prompt,
      characterRefs,
      script: "",
      sourceMode: "intro"
    });
  }

  if (!scenes.length) return null;
  const warnings = [];
  if (!knownCharacters.size) {
    warnings.push("인트로 모드는 같은 Flow 프로젝트에서 먼저 준비한 캐릭터를 사용합니다. 기존 캐릭터 큐를 불러온 뒤 다시 시도하세요.");
  }
  if (missingPrompts.length) warnings.push(`${missingPrompts.join(", ")}번 씬에서 [A] 이미지 프롬프트를 찾지 못했습니다.`);
  if (unknownRefs.length) {
    warnings.push(`현재 프로젝트에 준비되지 않은 캐릭터 참조가 있습니다: ${unknownRefs.map((item) => `${item.scene}번 @${item.key}`).join(", ")}`);
  }
  if (!scenes.every((scene, index) => scene.number === index + 1)) {
    warnings.push("씬 번호가 1부터 연속적이지 않습니다.");
  }

  return finalize(scenes, "intro-hook-document", warnings, {
    unknownRefs,
    sourceMode: "intro"
  });
}

export function analyzeIntroAssets({ introText = "", thumbnailText = "", knownCharacterKeys = [] } = {}) {
  const analyses = [];
  const warnings = [];
  const unknownRefs = [];
  const cleanIntro = cleanText(introText);
  const cleanThumbnail = normalizePrompt(thumbnailText);
  const knownCharacters = new Set((knownCharacterKeys || []).map((key) => String(key).trim()).filter(Boolean));

  if (cleanIntro) {
    const intro = parseIntroHookPromptDocument(cleanIntro, { knownCharacterKeys });
    if (intro) {
      analyses.push(intro);
      warnings.push(...intro.warnings);
      unknownRefs.push(...(intro.unknownRefs || []));
    } else {
      warnings.push("인트로훅 파일에서 '===== 씬 N ====='과 '[A] 이미지 프롬프트' 블록을 찾지 못했습니다.");
    }
  }

  if (cleanThumbnail) {
    const characterRefs = characterRefsIn(cleanThumbnail);
    const missing = characterRefs
      .filter((key) => !knownCharacters.has(key))
      .map((key) => ({ scene: "썸네일", key }));
    unknownRefs.push(...missing);
    if (missing.length) {
      warnings.push(`현재 프로젝트에 준비되지 않은 썸네일 캐릭터 참조가 있습니다: ${missing.map((item) => `@${item.key}`).join(", ")}`);
    }
    const refLabel = characterRefs.length ? characterRefs.map((key) => `@${key}`).join(" + ") : "참조 없음";
    analyses.push(finalize([{
      heading: `썸네일 · ${refLabel}`,
      prompt: cleanThumbnail,
      characterRefs,
      sourceMode: "thumbnail"
    }], "thumbnail-prompt"));
  }

  if (!analyses.length) {
    return finalize([], "intro-assets", ["인트로훅 파일을 선택하거나 썸네일 프롬프트를 입력하세요."]);
  }

  const prompts = analyses.flatMap((entry) => entry.prompts.map((prompt) => ({
    ...prompt,
    heading: prompt.title
  })));
  return finalize(prompts, "intro-assets", [...new Set(warnings)], {
    unknownRefs,
    sourceMode: "intro"
  });
}

function parseHeadingSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  let fenced = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = !fenced ? line.match(HEADING_PATTERN) : null;
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[2].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  if (sections.length < 2) return null;
  const populated = sections.map((section) => {
    const body = normalizePrompt(section.lines.join("\n"));
    const genericHeading = /^(?:prompt|image|scene|shot|프롬프트|이미지|장면)\s*#?\s*\d+$/i.test(section.heading);
    return {
      heading: genericHeading ? "" : section.heading,
      prompt: body || section.heading
    };
  });
  return populated.filter((section) => section.prompt);
}

function parseLabeledSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  let fenced = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = !fenced ? line.match(LABEL_PATTERN) : null;
    if (match) {
      if (current) sections.push(current.join("\n"));
      current = match[1] ? [match[1]] : [];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join("\n"));
  return sections.length >= 2 ? sections : null;
}

function parseList(text) {
  const lines = text.split("\n");
  const items = [];
  let current = null;
  let fenced = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = !fenced ? line.match(LIST_ITEM_PATTERN) : null;
    if (match) {
      if (current) items.push(current.join("\n"));
      current = [match[2]];
      continue;
    }
    if (current) current.push(line.replace(/^\s{2,4}/, ""));
  }
  if (current) items.push(current.join("\n"));
  return items.length >= 2 ? items : null;
}

function splitDelimiters(text) {
  const blocks = [];
  let current = [];
  let fenced = false;

  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && DELIMITER_PATTERN.test(line)) {
      if (current.some((value) => value.trim())) blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.some((value) => value.trim())) blocks.push(current.join("\n"));
  return blocks.length >= 2 ? blocks : null;
}

function splitBlankBlocks(text) {
  const blocks = text.split(/\n\s*\n+/).map(normalizePrompt).filter(Boolean);
  return blocks.length >= 2 ? blocks : null;
}

export function analyzePrompts(rawText, { mode = "scene", knownCharacterKeys = [] } = {}) {
  const text = stripFrontmatter(cleanText(rawText));
  if (!text) return finalize([], "empty", ["프롬프트를 입력하거나 파일을 선택하세요."]);

  if (mode === "intro") {
    const introHookDocument = parseIntroHookPromptDocument(text, { knownCharacterKeys });
    return introHookDocument || finalize([], "intro-hook-document", ["인트로훅 파일에서 '===== 씬 N ====='과 '[A] 이미지 프롬프트' 블록을 찾지 못했습니다."]);
  }

  const flowDocument = parseFlowPromptDocument(text);
  if (flowDocument) return flowDocument;

  const headingSections = parseHeadingSections(text);
  if (headingSections) return finalize(headingSections, "markdown-headings");

  const labeledSections = parseLabeledSections(text);
  if (labeledSections) return finalize(labeledSections, "prompt-labels");

  const listItems = parseList(text);
  if (listItems) return finalize(listItems, "markdown-list");

  const delimited = splitDelimiters(text);
  if (delimited) return finalize(delimited, "delimiters");

  const blankBlocks = splitBlankBlocks(text);
  if (blankBlocks) return finalize(blankBlocks, "blank-lines");

  const lines = text.split("\n").map(normalizePrompt).filter(Boolean);
  if (lines.length >= 2) {
    return finalize(lines, "lines", ["각 줄을 하나의 이미지 프롬프트로 해석했습니다."]);
  }

  return finalize([text], "single");
}

export function formatLabel(format) {
  const labels = {
    empty: "입력 없음",
    "markdown-headings": "Markdown 제목",
    "prompt-labels": "Prompt 라벨",
    "markdown-list": "Markdown 목록",
    delimiters: "구분선",
    "blank-lines": "빈 줄 블록",
    lines: "줄 단위",
    single: "단일 프롬프트",
    "flow-character-document": "Flow 캐릭터 문서",
    "intro-hook-document": "인트로훅 A 이미지 프롬프트",
    "thumbnail-prompt": "썸네일 프롬프트",
    "intro-assets": "인트로 + 썸네일"
  };
  return labels[format] || format;
}
