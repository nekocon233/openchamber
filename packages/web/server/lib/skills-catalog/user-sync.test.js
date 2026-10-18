import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncUserSkills } from './user-sync.js';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-user-sync-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const writeFile = (relative, content) => {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const writeSkill = (relativeDir, content) => writeFile(path.join(relativeDir, 'SKILL.md'), content);

const readSkill = (relativeDir) => fs.readFileSync(path.join(home, relativeDir, 'SKILL.md'), 'utf8');

const cachedSkill = (agent, plugin, version, name, content) => writeSkill(
  path.join(agent === 'claude' ? '.claude' : '.codex', 'plugins', 'cache', 'market', plugin, version, 'skills', name),
  content,
);

describe('user skill sync', () => {
  it('plans updates, current copies, symlinks and unsourced skills', async () => {
    writeSkill('.agents/skills/alpha', 'alpha old');
    writeSkill('.agents/skills/beta', 'beta');
    writeSkill('.agents/skills/omega', 'omega same');
    writeSkill('.agents/skills/delta', 'delta');
    writeFile('.agents/skills/not-a-skill/README.md', 'no SKILL.md here');
    fs.mkdirSync(path.join(home, 'external-target'));
    fs.symlinkSync(path.join(home, 'external-target'), path.join(home, '.agents/skills/gamma'));

    cachedSkill('claude', 'hyperframes', '0.9.0', 'alpha', 'alpha 0.9');
    cachedSkill('claude', 'hyperframes', '0.10.0', 'alpha', 'alpha 0.10');
    cachedSkill('codex', 'impeccable', '4.3.1', 'beta', 'beta');
    cachedSkill('codex', 'impeccable', '4.3.1', 'omega', 'omega same');

    const outcome = await syncUserSkills({ homeDir: home, dryRun: true });

    expect(outcome.ok).toBe(true);
    expect(outcome.plan).toEqual([
      {
        skillName: 'alpha',
        status: 'update',
        source: { agent: 'claude', plugin: 'hyperframes', version: '0.10.0' },
      },
      { skillName: 'beta', status: 'current', source: { agent: 'codex', plugin: 'impeccable', version: '4.3.1' } },
      { skillName: 'delta', status: 'noSource', source: null },
      { skillName: 'gamma', status: 'external', source: null },
      { skillName: 'omega', status: 'current', source: { agent: 'codex', plugin: 'impeccable', version: '4.3.1' } },
    ]);
  });

  it('takes the highest version and Claude Code on a tie', async () => {
    writeSkill('.agents/skills/tie', 'tie claude');
    writeSkill('.agents/skills/high', 'high claude');
    cachedSkill('claude', 'one', '1.0.0', 'tie', 'tie claude');
    cachedSkill('codex', 'two', '1.0.0', 'tie', 'tie codex');
    cachedSkill('claude', 'one', '1.0.0', 'high', 'high claude');
    cachedSkill('codex', 'two', '2.0.0', 'high', 'high codex');

    const outcome = await syncUserSkills({ homeDir: home, dryRun: true });

    expect(outcome.ok).toBe(true);
    expect(outcome.plan).toEqual([
      { skillName: 'high', status: 'update', source: { agent: 'codex', plugin: 'two', version: '2.0.0' } },
      { skillName: 'tie', status: 'current', source: { agent: 'claude', plugin: 'one', version: '1.0.0' } },
    ]);
  });

  it('replaces the changed copy with the whole source directory and skips the rest', async () => {
    writeSkill('.agents/skills/alpha', 'alpha old');
    writeFile('.agents/skills/alpha/local-only.md', 'stale local file');
    writeSkill('.agents/skills/beta', 'beta');
    cachedSkill('claude', 'hyperframes', '1.0.0', 'alpha', 'alpha new');
    writeFile('.claude/plugins/cache/market/hyperframes/1.0.0/skills/alpha/scripts/run.mjs', 'run');
    cachedSkill('codex', 'impeccable', '1.0.0', 'beta', 'beta');

    const outcome = await syncUserSkills({ homeDir: home });

    expect(outcome).toMatchObject({ ok: true, updated: 1, skipped: 1, failed: 0 });
    expect(readSkill('.agents/skills/alpha')).toBe('alpha new');
    expect(fs.existsSync(path.join(home, '.agents/skills/alpha/scripts/run.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents/skills/alpha/local-only.md'))).toBe(false);
    expect(readSkill('.agents/skills/beta')).toBe('beta');

    const again = await syncUserSkills({ homeDir: home, dryRun: true });
    expect(again.ok).toBe(true);
    expect(again.plan.every((item) => item.status === 'current')).toBe(true);
  });

  it('leaves the old copy in place when a replacement fails and continues', async () => {
    writeSkill('.agents/skills/alpha', 'alpha old');
    writeSkill('.agents/skills/beta', 'beta old');
    cachedSkill('claude', 'one', '1.0.0', 'alpha', 'alpha new');
    cachedSkill('claude', 'one', '1.0.0', 'beta', 'beta new');

    const outcome = await syncUserSkills({
      homeDir: home,
      copySkillDir: async (sourceDir, targetDir) => {
        if (targetDir.endsWith(`${path.sep}alpha`)) throw new Error('disk full');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'SKILL.md'), fs.readFileSync(path.join(sourceDir, 'SKILL.md')));
      },
    });

    expect(outcome).toMatchObject({ ok: true, updated: 1, failed: 1 });
    expect(outcome.results.find((entry) => entry.skillName === 'alpha')).toMatchObject({
      status: 'failed',
      kind: 'copyFailed',
      message: 'disk full',
    });
    expect(readSkill('.agents/skills/alpha')).toBe('alpha old');
    expect(readSkill('.agents/skills/beta')).toBe('beta new');
  });

  it('rejects a second run while one is in flight', async () => {
    writeSkill('.agents/skills/alpha', 'alpha old');
    cachedSkill('claude', 'one', '1.0.0', 'alpha', 'alpha new');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const first = syncUserSkills({
      homeDir: home,
      copySkillDir: async (sourceDir, targetDir) => {
        await gate;
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'SKILL.md'), fs.readFileSync(path.join(sourceDir, 'SKILL.md')));
      },
    });

    const second = await syncUserSkills({ homeDir: home });
    expect(second).toMatchObject({ ok: false, error: { kind: 'busy' } });

    release();
    await expect(first).resolves.toMatchObject({ ok: true, updated: 1 });
  });

  it('returns an empty plan when the directory or the caches are missing', async () => {
    const outcome = await syncUserSkills({ homeDir: home, dryRun: true });
    expect(outcome).toEqual({ ok: true, plan: [] });

    fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true });
    const run = await syncUserSkills({ homeDir: home });
    expect(run).toEqual({ ok: true, results: [], updated: 0, skipped: 0, failed: 0 });
  });
});
