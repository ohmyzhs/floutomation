function aliasesOf(asset) {
  return [asset?.assetId, asset?.detailUrl, asset?.url]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function primaryKeyOf(asset) {
  return aliasesOf(asset)[0] || "";
}

function expectedImagesForJob(job, fallback) {
  const recorded = Number(job?.imagesGenerated || 0);
  if (recorded > 0) return Math.max(1, recorded);
  return Math.max(1, Number(fallback || 1));
}

/**
 * Builds only new assignments. Existing automatic and manual mappings are
 * treated as fixed so a partial manual correction is never overwritten.
 */
export function buildRemainingAssetAssignments({ catalog = [], jobs = [], imagesPerPrompt = 2 } = {}) {
  const rows = catalog
    .map((asset, index) => ({ asset, index, key: primaryKeyOf(asset), aliases: aliasesOf(asset) }))
    .filter((row) => row.key);
  const aliasToPrimary = new Map();
  rows.forEach((row) => row.aliases.forEach((alias) => {
    if (!aliasToPrimary.has(alias)) aliasToPrimary.set(alias, row.key);
  }));

  const eligibleJobs = jobs.filter((job) => job && job.sourceMode !== "character");
  const ownerByAsset = new Map();
  const assignedByJob = new Map(eligibleJobs.map((job) => [job.id, new Set()]));
  const claim = (job, alias, manual = false) => {
    const primary = aliasToPrimary.get(String(alias || "").trim());
    if (!primary || !assignedByJob.has(job.id)) return;
    if (manual || !ownerByAsset.has(primary)) ownerByAsset.set(primary, job.id);
  };

  eligibleJobs.forEach((job) => (job.resultAssets || []).forEach((asset) => aliasesOf(asset).forEach((alias) => claim(job, alias))));
  eligibleJobs.forEach((job) => (job.mappedAssetIds || []).forEach((id) => claim(job, id, true)));
  ownerByAsset.forEach((jobId, assetKey) => assignedByJob.get(jobId)?.add(assetKey));

  const unassignedRows = rows.filter((row) => !ownerByAsset.has(row.key));
  const assignments = [];
  let cursor = 0;
  eligibleJobs.forEach((job) => {
    const expected = expectedImagesForJob(job, imagesPerPrompt);
    let slots = Math.max(0, expected - (assignedByJob.get(job.id)?.size || 0));
    while (slots > 0 && cursor < unassignedRows.length) {
      const row = unassignedRows[cursor++];
      assignments.push({ assetKey: row.key, jobId: job.id, catalogIndex: row.index });
      slots -= 1;
    }
  });
  return assignments;
}

