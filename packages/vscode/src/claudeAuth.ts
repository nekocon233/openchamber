import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { findNodeAtLocation, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { getProviderAuth, type AuthEntry } from './opencodeAuth';
import { findExecutableInPath, resolveWindowsLaunchSpec } from './process-launch';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OPENCODE_AUTH_ALIASES = ['anthropic', 'claude'] as const;

type ClaudeCredentialSource = 'keychain' | 'credentials-file' | 'opencode-auth' | 'env';

export type ClaudeCredential = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  planLabel: string | null;
  source: ClaudeCredentialSource;
};

type ClaudeCredentialReadOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  readTextFile?: (filePath: string) => string | null;
  readKeychain?: () => KeychainReadResult;
  readProviderAuth?: (providerId: string) => AuthEntry | string | null;
};

type ClaudeCommandOptions = {
  encoding: 'utf8';
  timeout: number;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  windowsHide: true;
};

type ClaudeCommandResult = {
  stdout?: string | null;
  error?: Error;
};

type ClaudeCommandRunner = (
  command: string,
  args: string[],
  options: ClaudeCommandOptions,
) => Promise<ClaudeCommandResult>;

type ClaudeCliStatusOptions = {
  runCommand?: ClaudeCommandRunner;
  resolveExecutable?: (binaryName: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

type KeychainReadResult =
  | { status: 'found'; value: string }
  | { status: 'missing' }
  | { status: 'unavailable' };

type ClaudeCliAuthStatus =
  | { status: 'connected'; connected: true; reason: 'logged-in' }
  | { status: 'disconnected'; connected: false; reason: 'logged-out' }
  | { status: 'unavailable'; connected: false; reason: 'cli-not-found' | 'probe-failed' | 'invalid-status' };

const asNonEmptyString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
};

const parseJsonRoot = (raw: string | null): Node | null => {
  if (!raw?.trim()) return null;
  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, { allowTrailingComma: false, disallowComments: true });
  return errors.length === 0 ? (root ?? null) : null;
};

const stringAt = (root: Node, fieldPath: string[]): string | null => {
  const node = findNodeAtLocation(root, fieldPath);
  return node?.type === 'string' ? asNonEmptyString(node.value) : null;
};

const timestampAt = (root: Node, fieldPath: string[]): number | null => {
  const node = findNodeAtLocation(root, fieldPath);
  if (node?.type === 'number' && Number.isFinite(node.value)) {
    const value: number = node.value;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (node?.type === 'string') {
    const timestamp = Date.parse(node.value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
};

const parseClaudeCodeCredential = (
  raw: string | null,
  source: 'keychain' | 'credentials-file',
): ClaudeCredential | null => {
  const root = parseJsonRoot(raw);
  if (root?.type !== 'object') return null;
  const accessToken = stringAt(root, ['claudeAiOauth', 'accessToken']);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: stringAt(root, ['claudeAiOauth', 'refreshToken']),
    expiresAt: timestampAt(root, ['claudeAiOauth', 'expiresAt']),
    planLabel: stringAt(root, ['claudeAiOauth', 'subscriptionType']),
    source,
  };
};

const readTextFile = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const readKeychain = (): KeychainReadResult => {
  try {
    const result = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error) return { status: 'unavailable' };
    if (result.status === 44) return { status: 'missing' };
    if (result.status !== 0) return { status: 'unavailable' };
    const value = asNonEmptyString(result.stdout);
    return value ? { status: 'found', value } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
};

const normalizeOpenCodeCredential = (entry: AuthEntry | string | null): ClaudeCredential | null => {
  const serialized = entry === null ? null : JSON.stringify(entry);
  const root = parseJsonRoot(serialized ?? null);
  if (!root) return null;
  const accessToken = root.type === 'string'
    ? asNonEmptyString(root.value)
    : root.type === 'object'
      ? stringAt(root, ['access']) ?? stringAt(root, ['token'])
      : null;
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: root.type === 'object' ? stringAt(root, ['refresh']) : null,
    expiresAt: root.type === 'object' ? timestampAt(root, ['expires']) : null,
    planLabel: null,
    source: 'opencode-auth',
  };
};

export const loadClaudeCredential = (options: ClaudeCredentialReadOptions = {}): ClaudeCredential | null => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const readFile = options.readTextFile ?? readTextFile;
  const readKeychainValue = options.readKeychain ?? readKeychain;
  const readAuth = options.readProviderAuth ?? getProviderAuth;
  const configuredDirectory = asNonEmptyString(env.CLAUDE_CONFIG_DIR);
  const configDirectory = configuredDirectory
    ? path.resolve(configuredDirectory)
    : path.join(options.homeDirectory ?? os.homedir(), '.claude');

  const keychain = platform === 'darwin' ? readKeychainValue() : { status: 'missing' as const };
  if (keychain.status === 'found') {
    const keychainCredential = parseClaudeCodeCredential(keychain.value, 'keychain');
    if (keychainCredential) return keychainCredential;
  }

  if (platform !== 'darwin' || keychain.status === 'missing') {
    const fileCredential = parseClaudeCodeCredential(
      readFile(path.join(configDirectory, '.credentials.json')),
      'credentials-file',
    );
    if (fileCredential) return fileCredential;
  }

  for (const providerId of OPENCODE_AUTH_ALIASES) {
    const openCodeCredential = normalizeOpenCodeCredential(readAuth(providerId));
    if (openCodeCredential) return openCodeCredential;
  }

  const envToken = asNonEmptyString(env.CLAUDE_CODE_OAUTH_TOKEN);
  return envToken
    ? {
        accessToken: envToken,
        refreshToken: null,
        expiresAt: null,
        planLabel: null,
        source: 'env',
      }
    : null;
};

const defaultRunCommand: ClaudeCommandRunner = (command, args, options) => new Promise((resolve) => {
  const launch = resolveWindowsLaunchSpec(command, args, { platform: options.platform, env: options.env });
  execFile(launch.binary, launch.args, {
    encoding: options.encoding,
    timeout: options.timeout,
    env: options.env,
    windowsHide: options.windowsHide,
  }, (error, stdout) => {
    resolve({ stdout: stdout || '', error: error ?? undefined });
  });
});

const commandOutput = (result: ClaudeCommandResult): string => result.stdout?.trim() ?? '';

const runClaudeStatus = (
  runCommand: ClaudeCommandRunner,
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<ClaudeCommandResult> => runCommand(command, ['auth', 'status', '--json'], {
  encoding: 'utf8',
  timeout: 6_000,
  env,
  platform,
  windowsHide: true,
});

const resolveClaudeCommandFromShell = async (
  runCommand: ClaudeCommandRunner,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  if (platform === 'win32') {
    const result = await runCommand('where', ['claude'], {
      encoding: 'utf8',
      timeout: 6_000,
      env,
      platform,
      windowsHide: true,
    });
    if (result.error) return null;
    return commandOutput(result).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = await runCommand(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 6_000,
    env,
    platform,
    windowsHide: true,
  });
  if (result.error) return null;
  return commandOutput(result) || null;
};

const parseLoggedIn = (raw: string): boolean | null => {
  const root = parseJsonRoot(raw);
  if (root?.type !== 'object') return null;
  const loggedIn = findNodeAtLocation(root, ['loggedIn']);
  return loggedIn?.type === 'boolean' ? loggedIn.value === true : null;
};

const probeClaudeCliAuthStatus = async (options: ClaudeCliStatusOptions): Promise<ClaudeCliAuthStatus> => {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const resolveExecutable = options.resolveExecutable
    ?? ((binaryName, platform, env) => findExecutableInPath(binaryName, { platform, env }));
  const platform = options.platform ?? process.platform;
  const childEnv = { ...(options.env ?? process.env) };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    const command = resolveExecutable('claude', platform, childEnv)
      ?? await resolveClaudeCommandFromShell(runCommand, childEnv, platform);
    if (!command) return { status: 'unavailable', connected: false, reason: 'cli-not-found' };
    const result = await runClaudeStatus(runCommand, command, childEnv, platform);
    const output = commandOutput(result);
    if (!output || result.error) return { status: 'unavailable', connected: false, reason: 'probe-failed' };
    const connected = parseLoggedIn(output);
    if (connected === null) return { status: 'unavailable', connected: false, reason: 'invalid-status' };
    return connected
      ? { status: 'connected', connected: true, reason: 'logged-in' }
      : { status: 'disconnected', connected: false, reason: 'logged-out' };
  } catch {
    return { status: 'unavailable', connected: false, reason: 'probe-failed' };
  }
};

let claudeCliAuthStatusInFlight: Promise<ClaudeCliAuthStatus> | null = null;

export const getClaudeCliAuthStatus = (options: ClaudeCliStatusOptions = {}): Promise<ClaudeCliAuthStatus> => {
  if (claudeCliAuthStatusInFlight) return claudeCliAuthStatusInFlight;
  const pending = probeClaudeCliAuthStatus(options).finally(() => {
    if (claudeCliAuthStatusInFlight === pending) claudeCliAuthStatusInFlight = null;
  });
  claudeCliAuthStatusInFlight = pending;
  return pending;
};
