import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type UserSkillSyncAgent = 'claude' | 'codex';

export interface UserSkillSyncSource {
  agent: UserSkillSyncAgent;
  plugin: string;
  version: string;
}

export type UserSkillSyncStatus = 'update' | 'current' | 'external' | 'noSource';

export interface UserSkillSyncPlanItem {
  skillName: string;
  status: UserSkillSyncStatus;
  source: UserSkillSyncSource | null;
}

export interface UserSkillSyncResult {
  skillName: string;
  status: 'updated' | 'skipped' | 'failed';
  reason?: UserSkillSyncStatus;
  kind?: 'copyFailed';
  message?: string;
  source: UserSkillSyncSource | null;
}

export interface UserSkillSyncPlan {
  ok: true;
  plan: UserSkillSyncPlanItem[];
}

export interface UserSkillSyncRun {
  ok: true;
  results: UserSkillSyncResult[];
  updated: number;
  skipped: number;
  failed: number;
}

export interface UserSkillSyncError {
  kind: 'busy' | 'unknown';
  message: string;
}

export type UserSkillSyncOutcome =
  | UserSkillSyncPlan
  | UserSkillSyncRun
  | { ok: false; error: UserSkillSyncError };

export interface SyncUserSkillsOptions {
  homeDir: string;
  dryRun?: boolean | undefined;
  copySkillDir?: ((sourceDir: string, targetDir: string) => void | Promise<void>) | undefined;
}

interface PluginSkillCandidate {
  agent: UserSkillSyncAgent;
  plugin: string;
  version: string;
  dir: string;
}

interface InternalPlanItem extends UserSkillSyncPlanItem {
  sourceDir: string | null;
}

type VersionPart =
  | { numeric: true; value: number }
  | { numeric: false; value: string };

const SKILL_FILE = 'SKILL.md';
const USER_SKILLS_PATH: readonly string[] = ['.agents', 'skills'];

const PLUGIN_CACHE_ROOTS: ReadonlyArray<{ agent: UserSkillSyncAgent; path: readonly string[] }> = [
  { agent: 'claude', path: ['.claude', 'plugins', 'cache'] },
  { agent: 'codex', path: ['.codex', 'plugins', 'cache'] },
];

const AGENT_ORDER = { claude: 0, codex: 1 } satisfies Readonly<Record<UserSkillSyncAgent, number>>;

const versionParts = (value: string): VersionPart[] => value
  .split(/[^0-9A-Za-z]+/)
  .filter(Boolean)
  .map((part): VersionPart => (/^\d+$/.test(part) ? { numeric: true, value: Number(part) } : { numeric: false, value: part }));

const compareVersions = (left: string, right: string): number => {
  const a = versionParts(left);
  const b = versionParts(right);
  const emptyPart: VersionPart = { numeric: false, value: '' };
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? emptyPart;
    const second = b[index] ?? emptyPart;
    if (first.numeric !== second.numeric) return first.numeric ? 1 : -1;
    if (first.value !== second.value) return first.value > second.value ? 1 : -1;
  }
  return 0;
};

const readEntries = (directory: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const readDirectories = (directory: string): fs.Dirent[] => readEntries(directory).filter((entry) => entry.isDirectory());

const readPluginSkillSources = (homeDir: string): Map<string, PluginSkillCandidate[]> => {
  const sources = new Map<string, PluginSkillCandidate[]>();
  for (const root of PLUGIN_CACHE_ROOTS) {
    const cacheRoot = path.join(homeDir, ...root.path);
    for (const marketplace of readDirectories(cacheRoot)) {
      for (const plugin of readDirectories(path.join(cacheRoot, marketplace.name))) {
        for (const version of readDirectories(path.join(cacheRoot, marketplace.name, plugin.name))) {
          const skillsRoot = path.join(cacheRoot, marketplace.name, plugin.name, version.name, 'skills');
          for (const skill of readDirectories(skillsRoot)) {
            const dir = path.join(skillsRoot, skill.name);
            if (!fs.existsSync(path.join(dir, SKILL_FILE))) continue;
            const candidates = sources.get(skill.name) ?? [];
            candidates.push({ agent: root.agent, plugin: plugin.name, version: version.name, dir });
            sources.set(skill.name, candidates);
          }
        }
      }
    }
  }
  return sources;
};

const pickSource = (candidates: PluginSkillCandidate[]): PluginSkillCandidate | null => {
  const [chosen] = [...candidates].sort((left, right) => (
    compareVersions(right.version, left.version)
    || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
    || left.plugin.localeCompare(right.plugin)
  ));
  return chosen ?? null;
};

const hashFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const treeManifest = (directory: string): string[] => {
  const entries: string[] = [];
  const walk = (current: string, relative: string) => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const child of children) {
      const childPath = path.join(current, child.name);
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      if (child.isSymbolicLink()) {
        entries.push(`link:${childRelative}:${fs.readlinkSync(childPath)}`);
      } else if (child.isDirectory()) {
        entries.push(`dir:${childRelative}`);
        walk(childPath, childRelative);
      } else if (child.isFile()) {
        entries.push(`file:${childRelative}:${hashFile(childPath)}`);
      }
    }
  };
  walk(directory, '');
  return entries;
};

const sameTree = (left: string, right: string): boolean => {
  const a = treeManifest(left);
  const b = treeManifest(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};

const publicSource = (source: PluginSkillCandidate): UserSkillSyncSource => ({
  agent: source.agent,
  plugin: source.plugin,
  version: source.version,
});

const buildPlan = (homeDir: string) => {
  const userRoot = path.join(homeDir, ...USER_SKILLS_PATH);
  const sources = readPluginSkillSources(homeDir);
  const plan: InternalPlanItem[] = [];
  for (const entry of readEntries(userRoot)) {
    const dir = path.join(userRoot, entry.name);
    const source = sources.get(entry.name);
    const chosen = source?.length ? pickSource(source) : null;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      plan.push({
        skillName: entry.name,
        status: 'external',
        source: chosen ? publicSource(chosen) : null,
        sourceDir: chosen?.dir ?? null,
      });
      continue;
    }
    if (!stat.isDirectory() || !fs.existsSync(path.join(dir, SKILL_FILE))) continue;
    if (!chosen) {
      plan.push({ skillName: entry.name, status: 'noSource', source: null, sourceDir: null });
      continue;
    }
    plan.push({
      skillName: entry.name,
      status: sameTree(dir, chosen.dir) ? 'current' : 'update',
      source: publicSource(chosen),
      sourceDir: chosen.dir,
    });
  }
  plan.sort((left, right) => left.skillName.localeCompare(right.skillName));
  return { plan, userRoot };
};

const replaceSkillDir = (sourceDir: string, targetDir: string): void => {
  const parent = path.dirname(targetDir);
  const base = path.basename(targetDir);
  const staging = path.join(parent, `.${base}.sync-${process.pid}-${Date.now()}`);
  const backup = `${staging}.bak`;
  fs.cpSync(sourceDir, staging, { recursive: true, verbatimSymlinks: true });
  try {
    fs.renameSync(targetDir, backup);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  try {
    fs.renameSync(staging, targetDir);
  } catch (error) {
    fs.renameSync(backup, targetDir);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
};

let running = false;

export const syncUserSkills = async ({
  homeDir,
  dryRun = false,
  copySkillDir = replaceSkillDir,
}: SyncUserSkillsOptions): Promise<UserSkillSyncOutcome> => {
  if (running) return { ok: false, error: { kind: 'busy', message: 'A user skill sync is already running' } };
  running = true;
  try {
    const { plan, userRoot } = buildPlan(homeDir);
    if (dryRun) {
      return {
        ok: true,
        plan: plan.map(({ skillName, status, source }) => ({ skillName, status, source })),
      };
    }

    const results: UserSkillSyncResult[] = [];
    for (const item of plan) {
      if (item.status !== 'update' || !item.sourceDir) {
        results.push({ skillName: item.skillName, status: 'skipped', reason: item.status, source: item.source });
        continue;
      }
      try {
        await copySkillDir(item.sourceDir, path.join(userRoot, item.skillName));
        results.push({ skillName: item.skillName, status: 'updated', source: item.source });
      } catch (error) {
        results.push({
          skillName: item.skillName,
          status: 'failed',
          kind: 'copyFailed',
          message: error instanceof Error ? error.message : 'Failed to copy the skill',
          source: item.source,
        });
      }
    }
    const countOf = (status: UserSkillSyncResult['status']) => results.filter((entry) => entry.status === status).length;
    return { ok: true, results, updated: countOf('updated'), skipped: countOf('skipped'), failed: countOf('failed') };
  } finally {
    running = false;
  }
};
