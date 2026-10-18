// Replaces skills that were installed from a catalog source with the source's
// current content. The record an install leaves behind (repo, subdirectory,
// scope, target source) is the whole plan: a skill the user wrote, or one whose
// recorded directory is no longer on disk, is not touched.
//
// One update run at a time. Two runs would clone and copy onto the same target
// directories, and the loser's copy would end up half one source and half the
// other.

import path from 'node:path';

import { asNonEmptyString } from '../shared/guards.js';

const FAILURE_KINDS = new Set(['authRequired', 'gitUnavailable', 'networkError', 'invalidSource', 'unknown']);

const planKey = (item) => [item.skillName, item.scope, item.source].join('\u0000');
const groupKey = (item) => [item.sourceRef, item.scope, item.source].join('\u0000');
const resultOf = (item) => ({ skillName: item.skillName, scope: item.scope, source: item.source });

/**
 * One normalized record as a plan candidate, or null when it cannot be
 * replayed. `readInstalledSources` trims the strings and nulls a scope or
 * target source this version does not know, so this branches on those values.
 */
const recordedPlanItem = (entry) => {
  if (entry.scope !== 'user' && entry.scope !== 'project') return null;
  if (entry.source !== 'opencode' && entry.source !== 'agents') return null;
  if (!entry.skillName || !entry.skillDir || !entry.sourceId || !entry.sourceRef) return null;
  // The install names the target after the repo directory. A record whose name
  // disagrees would install a different skill than the user asked to update.
  if (path.posix.basename(entry.skillDir) !== entry.skillName) return null;
  return {
    skillName: entry.skillName,
    skillDir: entry.skillDir,
    scope: entry.scope,
    source: entry.source,
    sourceId: entry.sourceId,
    sourceRef: entry.sourceRef,
  };
};

/**
 * The skills an update would replace. `targetDirFor` returns the directory the
 * install writes to, and `skillExists` says whether a SKILL.md still sits there.
 * A record whose files are gone is left out: updating it would recreate a skill
 * the user removed.
 *
 * @param {object} options
 * @param {Map<string, object[]>} options.provenanceByName installs keyed by skill name, normalized by `readInstalledSources`
 * @param {(item: { skillName: string, scope: string, source: string }) => string | null} options.targetDirFor
 * @param {(targetDir: string) => boolean} options.skillExists
 * @returns {Array<{ skillName: string, skillDir: string, scope: string, source: string, sourceId: string, sourceRef: string }>}
 */
export const planInstalledSkillUpdates = ({ provenanceByName, targetDirFor, skillExists }) => {
  const latestByTarget = new Map();
  for (const entries of provenanceByName.values()) {
    for (const entry of entries ?? []) {
      const item = recordedPlanItem(entry ?? {});
      // A later install of the same name, scope and target overwrote the
      // earlier one, so the last record describes what is on disk.
      if (item) latestByTarget.set(planKey(item), item);
    }
  }

  const plan = [];
  for (const item of latestByTarget.values()) {
    const targetDir = targetDirFor(item);
    if (!targetDir || !skillExists(targetDir)) continue;
    plan.push(item);
  }
  plan.sort((left, right) => left.skillName.localeCompare(right.skillName) || left.scope.localeCompare(right.scope));
  return plan;
};

const failedResults = (group, error) => {
  const kind = FAILURE_KINDS.has(error?.kind) ? error.kind : 'unknown';
  const reason = asNonEmptyString(error?.message) ?? 'The source could not be updated';
  return group.map((item) => ({ ...resultOf(item), status: 'failed', kind, reason }));
};

const replaceGroups = async ({ plan, resolveIdentity, install, workingDirectory, userSkillDir }) => {
  const groups = new Map();
  for (const item of plan) {
    const key = groupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const results = [];
  // Sequential on purpose: each group clones a repository and writes to disk,
  // and the sources are few.
  for (const group of groups.values()) {
    const [first] = group;
    const identity = await resolveIdentity(first.sourceId, first.sourceRef);
    if (!identity?.ok) {
      results.push(...failedResults(group, identity?.error ?? {
        kind: 'authRequired', message: 'Authentication required to access this repository',
      }));
      continue;
    }

    let outcome;
    try {
      outcome = await install({
        source: first.sourceRef,
        identity: identity.identity,
        scope: first.scope,
        targetSource: first.source,
        workingDirectory: first.scope === 'project' ? workingDirectory : undefined,
        userSkillDir,
        selections: group.map((item) => ({ skillDir: item.skillDir })),
        conflictPolicy: 'overwriteAll',
      });
    } catch (error) {
      outcome = { ok: false, error: { kind: 'unknown', message: error instanceof Error ? error.message : 'Failed to update skills' } };
    }

    if (!outcome?.ok) {
      results.push(...failedResults(group, outcome?.error));
      continue;
    }

    const replaced = new Set((outcome.installed ?? []).map((entry) => entry.skillName));
    const skippedReasons = new Map((outcome.skipped ?? []).map((entry) => [entry.skillName, entry.reason]));
    for (const item of group) {
      if (replaced.has(item.skillName)) {
        results.push({ ...resultOf(item), status: 'updated' });
        continue;
      }
      const skipped = { ...resultOf(item), status: 'skipped' };
      const reason = skippedReasons.get(item.skillName);
      if (reason) skipped.reason = reason;
      results.push(skipped);
    }
  }

  return results;
};

let running = false;

/**
 * Replace every planned skill with its source's current content.
 *
 * @param {object} options
 * @param {Array<object>} options.plan items from `planInstalledSkillUpdates`
 * @param {(sourceId: string, sourceRef: string) => Promise<{ ok: boolean, identity?: object | null, error?: object }>} options.resolveIdentity
 * @param {Function} options.install the catalog install function
 * @param {string | null} options.workingDirectory project directory for project-scope installs
 * @param {string} options.userSkillDir user-level OpenCode skills directory
 * @returns {Promise<{ ok: true, results: object[] } | { ok: false, error: { kind: string, message: string } }>}
 */
export const updateInstalledSkills = async (options) => {
  if (running) return { ok: false, error: { kind: 'busy', message: 'An update is already running' } };
  running = true;
  try {
    return { ok: true, results: await replaceGroups(options) };
  } finally {
    running = false;
  }
};
