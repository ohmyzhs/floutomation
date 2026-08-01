export const PROJECT_HISTORY_KEY = "flowBatchProjectHistory";
export const PROJECT_HISTORY_LIMIT = 24;

function cleanText(value) {
  return String(value || "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanText).filter(Boolean))];
}

export function projectIdFromFlowUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/\/tools\/flow\/project\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).trim() : "";
  } catch {
    return "";
  }
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

export function buildProjectCharacterProfile({ projectId, projectTitle = "", characters = [], registeredKeys = [], now = Date.now() } = {}) {
  return {
    projectId: cleanText(projectId),
    projectTitle: cleanText(projectTitle),
    savedAt: Number(now),
    updatedAt: Number(now),
    registeredKeys: uniqueStrings(registeredKeys),
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
  if (!next.projectId || !next.characters.length) return normalized;
  const previous = normalized.profiles.find((entry) => entry.projectId === next.projectId);
  const merged = {
    ...next,
    savedAt: previous?.savedAt || next.savedAt,
    registeredKeys: uniqueStrings([...(previous?.registeredKeys || []), ...next.registeredKeys])
  };
  return normalizeProjectHistory({
    profiles: [merged, ...normalized.profiles.filter((entry) => entry.projectId !== next.projectId)]
  });
}

export function findProjectCharacterProfile(history, projectId) {
  const key = cleanText(projectId);
  return normalizeProjectHistory(history).profiles.find((profile) => profile.projectId === key) || null;
}
