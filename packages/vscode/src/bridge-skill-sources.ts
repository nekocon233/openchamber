import { discoverSkills, mergeDiscoveredSkills, type DiscoveredSkill } from './opencodeConfig';
import { type SkillsCatalogSourceConfig } from './skillsCatalog';
import { type MagicPromptHttpResponse, type MagicPromptRequest } from './magic-prompts';
import type { BridgeContext } from './bridge';

export type ConfigRuntimeDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  persistSettings: (changes: Record<string, unknown>, ctx?: BridgeContext) => Promise<Record<string, unknown>>;
  handleMagicPromptRequest: (request: MagicPromptRequest) => Promise<MagicPromptHttpResponse>;
  fetchOpenCodeSkillsFromApi: (ctx: BridgeContext | undefined, workingDirectory?: string) => Promise<DiscoveredSkill[] | null>;
  homedir: () => string;
  clientReloadDelayMs: number;
};

export const parseSkillsCatalogSources = (settings: Record<string, unknown>): SkillsCatalogSourceConfig[] => {
  const rawCatalogs = (settings as { skillCatalogs?: unknown }).skillCatalogs;
  if (!Array.isArray(rawCatalogs)) {
    return [];
  }

  return rawCatalogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
      if (!id || !label || !source) return null;
      const normalized: SkillsCatalogSourceConfig = {
        id,
        label,
        description: source,
        source,
        ...(subpath ? { defaultSubpath: subpath } : {}),
      };
      return normalized;
    })
    .filter((value): value is SkillsCatalogSourceConfig => value !== null);
};

export const resolveDiscoveredSkills = async (
  deps: ConfigRuntimeDeps,
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
): Promise<DiscoveredSkill[]> => mergeDiscoveredSkills(
  (await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [],
  discoverSkills(workingDirectory),
);
