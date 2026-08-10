export function assetAliases(asset) {
  return [asset?.assetId, asset?.detailUrl, asset?.url]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function primaryKeyOf(asset) {
  return assetAliases(asset)[0] || "";
}

function expectedImagesForJob(job, fallback) {
  const recorded = Number(job?.imagesGenerated || 0);
  if (recorded > 0) return Math.max(1, recorded);
  return Math.max(1, Number(fallback || 1));
}

/**
 * Creates a replacement plan for a chosen Flow image and queue job.
 * Everything before either selected position remains untouched.
 */
export function buildAssetSuffixAssignments({ catalog = [], jobs = [], startAssetKey, startJobId, imagesPerPrompt = 2 } = {}) {
  const rows = catalog
    .map((asset, index) => ({ asset, index, key: primaryKeyOf(asset), aliases: assetAliases(asset) }))
    .filter((row) => row.key);
  const eligibleJobs = jobs.filter((job) => job && job.sourceMode !== "character");
  const normalizedAssetKey = String(startAssetKey || "").trim();
  const startAssetIndex = rows.findIndex((row) => row.key === normalizedAssetKey || row.aliases.includes(normalizedAssetKey));
  const startJobIndex = eligibleJobs.findIndex((job) => job.id === startJobId);
  if (startAssetIndex < 0) throw new Error("시작 이미지가 현재 Flow 목록에 없습니다.");
  if (startJobIndex < 0) throw new Error("시작 장면을 찾지 못했습니다.");

  const assignments = [];
  let cursor = startAssetIndex;
  eligibleJobs.slice(startJobIndex).forEach((job) => {
    let slots = expectedImagesForJob(job, imagesPerPrompt);
    while (slots > 0 && cursor < rows.length) {
      const row = rows[cursor++];
      assignments.push({ assetKey: row.key, jobId: job.id, catalogIndex: row.index });
      slots -= 1;
    }
  });
  return {
    assignments,
    startAssetIndex,
    startJobIndex,
    suffixAssetKeys: new Set(rows.slice(startAssetIndex).map((row) => row.key)),
    targetJobIds: new Set(eligibleJobs.slice(startJobIndex).map((job) => job.id))
  };
}

