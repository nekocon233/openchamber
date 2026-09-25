import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadClaudeCredential } from './claudeAuth';

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
