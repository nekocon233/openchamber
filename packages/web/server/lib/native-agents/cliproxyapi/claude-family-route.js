import { z } from 'zod';

export const CLAUDE_ROUTE_MODELS = { opus: 'openchamber-opus', sonnet: 'openchamber-sonnet' };
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** Claude releases may have a dated API id; previews never qualify. */
export const claudeFamilyVersion = (id) => {
  const match = /^claude-(opus|sonnet)-(\d{1,3})(?:-(\d{1,3}))?(?:-\d{8})?(?:-(low|medium|high|xhigh|max))?$/.exec(id);
  return match ? { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0), label: match[3] ? `${match[2]}.${match[3]}` : match[2], effort: match[4] } : null;
};

const binding = z.object({
  modelID: z.string().min(1).refine((id) => claudeFamilyVersion(id) !== null),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  outputLimit: z.number().int().positive().max(1_000_000),
  input: z.object({ image: z.boolean(), pdf: z.boolean() }),
  efforts: z.array(effort).max(5),
});

const familyRouteSchema = (family) => z.object({
  modelId: z.string().uuid(),
  claude: binding.nullable(), antigravity: binding.nullable(),
}).refine((route) => [route.claude, route.antigravity].every((source) => !source || claudeFamilyVersion(source.modelID)?.family === family));

export const claudeRoutesSchema = z.object({
  connectionId: z.string().uuid(),
  opus: familyRouteSchema('opus').nullable(), sonnet: familyRouteSchema('sonnet').nullable(),
  priorities: z.array(z.object({ name: z.string().min(1), priority: z.number().int().nullable() })).default([]),
  previousRebind: z.enum(['any', 'quota']).nullable().default(null),
}).refine((routes) => routes.opus !== null || routes.sonnet !== null)
  .refine((routes) => !routes.opus || !routes.sonnet || routes.opus.modelId !== routes.sonnet.modelId);

/** Read-only compatibility for stores written before Sonnet shared the engine. */
export const legacyOpusRouteSchema = z.object({
  connectionId: z.string().uuid(), modelId: z.string().uuid(),
  claude: binding.nullable(), antigravity: binding.nullable(),
  priorities: z.array(z.object({ name: z.string().min(1), priority: z.number().int().nullable() })).default([]),
  previousRebind: z.enum(['any', 'quota']).nullable().default(null),
}).refine((route) => [route.claude, route.antigravity].every((source) => !source || claudeFamilyVersion(source.modelID)?.family === 'opus'));

const compare = (left, right) => left.major - right.major || left.minor - right.minor;

export const latestFamilyBinding = (models, previous, family) => {
  let selected = previous;
  for (const [id, model] of models) {
    const version = claudeFamilyVersion(id);
    if (!version || version.family !== family) continue;
    const current = selected ? claudeFamilyVersion(selected.modelID) : null;
    if (current && compare(version, current) < 0) continue;
    if (current && compare(version, current) === 0) {
      if (selected.modelID !== id && models.has(selected.modelID) && (current.effort === 'high' || version.effort !== 'high')) continue;
    }
    selected = { modelID: id, contextWindow: model.contextWindow, outputLimit: model.outputLimit,
      input: { image: model.image, pdf: model.pdf ?? false }, efforts: model.efforts };
  }
  return selected;
};

export const unifiedFamilyModel = (family, route) => {
  const primary = route.claude;
  const backup = route.antigravity;
  if (!primary || !backup) return null;
  const primaryVersion = claudeFamilyVersion(primary.modelID).label;
  const backupVersion = claudeFamilyVersion(backup.modelID).label;
  const title = family === 'opus' ? 'Opus' : 'Sonnet';
  return {
    id: route.modelId, name: primaryVersion === backupVersion ? `${title} ${primaryVersion}` : `${title} (Claude ${primaryVersion} / agy ${backupVersion})`,
    modelID: CLAUDE_ROUTE_MODELS[family],
    contextWindow: Math.min(primary.contextWindow, backup.contextWindow),
    outputLimit: Math.min(primary.outputLimit, backup.outputLimit),
    input: { image: primary.input.image && backup.input.image, pdf: primary.input.pdf && backup.input.pdf },
    efforts: primary.efforts.filter((level) => backup.efforts.includes(level)),
  };
};

/** Only the reserved alias belongs to this route; other gateway aliases survive. */
export const activeClaudeRoutes = (routes) => ['opus', 'sonnet'].filter((family) => routes?.[family]?.claude && routes[family].antigravity);

export const claudeRouteAliases = (aliases, routes) => {
  const next = { ...aliases };
  for (const provider of ['claude', 'antigravity']) {
    const entries = (aliases[provider] ?? []).filter((entry) => !Object.values(CLAUDE_ROUTE_MODELS).includes(entry.alias));
    for (const family of activeClaudeRoutes(routes)) entries.push({ name: routes[family][provider].modelID, alias: CLAUDE_ROUTE_MODELS[family], fork: true });
    next[provider] = entries;
  }
  return next;
};

export const restoredFamilyModel = (family, id, source) => ({
  id, ...source, name: `${family === 'opus' ? 'Opus' : 'Sonnet'} ${claudeFamilyVersion(source.modelID).label} (agy)`, followFamily: `antigravity-${family}`,
});
