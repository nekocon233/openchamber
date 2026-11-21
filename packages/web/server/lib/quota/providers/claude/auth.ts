
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

import { readOpenCodeCredentials } from '../../../opencode/auth.js';
import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { asNonEmptyString, normalizeTimestamp, getAuthEntry, normalizeAuthEntry, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OPENCODE_AUTH_ALIASES = ['anthropic', 'claude'];

export interface ClaudeCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  planLabel: string | null;
  source: 'keychain' | 'credentials-file' | 'opencode-auth' | 'env';
}

interface ClaudeCodeBlob {
  claudeAiOauth?: unknown;
}

interface ClaudeOAuthFields {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
}

interface OpenCodeAuthFields {
  access?: unknown;
  token?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

const isCredentialBlob = (value: unknown): value is ClaudeCodeBlob =>
  value !== null && typeof value === 'object';

const isOAuthFields = (value: unknown): value is ClaudeOAuthFields =>
  value !== null && typeof value === 'object';

const claudeConfigDirectory = () => {
  const override = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
};

const parseClaudeCodeBlob = (blob: ClaudeCodeBlob | null, source: ClaudeCredential['source']): ClaudeCredential | null => {
  const oauth = isOAuthFields(blob?.claudeAiOauth) ? blob.claudeAiOauth : null;
  const accessToken = asNonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth?.refreshToken),
    expiresAt: normalizeTimestamp(oauth?.expiresAt),
    planLabel: asNonEmptyString(oauth?.subscriptionType),
    source
  };
};

type KeychainResult =
  | { status: 'found'; credential: ClaudeCredential }
  | { status: 'missing' }
  | { status: 'unavailable' };

const readKeychainCredential = (): KeychainResult => {
  if (process.platform !== 'darwin') return { status: 'missing' };
  try {
    const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.error) return { status: 'unavailable' };
    if (result.status === 44) return { status: 'missing' };
    if (result.status !== 0 || !result.stdout?.trim()) return { status: 'unavailable' };
    const blob: unknown = JSON.parse(result.stdout.trim());
    const credential = parseClaudeCodeBlob(isCredentialBlob(blob) ? blob : null, 'keychain');
    return credential ? { status: 'found', credential } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
};

const readCredentialsFile = () => {
  const blob: unknown = readJsonFile(path.join(claudeConfigDirectory(), '.credentials.json'));
  return parseClaudeCodeBlob(isCredentialBlob(blob) ? blob : null, 'credentials-file');
};

const readOpenCodeCredential = (auth: LegacyAuthFile): ClaudeCredential | null => {
  const entry: OpenCodeAuthFields | null = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_AUTH_ALIASES));
  const accessToken = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(entry?.refresh),
    expiresAt: normalizeTimestamp(entry?.expires),
    planLabel: null,
    source: 'opencode-auth'
  };
};

const readEnvCredential = (): ClaudeCredential | null => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

const readLocalCredential = (): ClaudeCredential | null => {
  const keychain = readKeychainCredential();
  if (keychain.status === 'found') return keychain.credential;
  if (process.platform === 'darwin' && keychain.status !== 'missing') return null;
  return readCredentialsFile();
};

export const findClaudeCredential = (auth: LegacyAuthFile): ClaudeCredential | null =>
  readLocalCredential()
  ?? readOpenCodeCredential(auth)
  ?? readEnvCredential();

export const loadClaudeCredential = async (): Promise<ClaudeCredential | null> =>
  readLocalCredential()
  ?? readOpenCodeCredential(await readOpenCodeCredentials())
  ?? readEnvCredential();
