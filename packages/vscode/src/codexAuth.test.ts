import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getCodexCliAuthStatus } from './codexAuth';

describe('VS Code Codex CLI status', () => {
  // codex-cli 0.154.0 prints its status sentence on stderr and leaves stdout
  // empty, so a probe that reads stdout alone reports "no answer" while the
  // user is in fact signed in.
  test('reports the authoritative Codex CLI login state from stderr', async () => {
    const invocations: Array<{ command: string; args: string[] }> = [];
    const status = await getCodexCliAuthStatus({
      env: { PATH: '/usr/bin' },
      resolveExecutable: () => '/opt/homebrew/bin/codex',
      runCommand: async (command, args) => {
        invocations.push({ command, args });
        return { stdout: '', stderr: 'Logged in using ChatGPT\n' };
      },
    });

    assert.deepEqual(status, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.equal(invocations[0]?.command, '/opt/homebrew/bin/codex');
    assert.deepEqual(invocations[0]?.args, ['login', 'status']);
  });

  // A signed-out codex-cli 0.154.0 exits 1 while printing a clear answer, so
  // the non-zero exit must not turn that answer into a failed probe.
  test('reads "Not logged in" as logged out even though the CLI exits non-zero', async () => {
    const status = await getCodexCliAuthStatus({
      resolveExecutable: () => 'codex',
      runCommand: async () => ({
        stdout: '',
        stderr: 'Not logged in\n',
        error: new Error('Command failed: codex login status'),
      }),
    });

    assert.deepEqual(status, { status: 'disconnected', connected: false, reason: 'logged-out' });
  });

  test('reads through the colour codes the CLI writes even when piped', async () => {
    const status = await getCodexCliAuthStatus({
      resolveExecutable: () => 'codex',
      runCommand: async () => ({ stdout: '', stderr: '[90mLogged in using ChatGPT[0m\n' }),
    });

    assert.deepEqual(status, { status: 'connected', connected: true, reason: 'logged-in' });
  });

  test('resolves Codex through the login shell when the extension PATH misses it', async () => {
    const commands: string[] = [];
    const status = await getCodexCliAuthStatus({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      resolveExecutable: () => null,
      runCommand: async (command) => {
        commands.push(command);
        if (command === '/bin/zsh') return { stdout: '/opt/homebrew/bin/codex\n' };
        return { stdout: '', stderr: 'Logged in using ChatGPT\n' };
      },
    });

    assert.deepEqual(status, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.deepEqual(commands, ['/bin/zsh', '/opt/homebrew/bin/codex']);
  });

  test('keeps a missing CLI, a failed probe, and an odd answer out of "logged out"', async () => {
    const missing = await getCodexCliAuthStatus({
      platform: 'darwin',
      env: {},
      resolveExecutable: () => null,
      runCommand: async () => ({ stdout: '', error: new Error('ENOENT') }),
    });
    const failed = await getCodexCliAuthStatus({
      resolveExecutable: () => 'codex',
      runCommand: async () => ({ stdout: '', error: new Error('timed out') }),
    });
    const odd = await getCodexCliAuthStatus({
      resolveExecutable: () => 'codex',
      runCommand: async () => ({ stdout: '', stderr: 'usage: codex login [OPTIONS]' }),
    });

    assert.deepEqual(missing, { status: 'unavailable', connected: false, reason: 'cli-not-found' });
    assert.deepEqual(failed, { status: 'unavailable', connected: false, reason: 'probe-failed' });
    assert.deepEqual(odd, { status: 'unavailable', connected: false, reason: 'invalid-status' });
  });

  test('coalesces concurrent CLI probes', async () => {
    const probeResolvers: Array<(result: { stdout: string; stderr: string }) => void> = [];
    let calls = 0;
    const options = {
      resolveExecutable: () => 'codex',
      runCommand: async () => {
        calls += 1;
        return new Promise<{ stdout: string; stderr: string }>((resolve) => {
          probeResolvers.push(resolve);
        });
      },
    };

    const first = getCodexCliAuthStatus(options);
    const second = getCodexCliAuthStatus(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishProbe = probeResolvers[0];
    assert.ok(finishProbe);
    finishProbe({ stdout: '', stderr: 'Logged in using ChatGPT\n' });

    assert.deepEqual(await first, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.deepEqual(await second, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.equal(calls, 1);
  });
});
