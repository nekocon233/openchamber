// Refreshes the user-level skill library (`~/.agents/skills`) from the skills
// bundled with the installed Claude Code and Codex plugins. Nothing records
// where a directory in that library came from, so the plan matches by name
// against the plugin caches under the same home. A symlink, a skill with a
// local edit that no plugin ships, or a name no plugin knows is reported and
// left alone: this module cannot know its source.
//
// One run at a time. Two runs would replace the same directories, and the
// loser's copy could end up half one source and half the other.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKILL_FILE = 'SKILL.md';
const USER_SKILLS_PATH = ['.agents', 'skills'];

/** Installed plugin caches, in preference order for equal versions. */
const PLUGIN_CACHE_ROOTS = [
  { agent: 'claude', path: ['.claude', 'plugins', 'cache'] },
  { agent: 'codex', path: ['.codex', 'plugins', 'cache'] },
];

const AGENT_ORDER = { claude: 0, codex: 1 };

const versionParts = (value) => value
  .split(/[^0-9A-Za-z]+/)
  .filter(Boolean)
  .map((part) => (/^\d+$/.test(part) ? { numeric: true, value: Number(part) } : { numeric: false, value: part }));

/** Highest version first; a natural order keeps `0.10` above `0.9`. */
const compareVersions = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? { numeric: false, value: '' };
    const second = b[index] ?? { numeric: false, value: '' };
    if (first.numeric !== second.numeric) return first.numeric ? 1 : -1;
    if (first.value !== second.value) return first.value > second.value ? 1 : -1;
  }
  return 0;
};

const readEntries = (directory) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const readDirectories = (directory) => readEntries(directory).filter((entry) => entry.isDirectory());

/**
 * Every skill an installed plugin ships, keyed by skill name. The cache layout
 * is `<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md` for both CLIs.
 * @param {string} homeDir
 * @returns {Map<string, Array<{ agent: 'claude' | 'codex', plugin: string, version: string, dir: string }>>}
 */
const readPluginSkillSources = (homeDir) => {
  const sources = new Map();
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

/**
 * The copy a skill should come from: highest version, Claude Code before
 * Codex on a tie, then plugin name so the choice is stable.
 * @param {Array<{ agent: 'claude' | 'codex', plugin: string, version: string, dir: string }>} candidates
 */
const pickSource = (candidates) => [...candidates].sort((left, right) => (
  compareVersions(right.version, left.version)
  || AGENT_ORDER[left.agent] - AGENT_ORDER[right.agent]
  || left.plugin.localeCompare(right.plugin)
))[0];

const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A sorted manifest of a directory tree, so two copies can be compared. */
const treeManifest = (directory) => {
  const entries = [];
  const walk = (current, relative) => {
    let children;
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

const sameTree = (left, right) => {
  const a = treeManifest(left);
  const b = treeManifest(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};

const publicSource = (source) => ({
  agent: source.agent,
  plugin: source.plugin,
  version: source.version,
});

/**
 * The internal plan: one entry per directory that looks like a skill, with the
 * absolute source directory the run needs. The route strips `sourceDir`.
 * @param {string} homeDir
 */
const buildPlan = (homeDir) => {
  const userRoot = path.join(homeDir, ...USER_SKILLS_PATH);
  const sources = readPluginSkillSources(homeDir);
  const plan = [];
  for (const entry of readEntries(userRoot)) {
    const dir = path.join(userRoot, entry.name);
    const source = sources.get(entry.name);
    const chosen = source?.length ? pickSource(source) : null;
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      plan.push({ skillName: entry.name, status: 'external', source: chosen ? publicSource(chosen) : null, sourceDir: chosen?.dir ?? null });
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

/**
 * Replace one copied skill with the source's content. The old directory is
 * moved aside until the new one is in place, so a failed copy leaves the
 * previous skill usable.
 */
const replaceSkillDir = (sourceDir, targetDir) => {
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

/**
 * Plan or run the user-level skill sync.
 *
 * @param {object} options
 * @param {string} options.homeDir home directory holding `.agents`, `.claude` and `.codex`
 * @param {boolean} [options.dryRun] plan only, write nothing
 * @param {(sourceDir: string, targetDir: string) => void | Promise<void>} [options.copySkillDir] test seam for the directory copy
 * @returns {Promise<
 *   { ok: true, plan: object[] } |
 *   { ok: true, results: object[], updated: number, skipped: number, failed: number } |
 *   { ok: false, error: { kind: string, message: string } }
 * >}
 */
export const syncUserSkills = async ({ homeDir, dryRun = false, copySkillDir = replaceSkillDir } = {}) => {
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

    const results = [];
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
    const countOf = (status) => results.filter((entry) => entry.status === status).length;
    return { ok: true, results, updated: countOf('updated'), skipped: countOf('skipped'), failed: countOf('failed') };
  } finally {
    running = false;
  }
};
