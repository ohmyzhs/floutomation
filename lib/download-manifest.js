const DEFAULT_IMAGE_EXTENSION = "jpeg";

export function normalizeAsset(value) {
  if (!value || typeof value !== "object") return null;
  const url = String(value.url || "").trim();
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    detailUrl: String(value.detailUrl || "").trim(),
    assetId: String(value.assetId || "").trim(),
    prompt: String(value.prompt || "").trim(),
    title: String(value.title || "").trim(),
    sourceMode: String(value.sourceMode || "").trim(),
    number: Number.isFinite(Number(value.number)) ? Number(value.number) : null,
    kind: String(value.kind || "").trim()
  };
}

export function uniqueAssets(values) {
  const seen = new Set();
  const assets = [];
  for (const value of values || []) {
    const asset = normalizeAsset(value);
    if (!asset) continue;
    const identity = asset.assetId || asset.detailUrl || asset.url;
    if (seen.has(identity)) continue;
    seen.add(identity);
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

export function sanitizeArchiveFilename(value, fallback = "Flow-project") {
  const sanitized = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .trim();
  return (sanitized || fallback).slice(0, 120).replace(/[._]+$/g, "") || fallback;
}

export function buildDownloadManifest({ state, projectTitle, orderedSceneAssets, characterAssets }) {
  const folder = "Scene_Images";
  const archiveBase = sanitizeArchiveFilename(projectTitle).replace(/\.zip$/i, "") || "Flow-project";
  const archiveFilename = `${archiveBase}.zip`;
  const entries = [];
  const missingScenes = [];
  const missingIntros = [];
  const missingThumbnails = [];
  const mappingWarnings = [];
  const sceneAssetCounts = [];
  const assignedSceneIdentities = new Set();
  const imagesPerPrompt = Math.max(1, Number(state.options?.imagesPerPrompt || 2));
  const scannedAssets = uniqueAssets(orderedSceneAssets);
  const scannedByIdentity = new Map(
    scannedAssets.flatMap((asset) => {
      const keys = [asset.assetId, asset.detailUrl, asset.url].filter(Boolean);
      return keys.map((key) => [key, asset]);
    })
  );
  const sceneJobs = [...(state.jobs || [])].sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  const characterByKey = new Map(
    (characterAssets || []).map((asset) => [String(asset.name || "").trim().toLowerCase(), asset])
  );
  let fallbackAssetIndex = 0;

  function resolveJobAssets(job) {
    const mappedIds = Array.isArray(job.mappedAssetIds)
      ? [...new Set(job.mappedAssetIds.map(String).filter(Boolean))]
      : [];
    const storedAssets = uniqueAssets(job.resultAssets);
    const trackedAssets = storedAssets
      .map((asset) => scannedByIdentity.get(asset.assetId) || scannedByIdentity.get(asset.detailUrl) || scannedByIdentity.get(asset.url) || asset)
      .filter(Boolean);

    if (mappedIds.length) {
      const mapped = mappedIds.map((id) => scannedByIdentity.get(id)).filter(Boolean);
      const missingIds = mappedIds.filter((id) => !scannedByIdentity.has(id));
      if (missingIds.length) mappingWarnings.push({ jobId: job.id, missingAssetIds: missingIds });
      // A manual assignment adds or moves a single asset. It must not hide the
      // scene's already verified automatic results when the project is
      // downloaded. Keep the same order shown in the scene card: automatic
      // results first, then manually attached images that are not duplicates.
      const combined = uniqueAssets([...trackedAssets, ...mapped]);
      if (combined.length) return combined;
    }
    if (trackedAssets.length || storedAssets.length) return trackedAssets;
    // Backward compatibility for queues created before asset IDs were stored.
    // New generations never take this path, so variable-size results cannot be
    // silently reassigned to the next scene.
    const fallbackStart = fallbackAssetIndex;
    fallbackAssetIndex += imagesPerPrompt;
    mappingWarnings.push({ jobId: job.id, type: "legacy-ordinal-fallback" });
    return scannedAssets.slice(fallbackStart, fallbackStart + imagesPerPrompt);
  }

  function filenameLabel(job, jobIndex) {
    const sourceMode = String(job.sourceMode || "scene");
    if (sourceMode === "thumbnail") return "thumbnail";
    if (sourceMode === "intro") return `intro${Math.max(1, Number(job.sourceNumber || job.number || jobIndex + 1))}`;
    return String(Math.max(1, Number(job.sourceNumber || job.number || jobIndex + 1))).padStart(3, "0");
  }

  for (const [jobIndex, job] of sceneJobs.entries()) {
    const assets = resolveJobAssets(job);
    sceneAssetCounts.push({ jobId: job.id, sourceNumber: job.sourceNumber || job.number || jobIndex + 1, count: assets.length });
    if (!assets.length) {
      const sourceMode = String(job.sourceMode || "scene");
      if (sourceMode === "scene") missingScenes.push(Number(job.sourceNumber || job.number || job.index + 1));
      if (sourceMode === "intro") missingIntros.push(Number(job.sourceNumber || job.number || job.index + 1));
      if (sourceMode === "thumbnail") missingThumbnails.push("thumbnail");
    }
    const label = filenameLabel(job, jobIndex);
    assets.forEach((asset, index) => {
      const sourceMode = String(job.sourceMode || "scene");
      const imageNumber = sourceMode === "scene" ? String(index + 1).padStart(2, "0") : String(index + 1);
      entries.push({
        kind: sourceMode,
        jobId: job.id,
        url: asset.url,
        assetId: asset.assetId,
        filename: `${folder}/${label}-${imageNumber}.${DEFAULT_IMAGE_EXTENSION}`
      });
      assignedSceneIdentities.add(asset.assetId || asset.detailUrl || asset.url);
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
      assetId: asset.assetId || "",
      filename: `${folder}/${sanitizePathSegment(character.key || character.displayName, "character")}.${DEFAULT_IMAGE_EXTENSION}`
    });
  }

  return {
    folder,
    archiveFilename,
    entries,
    missingScenes,
    missingIntros,
    missingThumbnails,
    missingCharacters,
    mappingWarnings,
    sceneAssetCounts,
    scannedSceneCount: scannedAssets.length,
    expectedSceneCount: sceneJobs.length * imagesPerPrompt,
    mappedSceneCount: sceneAssetCounts.reduce((sum, item) => sum + item.count, 0),
    extraSceneCount: Math.max(0, scannedAssets.length - assignedSceneIdentities.size)
  };
}
