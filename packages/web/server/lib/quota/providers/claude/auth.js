/**
 * Claude credential discovery.
 *
 * Claude Code is the primary source: on macOS it keeps its OAuth tokens in the
 * login Keychain, elsewhere in a credentials file. OpenCode's own `auth.json`
 * entry is the fallback for users who signed into Anthropic through OpenCode
 * instead of Claude Code.
 *
 * Every source is read-only. Claude rotates a Keychain/credentials entry from
 * under us whenever Claude Code refreshes, so credentials are read fresh per
 * request rather than cached; a stale cached token would outlive the record it
 * came from.
 *
 * @module quota/providers/claude/auth
 */

import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

import { readAuthFile } from '../../../opencode/auth.js';
import { asObject, asNonEmptyString, normalizeTimestamp, getAuthEntry, normalizeAuthEntry, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OPENCODE_AUTH_ALIASES = ['anthropic', 'claude'];

/**
 * @typedef {object} ClaudeCredential
 * @property {string} accessToken
 * @property {string|null} refreshToken
 * @property {number|null} expiresAt Epoch milliseconds, when the source reports it.
 * @property {string|null} planLabel Subscription tier reported by Claude Code, e.g. `max`.
 * @property {'keychain'|'credentials-file'|'opencode-auth'|'env'} source
 */

const claudeConfigDirectory = () => {
  const override = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
};

/**
 * Claude Code writes one JSON blob holding both its own OAuth tokens
 * (`claudeAiOauth`) and unrelated MCP server tokens. Only the former is read.
 */
const parseClaudeCodeBlob = (blob, source) => {
  const oauth = asObject(asObject(blob)?.claudeAiOauth);
  const accessToken = asNonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth.refreshToken),
    expiresAt: normalizeTimestamp(oauth.expiresAt),
    planLabel: asNonEmptyString(oauth.subscriptionType),
    source
  };
};

const readKeychainCredential = () => {
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
    const credential = parseClaudeCodeBlob(JSON.parse(result.stdout.trim()), 'keychain');
    return credential ? { status: 'found', credential } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
};

const readCredentialsFile = () =>
  parseClaudeCodeBlob(readJsonFile(path.join(claudeConfigDirectory(), '.credentials.json')), 'credentials-file');

const readOpenCodeCredential = () => {
  const entry = normalizeAuthEntry(getAuthEntry(readAuthFile(), OPENCODE_AUTH_ALIASES));
  const accessToken = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(entry.refresh),
    expiresAt: normalizeTimestamp(entry.expires),
    planLabel: null,
    source: 'opencode-auth'
  };
};

const readEnvCredential = () => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

/**
 * First credential a source can produce, in priority order.
 *
 * The Keychain wins over the credentials file because on macOS the file is a
 * leftover that Claude Code no longer updates.
 *
 * @returns {ClaudeCredential|null}
 */
export const loadClaudeCredential = () => {
  const keychain = readKeychainCredential();
  if (keychain.status === 'found') return keychain.credential;
  const fileCredential = process.platform !== 'darwin' || keychain.status === 'missing'
    ? readCredentialsFile()
    : null;
  return fileCredential ?? readOpenCodeCredential() ?? readEnvCredential();
};
