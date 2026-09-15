import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let openCodeAuth = { openai: { access: 'test-token' } };

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => openCodeAuth,
}));

import { fetchQuota, isConfigured } from './codex.js';

/**
 * A real CODEX_HOME rather than a mocked fs, so path resolution is covered too.
 * It is always redirected to an empty temp directory — otherwise "no CLI
 * credential" would quietly read the developer's own `~/.codex` and pass or
 * fail depending on whose machine ran the suite.
 */
let codexHome = null;
const originalCodexHome = process.env.CODEX_HOME;

const writeCodexCliAuth = (tokens) => {
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens }), 'utf8');
};

beforeEach(() => {
  openCodeAuth = { openai: { access: 'test-token' } };
  codexHome = mkdtempSync(join(tmpdir(), 'codex-quota-'));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  codexHome = null;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

const mockUsage = (rateLimit) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate_limit: rateLimit }),
  }));
};

describe('Codex quota windows', () => {
  it('labels a weekly-only primary window from its duration', async () => {
    mockUsage({
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: 1784491827,
      },
      secondary_window: null,
    });

    const result = await fetchQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(3);
    expect(result.usage.windows['5h']).toBeUndefined();
  });

  it('labels five-hour and weekly windows from their durations', async () => {
    mockUsage({
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    });

    const result = await fetchQuota();

    expect(result.usage.windows['5h'].usedPercent).toBe(10);
    expect(result.usage.windows.weekly.usedPercent).toBe(20);
  });

  it('surfaces spend_control individual limit for business accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          individual_limit: {
            limit: '7500',
            used: '2674.8724080324173',
            remaining: '4825.127591967583',
            used_percent: 36,
            remaining_percent: 64
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.credits.usedPercent).toBe(36);
    expect(result.usage.windows.credits.valueLabel).toBe('2675 / 7500 used');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('Codex credential sources', () => {
  const authHeaders = (fetchMock) => fetchMock.mock.calls[0][1].headers;

  it('falls back to the Codex CLI credential when OpenCode has no entry', async () => {
    openCodeAuth = {};
    writeCodexCliAuth({ access_token: 'cli-token', account_id: 'acct-42' });
    mockUsage({ primary_window: { used_percent: 7, limit_window_seconds: 18000 } });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(authHeaders(globalThis.fetch).Authorization).toBe('Bearer cli-token');
    expect(authHeaders(globalThis.fetch)['ChatGPT-Account-Id']).toBe('acct-42');
  });

  it("keeps OpenCode's own entry when both sources have a token", async () => {
    writeCodexCliAuth({ access_token: 'cli-token', account_id: 'acct-42' });
    mockUsage({ primary_window: { used_percent: 7, limit_window_seconds: 18000 } });

    await fetchQuota();

    expect(authHeaders(globalThis.fetch).Authorization).toBe('Bearer test-token');
  });

  it('reports unconfigured when neither source has a token', async () => {
    openCodeAuth = {};
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a CLI credential file without a token as no credential', async () => {
    openCodeAuth = {};
    writeCodexCliAuth({ account_id: 'acct-42' });

    expect(isConfigured()).toBe(false);
  });

  it('counts a CLI sign-in as configured', () => {
    openCodeAuth = {};
    writeCodexCliAuth({ access_token: 'cli-token' });

    expect(isConfigured()).toBe(true);
  });
});
