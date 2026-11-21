import { createSkillDiscovery } from './skill-discovery.js';
import { buildAppliedResponse } from './config-mutation-response.js';
import { skillSwitchRequestSchema } from './config-v2.js';
import { setSkillEnabled } from './skill-switch.js';
import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import { getTargetSkillDir } from '../skills-catalog/install.js';
import { planInstalledSkillUpdates, updateInstalledSkills } from '../skills-catalog/update-installed.js';
import type { CatalogCloneIdentity, InstalledUpdateIdentity, InstalledUpdateInstallInput, InstalledUpdateInstallOutcome } from '../skills-catalog/update-installed.js';
import { syncUserSkills } from '../skills-catalog/user-sync.js';
import { appendInstalledSources, isInstalledFromSource, readInstalledSources, readInstalledSourcesForProject, removeInstalledSources } from '../skills-catalog/installed-sources.js';
import type { Application } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type { createHttpsCredentialReference } from '../git/credential-resolver.js';
import type { ProviderAccount } from '../git/network-plan-contracts.js';
import type { StoredGitIdentityProfile } from '../git/identity-storage.js';
import type { getCacheKey, scanWithCache } from '../skills-catalog/cache.js';
import type { CuratedSkillsSource, getCuratedSkillsSources } from '../skills-catalog/curated-sources.js';
import type { CatalogGitIdentity, CatalogGitOptions } from '../skills-catalog/git.js';
import type { fetchGitHubRepoMetas } from '../skills-catalog/github-meta.js';
import type { installSkillsFromRepository } from '../skills-catalog/install.js';
import type { scanSkillsRepository } from '../skills-catalog/scan.js';
import type { parseSkillRepoSource } from '../skills-catalog/source.js';
import type { SKILL_SCOPE } from './config-files.js';
import type { createOpenCodeLifecycleRuntime } from './lifecycle.js';
import type { readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile } from './skill-files.js';
import type { ListedSkill, ParsedSkillFiles, createSkill, deleteSkill, discoverSkills, getSkillSources, isManagedSkillPath, mergeDiscoveredSkills, renameSkill, updateSkill } from './skills.js';

type Directory = string | null;
type SkillSource = ListedSkill['source'];
interface SkillParams { name: string }
interface SkillFileParams extends SkillParams { filePath: string | string[] }
interface TransportAccount {
  credentialId: string;
  status: string;
  credentialRevision: number;
  providerUserId: string;
}
interface CustomSource {
  id: string;
  label: string;
  description: string;
  source: string;
  defaultSubpath: string | undefined;
  gitIdentityId: string | undefined;
}
type CatalogSource = (CuratedSkillsSource & { gitIdentityId?: undefined }) | (CustomSource & { excludedSkills?: undefined });
type CatalogIdentity = { ok: true; identity: CatalogGitIdentity | null } | {
  ok: false; error: { kind: 'authRequired'; message: string };
};
interface CatalogBody {
  source?: JsonValue;
  subpath?: JsonValue;
  sourceId?: JsonValue;
  gitIdentityId?: JsonValue;
  scope?: JsonValue;
  targetSource?: JsonValue;
  selections?: JsonValue;
  conflictPolicy?: JsonValue;
  conflictDecisions?: JsonValue;
}
interface MutationFields { content?: JsonValue; scope?: JsonValue; source?: JsonValue; renameTo?: JsonValue; targetPath?: JsonValue }
interface RepoMetaFields { stars?: unknown; repoUpdatedAt?: unknown }
interface SkillSettings { skillCatalogs?: unknown }
interface CustomCatalogSetting { id: string; label: string; source: string; subpath?: string; gitIdentityId?: string }
interface ErrorFields { code?: unknown; message?: unknown }
interface CachedScan {
  ok?: unknown;
  error?: unknown;
  items?: unknown;
}
interface CachedSkill { skillName?: unknown; skillDir?: unknown }
export type SkillRouteOptions =
  & Pick<ReturnType<typeof createProjectDirectoryRuntime>, 'resolveProjectDirectory' | 'resolveOptionalProjectDirectory'>
  & Pick<CatalogGitOptions, 'credentialResolver'>
  & {
    fs: typeof import('node:fs');
    path: typeof import('node:path');
    os: Pick<typeof import('node:os'), 'homedir'>;
    refreshOpenCodeAfterConfigChange?: ReturnType<typeof createOpenCodeLifecycleRuntime>['refreshOpenCodeAfterConfigChange'];
    clientReloadDelayMs?: number;
    buildOpenCodeUrl: (path: string, prefix: string) => string;
    getOpenCodeAuthHeaders: () => Record<string, string>;
    getOpenCodePort: () => number | null | undefined;
    readSettingsFromDisk: () => Promise<SkillSettings>;
    sanitizeSkillCatalogs: (value: SkillSettings['skillCatalogs']) => CustomCatalogSetting[] | undefined;
    isUnsafeSkillRelativePath: (value: string) => boolean;
    getSkillSources: typeof getSkillSources;
    discoverSkills: typeof discoverSkills;
    mergeDiscoveredSkills: typeof mergeDiscoveredSkills;
    createSkill: typeof createSkill;
    updateSkill: typeof updateSkill;
    deleteSkill: typeof deleteSkill;
    renameSkill: typeof renameSkill;
    isManagedSkillPath: typeof isManagedSkillPath;
    readSkillSupportingFile: typeof readSkillSupportingFile;
    writeSkillSupportingFile: typeof writeSkillSupportingFile;
    deleteSkillSupportingFile: typeof deleteSkillSupportingFile;
    SKILL_SCOPE: typeof SKILL_SCOPE;
    SKILL_DIR: string;
    getCuratedSkillsSources: typeof getCuratedSkillsSources;
    getCacheKey: typeof getCacheKey;
    scanWithCache: typeof scanWithCache;
    parseSkillRepoSource: typeof parseSkillRepoSource;
    scanSkillsRepository: typeof scanSkillsRepository;
    installSkillsFromRepository: typeof installSkillsFromRepository;
    fetchGitHubRepoMetas: typeof fetchGitHubRepoMetas;
    getProfiles: () => StoredGitIdentityProfile[];
    getProfile: (id: JsonValue) => StoredGitIdentityProfile | null;
    createHttpsCredentialReference?: typeof createHttpsCredentialReference;
    resolveSourceControlAccount?: (account: ProviderAccount) => Promise<TransportAccount | null>;
  };

const hasCatalogFields = (value: unknown): value is CatalogBody => value != null;
const isProviderAccount = (value: unknown): value is ProviderAccount => isRecord(value)
  && isString(value.provider) && isString(value.instance) && isString(value.accountId);
const hasMutationFields = (value: unknown): value is MutationFields => value != null;
const hasErrorFields = (value: unknown): value is ErrorFields => value != null;
const hasScanFields = (value: unknown): value is CachedScan => value != null;
const hasCachedSkillFields = (value: unknown): value is CachedSkill => value != null;
const hasKind = (value: unknown): value is { kind?: unknown } => value != null;
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const readInstallSelections = (value: CatalogBody['selections']) => {
  if (!isList(value)) return undefined;
  return value.map((item) => {
    const selection: { skillDir?: JsonValue } = Object(item);
    return selection;
  });
};
const isAccessError = (value: unknown): value is ErrorFields & { code: 'EACCES' | 'EPERM' } =>
  value !== null && typeof value === 'object' && hasErrorFields(value) && (value.code === 'EACCES' || value.code === 'EPERM');
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isScope = (value: string | null): value is ListedSkill['scope'] => value === 'user' || value === 'project';
const isSource = (value: string | null): value is SkillSource => value === 'opencode' || value === 'claude' || value === 'agents';
const isEnvFlagEnabled = (value: NodeJS.ProcessEnv[string]) => {
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '0' && normalized !== 'false';
};

const errorMessage = (cause: unknown) => {
  if (!hasErrorFields(cause)) throw new TypeError('Cannot read skill error message');
  return cause.message;
};

export const registerSkillRoutes = (app: Application, dependencies: SkillRouteOptions) => {
  const {
    fs,
    path,
    os,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    readSettingsFromDisk,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    buildOpenCodeUrl,

    getOpenCodeAuthHeaders,
    getOpenCodePort,
    getSkillSources,
    discoverSkills,
    mergeDiscoveredSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    renameSkill,
    isManagedSkillPath,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
    getCuratedSkillsSources,
    getCacheKey,
    scanWithCache,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    fetchGitHubRepoMetas,
    getProfiles,
    getProfile,
    createHttpsCredentialReference,
    resolveSourceControlAccount,
    credentialResolver,
  } = dependencies;

  const resolveCatalogGitIdentity = async (identityId: JsonValue | undefined, source: JsonValue | undefined): Promise<CatalogIdentity> => {
    if (!identityId || identityId === 'global') return { ok: true, identity: null };

    const profile = getProfile(identityId);
    if (!profile) {
      return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
    }

    const transport = profile.transport ?? 'system';
    if (transport === 'system') return { ok: true, identity: null };
    if (transport === 'anonymous') return { ok: true, identity: { anonymous: true, transport } };

    const parsed = parseSkillRepoSource(source);
    if (!parsed.ok) return { ok: true, identity: null };

    if (transport === 'ssh') {
      if (profile.sshCredentialId !== undefined && !isString(profile.sshCredentialId)) return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      return {
        ok: true,
        identity: {
          transport,
          credentialId: profile.sshCredentialId,
          endpoint: parsed.cloneUrlSsh,
        },
      };
    }

    const profileAccount = isProviderAccount(profile.account) ? profile.account : null;
    if (transport === 'account' && profileAccount && resolveSourceControlAccount && createHttpsCredentialReference) {
      const account = await resolveSourceControlAccount(profileAccount);
      if (!account || account.credentialId !== profileAccount.accountId
        || account.status !== 'valid'
        || !Number.isSafeInteger(account.credentialRevision)
        || account.credentialRevision < 1) {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }

      let credentialId;
      try {
        credentialId = createHttpsCredentialReference({
          provider: profileAccount.provider,
          instance: profileAccount.instance,
          credentialId: account.credentialId,
          credentialRevision: account.credentialRevision,
          providerUserId: account.providerUserId,
        });
      } catch {
        return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
      }

      return {
        ok: true,
        identity: {
          transport: 'https',
          credentialId,
          endpoint: parsed.cloneUrlHttps,
        },
      };
    }

    return { ok: false, error: { kind: 'authRequired', message: 'Selected Git identity is unavailable' } };
  };

  const { fetchOpenCodeDiscoveredSkills, resolveSkillsDirectory } = createSkillDiscovery({
    fs, path, os, SKILL_SCOPE, getOpenCodePort, buildOpenCodeUrl, getOpenCodeAuthHeaders,
    resolveOptionalProjectDirectory, resolveProjectDirectory,
  });

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };


  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const openCodeSkills = await fetchOpenCodeDiscoveredSkills(directory);
      const parsedFiles: ParsedSkillFiles = new Map();
      const localSkills = await discoverSkills(directory, { parsedFiles });
      const skills = mergeDiscoveredSkills(openCodeSkills ?? [], localSkills);

      const enrichedSkills = [];
      for (const skill of skills) {
        const sources = await getSkillSources(skill.name, directory, skill, { includeSupportingFiles: false, parsedFiles });
        const skillPath = isString(skill.path) ? skill.path : null;
        enrichedSkills.push({
          ...skill,
          sources,
          renamable: Boolean(
            skillPath
            && skillPath !== '<built-in>'
            && isManagedSkillPath(skillPath, directory)
          ),
        });
      }

      const body = {
        skills: enrichedSkills,
        externalSkills: {
          claudeDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE)
            || isEnvFlagEnabled(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
          allDisabled: isEnvFlagEnabled(process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS),
        },
      };
      res.json(openCodeSkills === null ? { ...body, openCodeSkillsUnavailable: true } : body);
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.put('/api/config/skill-switch', async (req, res) => {
    try {
      const parsed = skillSwitchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'id must be a skill id, enabled a boolean and scope user or project' });
      }
      const { id, enabled, scope } = parsed.data;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error || (scope === 'project' && !directory)) {
        return res.status(400).json({ error: error || 'A project skill needs a directory' });
      }
      res.json(setSkillEnabled({ id, enabled, scope, directory }));
    } catch (error) {
      console.error('Failed to switch skill:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to switch skill' });
    }
  });

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources: CatalogSource[] = [...curatedSources, ...customSources];

      const githubRepos = sources
        .map((src) => parseSkillRepoSource(src.source))
        .flatMap((parsed) => parsed.ok && parsed.host === 'github.com' ? [parsed.normalizedRepo] : []);
      const repoMetas = await fetchGitHubRepoMetas(githubRepos);

      const sourcesForUi = sources.map(({ gitIdentityId: _gitIdentityId, excludedSkills: _excludedSkills, ...rest }) => {
        const parsed = parseSkillRepoSource(rest.source);
        const meta: RepoMetaFields = parsed.ok && parsed.host === 'github.com'
          ? repoMetas[parsed.normalizedRepo] || {}
          : {};
        return {
          ...rest,
          stars: isNumber(meta.stars) ? meta.stars : null,
          repoUpdatedAt: isString(meta.repoUpdatedAt) ? meta.repoUpdatedAt : null,
        };
      });

      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: errorMessage(error) || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const sourceId = isString(req.query.sourceId) ? req.query.sourceId : null;
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources: CatalogSource[] = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
      }

      const resolvedDiscovered = mergeDiscoveredSkills(
        (await fetchOpenCodeDiscoveredSkills(directory)) ?? [],
        await discoverSkills(directory),
      );
      const installedByName = new Map(resolvedDiscovered.map((s) => [s.name, s]));

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        ref: parsed.ref,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });
      const resolvedIdentity = await resolveCatalogGitIdentity(src.gitIdentityId, src.source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const scanResult = await scanWithCache(
        cacheKey,
        () => scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolvedIdentity.identity,
          credentialResolver,
        }),
        { refresh },
      );

      if (!hasScanFields(scanResult)) throw new TypeError('Cannot read catalog scan');
      if (!scanResult.ok) {
        if (hasKind(scanResult.error) && scanResult.error.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: { ...scanResult.error, identities: listGitIdentitiesForResponse() },
          });
        }
        return res.status(500).json({ ok: false, error: scanResult.error });
      }

      const excludedSkills = new Set<unknown>(src.excludedSkills || []);
      const provenanceByName = readInstalledSourcesForProject(directory ? fs.realpathSync(directory) : null);
      const scannedItems = scanResult.items || [];
      if (!isList(scannedItems)) throw new TypeError('Catalog scan items must be an array');
      const items = scannedItems.filter((item): item is CachedSkill => {
        if (!hasCachedSkillFields(item)) throw new TypeError('Cannot read catalog skill');
        return !excludedSkills.has(item.skillName);
      }).map((item) => {
        const skillName = isString(item.skillName) ? item.skillName : undefined;
        const installed = skillName === undefined ? undefined : installedByName.get(skillName);
        const isInstalled = installed && skillName !== undefined
          && isInstalledFromSource(provenanceByName, skillName, src.id, item.skillDir, installed.scope);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: isInstalled
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({
        ok: false,
        error: { kind: 'unknown', message: errorMessage(error) || 'Failed to load catalog source' },
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = hasCatalogFields(req.body) ? req.body : {};
      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const result = await scanSkillsRepository({
        source: isString(source) ? source : undefined,
        subpath,
        identity: resolvedIdentity.identity,
        credentialResolver,
      });

      if (!result.ok) {
        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: errorMessage(error) || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        sourceId,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = hasCatalogFields(req.body) ? req.body : {};

      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          });
        }
        workingDirectory = resolved.directory;
      }

      const resolvedIdentity = await resolveCatalogGitIdentity(gitIdentityId, source);
      if (!resolvedIdentity.ok) {
        return res.status(401).json({
          ok: false,
          error: { ...resolvedIdentity.error, identities: listGitIdentitiesForResponse() },
        });
      }

      const decisions: JsonObject | null | undefined = conflictDecisions == null ? conflictDecisions : Object(conflictDecisions);
      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity: resolvedIdentity.identity,
        credentialResolver,
        scope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections: readInstallSelections(selections),
        conflictPolicy,
        conflictDecisions: decisions,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') {
          return res.status(409).json({ ok: false, error: result.error });
        }

        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const installedAny = installed.length > 0;
      const provenanceSourceId = asNonEmptyString(sourceId);

      if (installedAny && provenanceSourceId) {
        try {
          const projectDirectory = workingDirectory ? fs.realpathSync(workingDirectory) : null;
          appendInstalledSources(installed.map((entry) => {
            const row = {
              skillName: entry.skillName,
              skillDir: entry.skillDir,
              scope: entry.scope,
              source: entry.source,
              sourceId: provenanceSourceId,
              sourceRef: source,
            };
            return entry.scope === 'project' && projectDirectory ? { projectDirectory, ...row } : row;
          }));
        } catch (error) {
          console.error('Failed to record skill install provenance:', error);
        }
      }

      res.json({
        ok: true,
        installed,
        skipped,
        ...(installedAny
          ? buildAppliedResponse('Skills installed successfully.')
          : {
            requiresReload: false,
            message: 'No skills were installed',
          }),
      });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: errorMessage(error) || 'Failed to install skills' } });
    }
  });

  const toCloneIdentity = (identity: CatalogGitIdentity | null): CatalogCloneIdentity => {
    if (!identity) return null;
    if (identity.anonymous === true) return { transport: 'anonymous', anonymous: true };
    const transport = identity.transport === 'ssh' || identity.transport === 'account' || identity.transport === 'https'
      ? identity.transport
      : 'https';
    const converted: NonNullable<CatalogCloneIdentity> = { transport };
    if (identity.credentialId !== undefined) converted.credentialId = identity.credentialId;
    if (identity.endpoint !== undefined) converted.endpoint = identity.endpoint;
    return converted;
  };

  const resolveInstalledUpdateIdentity = async (sourceId: string, sourceRef: string): Promise<InstalledUpdateIdentity> => {
    const settings = await readSettingsFromDisk();
    const custom = (sanitizeSkillCatalogs(settings.skillCatalogs) || []).map((entry) => ({
      id: entry.id,
      source: entry.source,
      gitIdentityId: entry.gitIdentityId,
    }));
    const matched = [...getCuratedSkillsSources(), ...custom].find((entry) => entry.id === sourceId);
    const resolved = await resolveCatalogGitIdentity(matched && 'gitIdentityId' in matched ? matched.gitIdentityId : undefined, matched?.source ?? sourceRef);
    if (!resolved.ok) return resolved;
    return { ok: true, identity: toCloneIdentity(resolved.identity) };
  };

  const targetDirForInstalledSkill = (directory: Directory) => (
    { scope, source, skillName }: { scope: string; source: string; skillName: string }
  ): string | null => {
    if ((scope !== 'project' && scope !== 'user') || (scope === 'project' && !directory)) return null;
    return getTargetSkillDir({
      scope,
      targetSource: source,
      workingDirectory: directory,
      userSkillDir: SKILL_DIR,
      skillName,
    });
  };

  app.post('/api/config/skills/catalog/update', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const plan = planInstalledSkillUpdates({
        provenanceByName: readInstalledSources(),
        projectDirectory: directory ? fs.realpathSync(directory) : null,
        targetDirFor: targetDirForInstalledSkill(directory),
        skillExists: (targetDir) => fs.existsSync(path.join(targetDir, 'SKILL.md')),
      });

      const dryRun = isRecord(req.body) && req.body.dryRun === true;
      if (dryRun) {
        return res.json({ ok: true, plan });
      }

      if (plan.length === 0) {
        return res.json({
          ok: true,
          results: [],
          updated: 0,
          skipped: 0,
          failed: 0,
          message: 'No installed skill came from a catalog source',
        });
      }

      const outcome = await updateInstalledSkills({
        plan,
        resolveIdentity: resolveInstalledUpdateIdentity,
        install: async (input: InstalledUpdateInstallInput): Promise<InstalledUpdateInstallOutcome> => (
          installSkillsFromRepository({
            source: input.source,
            identity: input.identity ?? null,
            credentialResolver,
            scope: input.scope,
            targetSource: input.targetSource,
            workingDirectory: input.workingDirectory ?? null,
            userSkillDir: input.userSkillDir,
            selections: input.selections,
            conflictPolicy: input.conflictPolicy,
          })
        ),
        workingDirectory: directory,
        userSkillDir: SKILL_DIR,
      });

      if (!outcome.ok) {
        return res.status(outcome.error.kind === 'busy' ? 409 : 500).json({ ok: false, error: outcome.error });
      }

      const results = outcome.results ?? [];
      const countOf = (status: 'updated' | 'skipped' | 'failed') => results.filter((entry) => entry.status === status).length;
      const updated = countOf('updated');
      return res.json({
        ok: true,
        results,
        updated,
        skipped: countOf('skipped'),
        failed: countOf('failed'),
        message: updated > 0 ? 'Installed skills updated' : 'No skill was replaced',
      });
    } catch (error) {
      console.error('Failed to update installed skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: errorMessage(error) || 'Failed to update installed skills' } });
    }
  });

  app.post('/api/config/skills/user/sync', async (req, res) => {
    try {
      const dryRun = isRecord(req.body) && req.body.dryRun === true;
      const outcome = await syncUserSkills({ homeDir: os.homedir(), dryRun });
      if (!outcome.ok) {
        return res.status(outcome.error.kind === 'busy' ? 409 : 500).json(outcome);
      }
      return res.json(outcome);
    } catch (error) {
      console.error('Failed to sync user skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: errorMessage(error) || 'Failed to sync user skills' } });
    }
  });

  app.get<unknown, SkillParams>('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) ?? [])
        .find((skill) => skill.name === skillName) || null;
      const sources = await getSkillSources(skillName, directory, discoveredSkill);

      res.json({
        name: skillName,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  app.get<unknown, SkillFileParams>('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(String(req.params.filePath));
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) ?? [])
        .find((skill) => skill.name === skillName) || null;
      const sources = await getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      if (isAccessError(error)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  app.post<unknown, SkillParams>('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      if (!hasMutationFields(req.body)) throw new TypeError('Cannot read skill fields');
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = scope === SKILL_SCOPE.PROJECT
        ? await resolveProjectDirectory(req)
        : await resolveSkillsDirectory(req);
      if (error || (scope === SKILL_SCOPE.PROJECT && !directory)) {
        return res.status(400).json({ error: error || 'Project skill creation requires a directory' });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      await createSkill(skillName, { ...config, source: skillSource }, directory, scope);
      res.json(buildAppliedResponse(
        `Skill ${skillName} created successfully.`,
      ));
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to create skill' });
    }
  });

  app.patch<unknown, SkillParams>('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      if (hasMutationFields(updates) && isString(updates.renameTo)) {
        const newName = updates.renameTo.trim();
        console.log(`[Server] Renaming skill: ${skillName} -> ${newName}`);
        console.log('[Server] Working directory:', directory);
        await renameSkill(skillName, newName, directory);
        return res.json({
          ...buildAppliedResponse(`Skill renamed to ${newName} successfully.`),
          name: newName,
        });
      }

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      await updateSkill(skillName, updates, directory, hasMutationFields(updates) ? updates.targetPath : undefined);
      res.json(buildAppliedResponse(
        `Skill ${skillName} updated successfully.`,
      ));
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to update skill' });
    }
  });

  app.put<unknown, SkillFileParams>('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(String(req.params.filePath));
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      if (!hasMutationFields(req.body)) throw new TypeError('Cannot read skill file content');
      const { content } = req.body;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) ?? [])
        .find((skill) => skill.name === skillName) || null;
      const sources = await getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      if (isAccessError(error)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to write skill file' });
    }
  });

  app.delete<unknown, SkillFileParams>('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(String(req.params.filePath));
      if (isUnsafeSkillRelativePath(filePath)) {
        return res.status(400).json({ error: 'Invalid file path' });
      }
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) ?? [])
        .find((skill) => skill.name === skillName) || null;
      const sources = await getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      if (isAccessError(error)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to delete skill file' });
    }
  });

  app.delete<unknown, SkillParams>('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveSkillsDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const scope = asNonEmptyString(req.query.scope);
      const source = asNonEmptyString(req.query.source);
      let location: Parameters<typeof deleteSkill>[2];
      if (scope || source) {
        if (!isScope(scope) || !isSource(source)) {
          return res.status(400).json({ error: 'scope must be user or project and source opencode, claude or agents' });
        }
        location = { scope, source };
      }

      deleteSkill(skillName, directory, location);
      try {
        const projectDirectory = directory ? fs.realpathSync(directory) : null;
        removeInstalledSources(skillName, (entry) => {
          if (location && (entry.scope !== location.scope || entry.source !== location.source)) return false;
          return entry.scope === 'user' || Boolean(projectDirectory && entry.projectDirectory === projectDirectory);
        });
      } catch (error) {
        console.error('Failed to forget skill install provenance:', error);
      }
      res.json(buildAppliedResponse(
        `Skill ${skillName} deleted successfully.`,
      ));
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: errorMessage(error) || 'Failed to delete skill' });
    }
  });
};
