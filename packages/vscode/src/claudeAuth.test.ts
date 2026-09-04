import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClaudeCliAuthStatus, loadClaudeCredential } from './claudeAuth';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-claude-auth-'));

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const claudeCodeBlob = (accessToken: string, subscriptionType = 'max'): string => JSON.stringify({
  mcpOAuth: { 'linear|fixture': { accessToken: 'unrelated-mcp-token' } },
  claudeAiOauth: {
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    expiresAt: 1_786_735_755_912,
    subscriptionType,
  },
});

describe('VS Code Claude credential discovery', () => {
  test('prefers the macOS Keychain and returns the Claude plan label', () => {
    const configDirectory = path.join(fixtureRoot, 'keychain-priority');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(path.join(configDirectory, '.credentials.json'), claudeCodeBlob('file-token'));

    const credential = loadClaudeCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: configDirectory, CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
      readKeychain: () => ({ status: 'found', value: claudeCodeBlob('keychain-token') }),
      readProviderAuth: () => ({ access: 'opencode-token' }),
    });

    assert.equal(credential?.source, 'keychain');
    assert.equal(credential?.accessToken, 'keychain-token');
    assert.equal(credential?.refreshToken, 'keychain-token-refresh');
    assert.equal(credential?.planLabel, 'max');
  });

  test('reads only the fixture credentials file outside macOS', () => {
    const configDirectory = path.join(fixtureRoot, 'credentials-file');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(path.join(configDirectory, '.credentials.json'), claudeCodeBlob('file-token', 'pro'));
    let keychainReads = 0;

    const credential = loadClaudeCredential({
      platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: configDirectory },
      readKeychain: () => {
        keychainReads += 1;
        return { status: 'found', value: claudeCodeBlob('unexpected-keychain-token') };
      },
      readProviderAuth: () => null,
    });

    assert.equal(keychainReads, 0);
    assert.equal(credential?.source, 'credentials-file');
    assert.equal(credential?.accessToken, 'file-token');
    assert.equal(credential?.planLabel, 'pro');
  });

  test('uses OpenCode auth before CLAUDE_CODE_OAUTH_TOKEN', () => {
    const emptyConfigDirectory = path.join(fixtureRoot, 'fallback-order');
    fs.mkdirSync(emptyConfigDirectory, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: emptyConfigDirectory, CLAUDE_CODE_OAUTH_TOKEN: 'env-token' };

    const openCodeCredential = loadClaudeCredential({
      platform: 'linux',
      env,
      readProviderAuth: (providerId) => providerId === 'anthropic'
        ? { access: 'opencode-token', refresh: 'opencode-refresh' }
        : null,
    });
    const envCredential = loadClaudeCredential({
      platform: 'linux',
      env,
      readProviderAuth: () => null,
    });

    assert.equal(openCodeCredential?.source, 'opencode-auth');
    assert.equal(openCodeCredential?.accessToken, 'opencode-token');
    assert.equal(envCredential?.source, 'env');
    assert.equal(envCredential?.accessToken, 'env-token');
    assert.equal(envCredential?.refreshToken, null);
  });

  test('ignores unrelated MCP credentials', () => {
    const emptyConfigDirectory = path.join(fixtureRoot, 'mcp-only');
    fs.mkdirSync(emptyConfigDirectory, { recursive: true });
    const credential = loadClaudeCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: emptyConfigDirectory },
      readKeychain: () => ({ status: 'found', value: JSON.stringify({ mcpOAuth: { service: { accessToken: 'mcp-token' } } }) }),
      readProviderAuth: () => null,
    });

    assert.equal(credential, null);
  });

  test('falls back to the credentials file only when the Keychain item is missing', () => {
    const configDirectory = path.join(fixtureRoot, 'keychain-unavailable');
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(path.join(configDirectory, '.credentials.json'), claudeCodeBlob('stale-file-token'));

    const missing = loadClaudeCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: configDirectory },
      readKeychain: () => ({ status: 'missing' }),
      readProviderAuth: () => null,
    });
    const unavailable = loadClaudeCredential({
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: configDirectory },
      readKeychain: () => ({ status: 'unavailable' }),
      readProviderAuth: () => null,
    });

    assert.equal(missing?.source, 'credentials-file');
    assert.equal(unavailable, null);
  });
});

describe('VS Code Claude CLI status', () => {
  test('uses the CLI status while stripping credential overrides', async () => {
    const invocations: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const status = await getClaudeCliAuthStatus({
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'api-key',
        ANTHROPIC_AUTH_TOKEN: 'auth-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      },
      resolveExecutable: () => 'claude',
      runCommand: async (command, args, options) => {
        invocations.push({ command, args, env: options.env });
        return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }) };
      },
    });

    const invocation = invocations[0];
    assert.deepEqual(status, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.equal(invocation?.command, 'claude');
    assert.deepEqual(invocation?.args, ['auth', 'status', '--json']);
    assert.equal(invocation?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(invocation?.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(invocation?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  test('resolves Claude through the login shell when the extension PATH misses it', async () => {
    const commands: string[] = [];
    const status = await getClaudeCliAuthStatus({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
      resolveExecutable: () => null,
      runCommand: async (command) => {
        commands.push(command);
        if (command === '/bin/zsh') return { stdout: '/Users/test/.local/bin/claude\n' };
        return { stdout: JSON.stringify({ loggedIn: true }) };
      },
    });

    assert.deepEqual(status, { status: 'connected', connected: true, reason: 'logged-in' });
    assert.deepEqual(commands, ['/bin/zsh', '/Users/test/.local/bin/claude']);
  });

  test('treats timeout and invalid JSON as unavailable, not logged out', async () => {
    const timedOut = await getClaudeCliAuthStatus({
      resolveExecutable: () => 'claude',
      runCommand: async () => ({ stdout: '', error: new Error('timed out') }),
    });
    const invalid = await getClaudeCliAuthStatus({
      resolveExecutable: () => 'claude',
      runCommand: async () => ({ stdout: '{invalid' }),
    });

    assert.deepEqual(timedOut, { status: 'unavailable', connected: false, reason: 'probe-failed' });
    assert.deepEqual(invalid, { status: 'unavailable', connected: false, reason: 'invalid-status' });
  });

  test('coalesces concurrent CLI probes', async () => {
    const probeResolvers: Array<(result: { stdout: string }) => void> = [];
    let calls = 0;
    const options = {
      resolveExecutable: () => 'claude',
      runCommand: async () => {
        calls += 1;
        return new Promise<{ stdout: string }>((resolve) => {
          probeResolvers.push(resolve);
        });
      },
    };

    const first = getClaudeCliAuthStatus(options);
    const second = getClaudeCliAuthStatus(options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finishProbe = probeResolvers[0];
    assert.ok(finishProbe);
    finishProbe({ stdout: JSON.stringify({ loggedIn: false }) });

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(firstStatus, { status: 'disconnected', connected: false, reason: 'logged-out' });
    assert.deepEqual(secondStatus, firstStatus);
  });
});
