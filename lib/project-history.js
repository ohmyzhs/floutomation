export const PROJECT_HISTORY_KEY = "flowBatchProjectHistory";
export const PROJECT_HISTORY_LIMIT = 24;
export const FLOW_TAB_URL_PATTERNS = [
  "https://labs.google/fx/*",
  "https://flow.google/project/*",
  "https://flow.google.com/project/*",
  "https://fow.google/project/*"
];

const LEGACY_FLOW_PATH = /^\/fx\/(?:[^/]+\/)?tools\/flow(?:\/|$)/i;
const DIRECT_FLOW_PATH = /^\/project\/[^/]+(?:\/|$)/i;
const DIRECT_FLOW_HOSTS = new Set(["flow.google", "flow.google.com", "fow.google"]);

function cleanText(value) {
  return String(value || "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))];
}

function normalizeAsset(asset) {
  const url = cleanText(asset?.url);
  if (!/^https:\/\//i.test(url)) return null;
  return {
    url,
    detailUrl: cleanText(asset?.detailUrl),
    assetId: cleanText(asset?.assetId)
  };
}

function uniqueAssets(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const asset = normalizeAsset(value);
    if (!asset) return [];
    const identity = asset.assetId || asset.detailUrl || asset.url;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [asset];
  });
}

function normalizeMappingJobs(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((job) => {
    const sourceMode = cleanText(job?.sourceMode || "scene") || "scene";
    const sourceNumber = Math.max(1, Number(job?.sourceNumber || job?.number || 1));
    const key = `${sourceMode}:${sourceNumber}`;
    if (seen.has(key)) return [];
    const assets = uniqueAssets(job?.assets);
    const mappedAssetIds = uniqueStrings(job?.mappedAssetIds);
    if (!assets.length && !mappedAssetIds.length) return [];
    seen.add(key);
    return [{
      sourceMode,
      sourceNumber,
      number: Math.max(1, Number(job?.number || sourceNumber)),
      title: cleanText(job?.title),
      characterRefs: uniqueStrings(job?.characterRefs),
      imagesGenerated: Math.max(0, Number(job?.imagesGenerated || assets.length)),
      assets,
      mappedAssetIds
    }];
  }).slice(0, 300);
}

function flowUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

export function isFlowUrl(value) {
  const url = flowUrl(value);
  if (!url || url.protocol !== "https:") return false;
  if (url.hostname === "labs.google") return LEGACY_FLOW_PATH.test(url.pathname);
  return DIRECT_FLOW_HOSTS.has(url.hostname) && DIRECT_FLOW_PATH.test(url.pathname);
}

export function projectIdFromFlowUrl(value) {
  const url = flowUrl(value);
  if (!url || !isFlowUrl(url.href)) return "";
  const match = url.hostname === "labs.google"
    ? url.pathname.match(/\/tools\/flow\/project\/([^/?#]+)/i)
    : url.pathname.match(/^\/project\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]).trim() : "";
}

export function projectTitleFromTabTitle(value) {
  return cleanText(value).replace(/^Google Flow\s*[-–—]\s*/i, "").trim();
}

export function normalizeProjectHistory(value) {
  const profiles = Array.isArray(value?.profiles) ? value.profiles : [];
  return {
    profiles: profiles
      .filter((profile) => cleanText(profile?.projectId))
      .map((profile) => ({
        projectId: cleanText(profile.projectId),
        projectTitle: cleanText(profile.projectTitle),
        savedAt: Number(profile.savedAt || 0),
        updatedAt: Number(profile.updatedAt || profile.savedAt || 0),
        registeredKeys: uniqueStrings(profile.registeredKeys),
        mappingJobs: normalizeMappingJobs(profile.mappingJobs),
        characters: (Array.isArray(profile.characters) ? profile.characters : [])
          .map((character) => ({
            key: cleanText(character?.key),
            displayName: cleanText(character?.displayName || character?.key),
            description: cleanText(character?.description),
            chapterRange: cleanText(character?.chapterRange),
            prompt: cleanText(character?.prompt),
            referenceCount: Math.max(0, Number(character?.referenceCount || 0))
          }))
          .filter((character) => character.key && character.prompt)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROJECT_HISTORY_LIMIT)
  };
}

export function buildProjectCharacterProfile({ projectId, projectTitle = "", characters = [], registeredKeys = [], mappingJobs, now = Date.now() } = {}) {
  return {
    projectId: cleanText(projectId),
    projectTitle: cleanText(projectTitle),
    savedAt: Number(now),
    updatedAt: Number(now),
    registeredKeys: uniqueStrings(registeredKeys),
    ...(Array.isArray(mappingJobs) ? { mappingJobs: normalizeMappingJobs(mappingJobs) } : {}),
    characters: (Array.isArray(characters) ? characters : [])
      .map((character) => ({
        key: cleanText(character?.key),
        displayName: cleanText(character?.displayName || character?.key),
        description: cleanText(character?.description),
        chapterRange: cleanText(character?.chapterRange),
        prompt: cleanText(character?.prompt),
        referenceCount: Math.max(0, Number(character?.referenceCount || 0))
      }))
      .filter((character) => character.key && character.prompt)
  };
}

export function upsertProjectCharacterProfile(history, profile) {
  const normalized = normalizeProjectHistory(history);
  const next = buildProjectCharacterProfile({
    ...profile,
    now: Number(profile?.updatedAt || profile?.savedAt || Date.now())
  });
  const includesMappings = Array.isArray(profile?.mappingJobs);
  if (!next.projectId || (!next.characters.length && !includesMappings)) return normalized;
  const previous = normalized.profiles.find((entry) => entry.projectId === next.projectId);
  const merged = {
    ...next,
    savedAt: previous?.savedAt || next.savedAt,
    registeredKeys: uniqueStrings([...(previous?.registeredKeys || []), ...next.registeredKeys]),
    characters: next.characters.length ? next.characters : (previous?.characters || []),
    mappingJobs: includesMappings ? next.mappingJobs : (previous?.mappingJobs || [])
  };
  return normalizeProjectHistory({
    profiles: [merged, ...normalized.profiles.filter((entry) => entry.projectId !== next.projectId)]
  });
}

export function findProjectCharacterProfile(history, projectId) {
  const key = cleanText(projectId);
  return normalizeProjectHistory(history).profiles.find((profile) => profile.projectId === key) || null;
}
