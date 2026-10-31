const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Only versioned release slugs qualify; previews, dates and aliases stay pinned. */
export const antigravityModelVersion = (id) => {
  const match = /^claude-(opus|sonnet)-(\d{1,3})(?:-(\d{1,3}))?(?:-(low|medium|high|xhigh|max))?$/.exec(id);
  return match ? {
    family: `antigravity-${match[1]}`,
    major: Number(match[2]), minor: Number(match[3] ?? 0), effort: match[4],
    label: match[3] === undefined ? match[2] : `${match[2]}.${match[3]}`,
  } : null;
};

const compareVersion = (left, right) => left.major - right.major || left.minor - right.minor;

/** Apply verified releases with versioned names while retaining selectable identities. */
export const followAntigravityModels = (models, available) => {
  const candidates = new Map();
  for (const model of available) {
    const version = antigravityModelVersion(model.id);
    if (!version || model.followFamily !== version.family) continue;
    const family = candidates.get(version.family) ?? [];
    family.push({ model, version });
    candidates.set(version.family, family);
  }
  let changed = false;
  const updated = models.map((model) => {
    if (!model.followFamily) return model;
    const current = antigravityModelVersion(model.modelID);
    if (!current || current.family !== model.followFamily) return model;
    const effortRank = (version) => version.effort === current.effort ? EFFORTS.length : EFFORTS.indexOf(version.effort);
    let latest = null;
    for (const candidate of candidates.get(model.followFamily) ?? []) {
      if (compareVersion(candidate.version, current) < 0) continue;
      if (!latest || compareVersion(candidate.version, latest.version) > 0
        || (compareVersion(candidate.version, latest.version) === 0 && effortRank(candidate.version) > effortRank(latest.version))) latest = candidate;
    }
    if (!latest) return model;
    const next = {
      ...model,
      modelID: latest.model.id,
      name: `${model.followFamily === 'antigravity-opus' ? 'Opus' : 'Sonnet'} ${latest.version.label} (agy)`,
      contextWindow: latest.model.contextWindow,
      outputLimit: latest.model.outputLimit,
      input: { image: latest.model.image, pdf: latest.model.pdf ?? false },
      efforts: latest.model.efforts,
    };
    if (JSON.stringify(next) === JSON.stringify(model)) return model;
    changed = true;
    return next;
  });
  return changed ? updated : models;
};
