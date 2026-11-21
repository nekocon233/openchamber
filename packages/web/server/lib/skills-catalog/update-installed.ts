import path from 'node:path';

import type { InstalledSourceEntry } from './installed-sources.js';
import { asNonEmptyString } from '../shared/guards.js';

export interface InstalledUpdatePlanItem {
  skillName: string;
  skillDir: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
  sourceId: string;
  sourceRef: string;
}

export type InstalledUpdateFailureKind =
  | 'authRequired'
  | 'gitUnavailable'
  | 'networkError'
  | 'invalidSource'
  | 'unknown';

export interface InstalledUpdateResult {
  skillName: string;
  scope: 'user' | 'project';
  source: 'opencode' | 'agents';
  status: 'updated' | 'skipped' | 'failed';
  kind?: InstalledUpdateFailureKind;
  reason?: string;
}

export type CatalogCloneIdentity =
  | { transport: 'ssh' | 'account' | 'https'; credentialId?: string; endpoint?: string }
  | { transport: 'anonymous'; anonymous: true }
  | null;

export interface InstalledUpdateIdentity {
  ok: boolean;
  identity?: CatalogCloneIdentity;
  error?: { kind?: string; message?: string };
}

export interface InstalledUpdateInstallInput {
  source: string;
  identity?: CatalogCloneIdentity;
  scope: 'user' | 'project';
  targetSource: 'opencode' | 'agents';
  workingDirectory?: string;
  userSkillDir: string;
  selections: Array<{ skillDir: string }>;
  conflictPolicy: 'overwriteAll';
}

export interface InstalledUpdateInstallOutcome {
  ok: boolean;
  installed?: Array<{ skillName: string }>;
  skipped?: Array<{ skillName: string; reason?: string }>;
  error?: { kind?: string; message?: string };
}

export interface PlanInstalledSkillUpdatesOptions {
  provenanceByName: Map<string, InstalledSourceEntry[]>;
  projectDirectory?: string | null;
  targetDirFor: (item: { skillName: string; scope: string; source: string }) => string | null;
  skillExists: (targetDir: string) => boolean;
}

export interface UpdateInstalledSkillsOptions {
  plan: InstalledUpdatePlanItem[];
  resolveIdentity: (sourceId: string, sourceRef: string) => Promise<InstalledUpdateIdentity>;
  install: (input: InstalledUpdateInstallInput) => Promise<InstalledUpdateInstallOutcome>;
  workingDirectory?: string | null | undefined;
  userSkillDir: string;
}

const isFailureKind = (value: unknown): value is InstalledUpdateFailureKind =>
  value === 'authRequired'
  || value === 'gitUnavailable'
  || value === 'networkError'
  || value === 'invalidSource'
  || value === 'unknown';

const planKey = (item: InstalledUpdatePlanItem) => [item.skillName, item.scope, item.source].join('\u0000');
const groupKey = (item: InstalledUpdatePlanItem) => [item.sourceRef, item.scope, item.source].join('\u0000');
const resultOf = (item: InstalledUpdatePlanItem) => ({
  skillName: item.skillName,
  scope: item.scope,
  source: item.source,
});

const recordedPlanItem = (entry: InstalledSourceEntry | null | undefined): InstalledUpdatePlanItem | null => {
  if (!entry) return null;
  const scope = entry.scope;
  if (scope !== 'user' && scope !== 'project') return null;
  const source = entry.source;
  if (source !== 'opencode' && source !== 'agents') return null;
  const skillName = asNonEmptyString(entry.skillName);
  const skillDir = asNonEmptyString(entry.skillDir);
  const sourceId = asNonEmptyString(entry.sourceId);
  const sourceRef = asNonEmptyString(entry.sourceRef);
  if (!skillName || !skillDir || !sourceId || !sourceRef) return null;
  if (path.posix.basename(skillDir) !== skillName) return null;
  return {
    skillName,
    skillDir,
    scope,
    source,
    sourceId,
    sourceRef,
  };
};

export const planInstalledSkillUpdates = ({
  provenanceByName,
  projectDirectory,
  targetDirFor,
  skillExists,
}: PlanInstalledSkillUpdatesOptions): InstalledUpdatePlanItem[] => {
  const latestByTarget = new Map<string, InstalledUpdatePlanItem>();
  for (const entries of provenanceByName.values()) {
    for (const entry of entries ?? []) {
      if (entry.scope === 'project' && (!projectDirectory || entry.projectDirectory !== projectDirectory)) continue;
      const item = recordedPlanItem(entry);
      if (item) latestByTarget.set(planKey(item), item);
    }
  }

  const plan: InstalledUpdatePlanItem[] = [];
  for (const item of latestByTarget.values()) {
    const targetDir = targetDirFor(item);
    if (!targetDir || !skillExists(targetDir)) continue;
    plan.push(item);
  }
  plan.sort((left, right) => left.skillName.localeCompare(right.skillName) || left.scope.localeCompare(right.scope));
  return plan;
};

const failedResults = (
  group: InstalledUpdatePlanItem[],
  error: { kind?: string; message?: string } | undefined,
): InstalledUpdateResult[] => {
  const kind: InstalledUpdateFailureKind = isFailureKind(error?.kind) ? error.kind : 'unknown';
  const reason = asNonEmptyString(error?.message) ?? 'The source could not be updated';
  return group.map((item) => ({ ...resultOf(item), status: 'failed', kind, reason }));
};

const replaceGroups = async ({
  plan,
  resolveIdentity,
  install,
  workingDirectory,
  userSkillDir,
}: UpdateInstalledSkillsOptions): Promise<InstalledUpdateResult[]> => {
  const groups = new Map<string, InstalledUpdatePlanItem[]>();
  for (const item of plan) {
    const key = groupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const results: InstalledUpdateResult[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (!first) continue;
    const identity = await resolveIdentity(first.sourceId, first.sourceRef);
    if (!identity?.ok) {
      results.push(...failedResults(group, identity?.error ?? {
        kind: 'authRequired',
        message: 'Authentication required to access this repository',
      }));
      continue;
    }

    let outcome: InstalledUpdateInstallOutcome;
    try {
      const input: InstalledUpdateInstallInput = {
        source: first.sourceRef,
        scope: first.scope,
        targetSource: first.source,
        userSkillDir,
        selections: group.map((item) => ({ skillDir: item.skillDir })),
        conflictPolicy: 'overwriteAll',
      };
      if (identity.identity !== undefined) input.identity = identity.identity;
      if (first.scope === 'project' && workingDirectory) input.workingDirectory = workingDirectory;
      outcome = await install(input);
    } catch (error) {
      outcome = {
        ok: false,
        error: { kind: 'unknown', message: error instanceof Error ? error.message : 'Failed to update skills' },
      };
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
      const skipped: InstalledUpdateResult = { ...resultOf(item), status: 'skipped' };
      const reason = skippedReasons.get(item.skillName);
      if (reason) skipped.reason = reason;
      results.push(skipped);
    }
  }

  return results;
};

let running = false;

export const updateInstalledSkills = async (
  options: UpdateInstalledSkillsOptions,
): Promise<{ ok: true; results: InstalledUpdateResult[] } | { ok: false; error: { kind: string; message: string } }> => {
  if (running) return { ok: false, error: { kind: 'busy', message: 'An update is already running' } };
  running = true;
  try {
    return { ok: true, results: await replaceGroups(options) };
  } finally {
    running = false;
  }
};
