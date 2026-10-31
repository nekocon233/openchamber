import { describe, expect, it } from 'vitest';
import { createAntigravityQuota, parseAntigravityQuota } from './quota.js';

const report = [
  'Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-06T08:26:27Z',
  'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-10-30T20:35:30Z',
  'Claude and GPT models\tWeekly Limit Remaining\t82.5%\t2026-11-06T15:35:30Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-10-30T20:35:30Z',
].join('\r\n');

describe('Antigravity CLI quota', () => {
  it('keeps model families and both quota windows separate', () => {
    const { models } = parseAntigravityQuota(report);
    expect(models.gemini.windows.weekly).toMatchObject({ remainingPercent: 97, usedPercent: 3, windowSeconds: 604800 });
    expect(models.gemini.windows['5h'].remainingPercent).toBe(100);
    expect(models['claude-gpt'].windows.weekly).toMatchObject({ remainingPercent: 82.5, resetAt: Date.parse('2026-11-06T15:35:30Z') });
    expect(models['claude-gpt'].windows['5h'].remainingPercent).toBe(0);
  });

  it('refuses empty, malformed and duplicate reports instead of publishing an empty success', () => {
    for (const output of ['', 'Sign in required', report.replace('97%', '120%'), report.replace('97%', '%'), `${report}\n${report}`, report.replace('2026-11-06T08:26:27Z', 'invalid')]) {
      expect(() => parseAntigravityQuota(output)).toThrow();
    }
    expect(parseAntigravityQuota('Gemini Models\tWeekly Limit Remaining\tDisabled\t').models.gemini.windows.weekly.remainingPercent).toBeNull();
  });

  it('coalesces readers, reports CLI failure, and permits a later refresh', async () => {
    let release;
    let calls = 0;
    const quota = createAntigravityQuota({
      resolveExecutable: async () => '/test/agy',
      readUsage: async () => { calls += 1; return new Promise((resolve) => { release = resolve; }); },
    });
    const first = quota();
    const second = quota();
    await Promise.resolve();
    expect(calls).toBe(1);
    release(report);
    expect(await first).toMatchObject({ providerId: 'antigravity-cli', configured: true, ok: true });
    expect(await second).toEqual(await first);
    const third = quota();
    await Promise.resolve();
    release('unsupported command');
    expect(await third).toMatchObject({ ok: false, configured: true, usage: null });
    expect(calls).toBe(2);
    expect(await createAntigravityQuota({ resolveExecutable: async () => null, readUsage: async () => { throw new Error('must not run'); } })()).toMatchObject({ configured: false });
  });
});
