const DEFAULT_IMAGE_EXTENSION = "jpeg";

export function normalizeAsset(value) {
  if (!value || typeof value !== "object") return null;
  const url = String(value.url || "").trim();
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    detailUrl: String(value.detailUrl || "").trim(),
    prompt: String(value.prompt || "").trim(),
    title: String(value.title || "").trim()
  };
}

export function uniqueAssets(values) {
  const seen = new Set();
  const assets = [];
  for (const value of values || []) {
    const asset = normalizeAsset(value);
    if (!asset || seen.has(asset.url)) continue;
    seen.add(asset.url);
    assets.push(asset);
  }
  return assets;
}

export function sanitizePathSegment(value, fallback = "Flow-project") {
  const sanitized = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (sanitized || fallback).slice(0, 90);
}

export function timestampFolder(now = new Date()) {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ];
  return parts.join("");
}

export function buildDownloadManifest({ state, projectTitle, orderedSceneAssets, characterAssets, now = new Date() }) {
  const folder = `Flow Batch Studio/${sanitizePathSegment(projectTitle) || "Flow-project"}-${timestampFolder(now)}`;
  const entries = [];
  const missingScenes = [];
  const imagesPerPrompt = Math.max(1, Number(state.options?.imagesPerPrompt || 2));
  const sceneAssets = uniqueAssets(orderedSceneAssets);
  const sceneJobs = [...(state.jobs || [])].sort((left, right) => Number(left.number || left.index + 1) - Number(right.number || right.index + 1));
  const characterByKey = new Map(
    (characterAssets || []).map((asset) => [String(asset.name || "").trim().toLowerCase(), asset])
  );

  for (const [jobIndex, job] of sceneJobs.entries()) {
    const assets = sceneAssets.slice(jobIndex * imagesPerPrompt, (jobIndex + 1) * imagesPerPrompt);
    if (assets.length < imagesPerPrompt) {
      missingScenes.push(Number(job.number || job.index + 1));
    }
    const sceneNumber = String(Number(job.number || job.index + 1)).padStart(3, "0");
    assets.forEach((asset, index) => {
      entries.push({
        kind: "scene",
        jobId: job.id,
        url: asset.url,
        filename: `${folder}/${sceneNumber}-${index + 1}.${DEFAULT_IMAGE_EXTENSION}`
      });
    });
  }

  const missingCharacters = [];
  for (const character of (state.characters || [])) {
    const scanned = characterByKey.get(String(character.key || "").trim().toLowerCase());
    const stored = uniqueAssets(character.resultAssets)[0];
    const asset = normalizeAsset(scanned) || stored;
    if (!asset) {
      missingCharacters.push(character.key);
      continue;
    }
    entries.push({
      kind: "character",
      characterId: character.id,
      url: asset.url,
      filename: `${folder}/${sanitizePathSegment(character.key || character.displayName, "character")}.${DEFAULT_IMAGE_EXTENSION}`
    });
  }

  return {
    folder,
    entries,
    missingScenes,
    missingCharacters,
    scannedSceneCount: sceneAssets.length,
    expectedSceneCount: sceneJobs.length * imagesPerPrompt,
    extraSceneCount: Math.max(0, sceneAssets.length - (sceneJobs.length * imagesPerPrompt))
  };
}
