import { describe, expect, it } from 'vitest';
import { planInstalledSkillUpdates, updateInstalledSkills } from './update-installed.js';

const provenance = (entries) => {
  const byName = new Map();
  for (const entry of entries) {
    byName.set(entry.skillName, [...(byName.get(entry.skillName) ?? []), entry]);
  }
  return byName;
};

const recorded = (overrides = {}) => ({
  skillName: 'demo',
  skillDir: 'skills/demo',
  scope: 'project',
  source: 'opencode',
  sourceId: 'acme',
  sourceRef: 'acme/skills',
  ...overrides,
});

const identityOk = async () => ({ ok: true, identity: null });

describe('planInstalledSkillUpdates', () => {
  const targetDirFor = (item) => `/project/${item.skillName}`;

  it('keeps recorded skills that are still installed and drops the rest', () => {
    const plan = planInstalledSkillUpdates({
      provenanceByName: provenance([
        recorded(),
        recorded({ skillName: 'removed', skillDir: 'skills/removed' }),
        recorded({ skillName: 'manual', skillDir: 'skills/manual', sourceRef: '' }),
        recorded({ skillName: 'renamed', skillDir: 'skills/other-dir' }),
        recorded({ skillName: 'odd-scope', skillDir: 'skills/odd-scope', scope: 'workspace' }),
        recorded({ skillName: 'odd-source', skillDir: 'skills/odd-source', source: 'claude' }),
      ]),
      targetDirFor,
      skillExists: (targetDir) => !targetDir.endsWith('/removed'),
    });

    expect(plan.map((item) => item.skillName)).toEqual(['demo']);
    expect(plan[0]).toMatchObject({
      skillName: 'demo',
      skillDir: 'skills/demo',
      scope: 'project',
      source: 'opencode',
      sourceId: 'acme',
      sourceRef: 'acme/skills',
    });
  });

  it('uses the newest record for the same name, scope and target', () => {
    const plan = planInstalledSkillUpdates({
      provenanceByName: provenance([
        recorded({ sourceId: 'older', skillDir: 'skills/older-demo' }),
        recorded({ sourceId: 'newer', skillDir: 'skills/demo' }),
      ]),
      targetDirFor,
      skillExists: () => true,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ skillName: 'demo', sourceId: 'newer', skillDir: 'skills/demo' });
  });

  it('skips a skill whose target directory cannot be resolved', () => {
    const plan = planInstalledSkillUpdates({
      provenanceByName: provenance([recorded()]),
      targetDirFor: () => null,
      skillExists: () => true,
    });

    expect(plan).toEqual([]);
  });
});

describe('updateInstalledSkills', () => {
  const planItem = (overrides = {}) => ({
    skillName: 'demo', skillDir: 'skills/demo', scope: 'project',
    source: 'opencode', sourceId: 'acme', sourceRef: 'acme/skills', ...overrides,
  });

  it('clones once per source and scope and reports each skill', async () => {
    const calls = [];
    const result = await updateInstalledSkills({
      plan: [
        planItem(),
        planItem({ skillName: 'other', skillDir: 'skills/other' }),
        planItem({ skillName: 'global', skillDir: 'skills/global', scope: 'user', sourceId: 'beta', sourceRef: 'beta/skills' }),
      ],
      resolveIdentity: identityOk,
      workingDirectory: '/project',
      userSkillDir: '/home/.opencode/skills',
      install: async (input) => {
        calls.push(input);
        return { ok: true, installed: input.selections.map((selection) => ({ skillName: selection.skillDir.split('/').pop() })), skipped: [] };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      source: 'acme/skills',
      scope: 'project',
      targetSource: 'opencode',
      workingDirectory: '/project',
      conflictPolicy: 'overwriteAll',
      userSkillDir: '/home/.opencode/skills',
    });
    expect(calls[0].selections).toEqual([{ skillDir: 'skills/demo' }, { skillDir: 'skills/other' }]);
    expect(calls[1]).toMatchObject({ source: 'beta/skills', scope: 'user' });
    expect(calls[1].workingDirectory).toBeUndefined();
    expect(result).toEqual({ ok: true, results: [
      { skillName: 'demo', scope: 'project', source: 'opencode', status: 'updated' },
      { skillName: 'other', scope: 'project', source: 'opencode', status: 'updated' },
      { skillName: 'global', scope: 'user', source: 'opencode', status: 'updated' },
    ] });
  });

  it('reports skipped skills with the install reason', async () => {
    const result = await updateInstalledSkills({
      plan: [planItem(), planItem({ skillName: 'moved', skillDir: 'skills/moved' })],
      resolveIdentity: identityOk,
      install: async () => ({
        ok: true,
        installed: [{ skillName: 'demo' }],
        skipped: [{ skillName: 'moved', reason: 'SKILL.md not found in selected directory' }],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      { skillName: 'demo', scope: 'project', source: 'opencode', status: 'updated' },
      { skillName: 'moved', scope: 'project', source: 'opencode', status: 'skipped', reason: 'SKILL.md not found in selected directory' },
    ]);
  });

  it('marks a failed source and keeps the other sources', async () => {
    const result = await updateInstalledSkills({
      plan: [
        planItem(),
        planItem({ skillName: 'private', scope: 'user', sourceId: 'private', sourceRef: 'private/skills' }),
      ],
      resolveIdentity: async (sourceId) => sourceId === 'private'
        ? { ok: false, error: { kind: 'authRequired', message: 'Authentication required to access this repository' } }
        : { ok: true, identity: null },
      install: async () => ({ ok: true, installed: [{ skillName: 'demo' }], skipped: [] }),
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      { skillName: 'demo', scope: 'project', source: 'opencode', status: 'updated' },
      {
        skillName: 'private', scope: 'user', source: 'opencode', status: 'failed',
        kind: 'authRequired', reason: 'Authentication required to access this repository',
      },
    ]);
  });

  it('turns a throwing install into a failed source', async () => {
    const result = await updateInstalledSkills({
      plan: [planItem()],
      resolveIdentity: identityOk,
      install: async () => { throw new Error('git is gone'); },
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      { skillName: 'demo', scope: 'project', source: 'opencode', status: 'failed', kind: 'unknown', reason: 'git is gone' },
    ]);
  });

  it('refuses a second run while one is in flight', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const first = updateInstalledSkills({
      plan: [planItem()],
      resolveIdentity: identityOk,
      install: async () => {
        await pending;
        return { ok: true, installed: [{ skillName: 'demo' }], skipped: [] };
      },
    });

    const second = await updateInstalledSkills({
      plan: [planItem()],
      resolveIdentity: identityOk,
      install: async () => ({ ok: true, installed: [{ skillName: 'demo' }], skipped: [] }),
    });

    expect(second).toEqual({ ok: false, error: { kind: 'busy', message: 'An update is already running' } });
    release();
    expect(await first).toMatchObject({ ok: true });
  });
});
