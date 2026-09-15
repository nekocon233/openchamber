import { describe, expect, test } from 'bun:test';

import { getCodexCliAuthStatus } from './codex-cli-auth.js';

describe('getCodexCliAuthStatus', () => {
  test('reports the authoritative Codex CLI login state', () => {
    let invocation = null;
    const status = getCodexCliAuthStatus({
      env: { PATH: '/usr/bin' },
      spawnSyncFn(command, args, options) {
        invocation = { command, args, options };
        return { stdout: '', stderr: 'Logged in using ChatGPT\n' };
      },
    });

    expect(status).toEqual({ status: 'connected', connected: true, reason: 'logged-in' });
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toEqual(['login', 'status']);
  });

  test('reads the status the CLI prints on stderr with an empty stdout', () => {
    // codex-cli 0.154.0 writes this sentence to stderr; reading stdout alone
    // reports "no answer" while the user is signed in.
    const status = getCodexCliAuthStatus({
      spawnSyncFn: () => ({ stdout: '', stderr: 'Logged in using ChatGPT\n' }),
    });

    expect(status).toEqual({ status: 'connected', connected: true, reason: 'logged-in' });
  });

  test('reads "Not logged in" as logged out, not as a match on "logged in"', () => {
    const status = getCodexCliAuthStatus({
      spawnSyncFn: () => ({ stdout: '', stderr: 'Not logged in\n' }),
    });

    expect(status).toEqual({ status: 'disconnected', connected: false, reason: 'logged-out' });
  });

  test('reads through the colour codes the CLI writes even when piped', () => {
    const status = getCodexCliAuthStatus({
      spawnSyncFn: () => ({ stdout: '[90mLogged in using ChatGPT[0m\n' }),
    });

    expect(status).toEqual({ status: 'connected', connected: true, reason: 'logged-in' });
  });

  test('finds Codex through a login shell when a desktop PATH cannot', () => {
    const invocations = [];
    const status = getCodexCliAuthStatus({
      env: { HOME: '/Users/test', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      platform: 'darwin',
      spawnSyncFn(command, args, options) {
        invocations.push({ command, args, options });
        if (command === 'codex') return { stdout: '', error: new Error('spawnSync codex ENOENT') };
        if (command === '/bin/zsh') return { stdout: '/opt/homebrew/bin/codex\n' };
        return { stdout: '', stderr: 'Logged in using ChatGPT\n' };
      },
    });

    expect(status).toEqual({ status: 'connected', connected: true, reason: 'logged-in' });
    expect(invocations.map(({ command }) => command)).toEqual([
      'codex',
      '/bin/zsh',
      '/opt/homebrew/bin/codex',
    ]);
    expect(invocations[1].args).toEqual(['-lic', 'command -v codex']);
  });

  test('treats a timed out CLI probe as unavailable', () => {
    const status = getCodexCliAuthStatus({
      platform: 'win32',
      spawnSyncFn: () => ({ stdout: '', error: new Error('ETIMEDOUT') }),
    });

    expect(status).toEqual({ status: 'unavailable', connected: false, reason: 'empty-status' });
  });

  test('treats an unrecognised answer as unavailable instead of logged out', () => {
    const status = getCodexCliAuthStatus({
      spawnSyncFn: () => ({ stdout: '', stderr: 'usage: codex login [OPTIONS]' }),
    });

    expect(status).toEqual({ status: 'unavailable', connected: false, reason: 'invalid-status' });
  });
});
