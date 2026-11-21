import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { SUBMODULE_DISCOVERY_LIMITS } from './submodule-discovery.js';
import { createLfsFileScanner, LFS_DISCOVERY_LIMITS } from './lfs-discovery.js';
import type { ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import type { BinaryLike } from 'node:crypto';
import type { LfsObjectEntry } from './lfs-discovery.js';
import type { Completion, LstatSnapshot, TrustedDirectoriesOptions } from './network-execution-contracts.js';

export const occupied = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new TypeError('Git execution invariant value is missing');
  return value;
};

export type ErrorFields = {
  code?: unknown; message?: unknown; reason?: unknown; status?: unknown;
  cancelled?: unknown; timedOut?: unknown; stderr?: unknown; stdout?: unknown;
  hydrationHandled?: unknown;
};

export const hasErrorFields = (value: unknown): value is ErrorFields => value !== null && value !== undefined;

export const errorFields = <Value>(value: Value): ErrorFields => hasErrorFields(value) ? value : {};

const MANAGED_ENV_NAMES = new Set([
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_PROXY_COMMAND', 'SSH_AUTH_SOCK', 'OPENCHAMBER_GIT_SSH_KEY', 'OPENCHAMBER_GIT_SSH_PASSPHRASE',
  'OPENCHAMBER_GIT_SSH_EXECUTABLE',
  'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
  'GIT_SSL_CIPHER_LIST', 'GIT_SSL_VERSION', 'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CERT_PASSWORD_PROTECTED', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NETRC',
]);

export const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const GITLINK_PATTERN = /^160000 commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)(?: +-\t|\t)([^]+)$/;

const INDEX_FILE_MODES = new Set(['100644', '100755', '120000', '160000']);

export const LINE_ENDING_CONFIG_PATTERN = 'core\\.(autocrlf|eol|safecrlf|attributesfile)';

export const operationError = <Details extends object, Status = number>(code: string, message: string, status: Status | number = 500, details: Details | Record<never, never> = {}) => Object.assign(new Error(message), details, { code, status });

export const publicError = <Code, Message>(code: Code, message: Message) => ({ code, message });

export const terminal = <Code, Message>(state: string, code: Code, message: Message): Completion => ({ state, error: publicError(code, message) });

const INDEX_ENTRY_PATTERN = /^([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([^]+)$/;

export const createIndexFilesStream = (scanner: ReturnType<typeof createLfsFileScanner>) => {
  let remainder: Buffer = Buffer.alloc(0);
  let batch: string[] = [];
  let objectEntries = new Map<string, LfsObjectEntry>();
  let batchBytes = 0;
  let previousStageZeroPath: string | null = null;
  const flush = async () => {
    if (!batch.length) return;
    const pending = batch;
    const pendingObjectEntries = objectEntries;
    batch = [];
    objectEntries = new Map();
    batchBytes = 0;
    await scanner.scanBatch(pending, pendingObjectEntries);
  };
  const add = async (record: Buffer) => {
    const text = record.toString('utf8');
    if (text.includes('\ufffd')) throw operationError('INVALID_REQUEST', 'Tracked-file listing is not valid UTF-8', 409);
    const match = text.match(INDEX_ENTRY_PATTERN);
    if (!match) throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
    if (match[3] !== '0') return;
    const file = occupied(match[4]);
    if (!INDEX_FILE_MODES.has(occupied(match[1])) || previousStageZeroPath === file) {
      throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
    }
    previousStageZeroPath = file;
    if (match[1] === '160000') return;
    const bytes = Buffer.byteLength(file) + 32;
    if (bytes > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
      throw operationError('LFS_DISCOVERY_LIMIT_EXCEEDED', 'Tracked path exceeds its byte limit', 409);
    }
    if (batch.length >= LFS_DISCOVERY_LIMITS.fileBatchSize || batchBytes + bytes > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
      await flush();
    }
    batch.push(file);
    batchBytes += bytes;
    objectEntries.set(file, { oid: occupied(match[2]), type: 'blob' });
  };
  return Object.freeze({
    async write(chunk: Buffer) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      remainder = remainder.length ? Buffer.concat([remainder, input]) : input;
      for (let separator; (separator = remainder.indexOf(0)) >= 0;) {
        const record = remainder.subarray(0, separator);
        remainder = remainder.subarray(separator + 1);
        if (!record.length) throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
        await add(record);
      }
      if (remainder.length > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
        throw operationError('LFS_DISCOVERY_LIMIT_EXCEEDED', 'Tracked-file listing record exceeds its byte limit', 409);
      }
    },
    async complete() {
      if (remainder.length) throw operationError('INVALID_REQUEST', 'Tracked-file listing is incomplete', 409);
      await flush();
      return scanner.result();
    },
  });
};

export const createGitlinksStream = () => {
  let remainder: Buffer = Buffer.alloc(0);
  let output = '';
  return Object.freeze({
    write(chunk: Buffer) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      remainder = remainder.length ? Buffer.concat([remainder, input]) : input;
      for (let separator; (separator = remainder.indexOf(0)) >= 0;) {
        const record = remainder.subarray(0, separator).toString('utf8');
        remainder = remainder.subarray(separator + 1);
        if (record.includes('\ufffd')) throw operationError('INVALID_REQUEST', 'Tree listing is not valid UTF-8', 409);
        const match = record.match(GITLINK_PATTERN);
        if (!match) continue;
        const entry = `${record}\0`;
        if (Buffer.byteLength(output) + Buffer.byteLength(entry) > SUBMODULE_DISCOVERY_LIMITS.maxGitlinkBytes) {
          throw operationError('SUBMODULE_DISCOVERY_LIMIT_EXCEEDED', 'Submodule gitlink listing exceeds its byte limit', 409);
        }
        output += entry;
      }
      if (remainder.length > SUBMODULE_DISCOVERY_LIMITS.maxGitlinkBytes) {
        throw operationError('SUBMODULE_DISCOVERY_LIMIT_EXCEEDED', 'Tree listing record exceeds its byte limit', 409);
      }
    },
    complete() {
      if (remainder.length) throw operationError('INVALID_REQUEST', 'Tree listing is incomplete', 409);
      return output;
    },
  });
};

export const singleRefFetchRefspec = (sourceRef: string, destinationRef: string) => (
  `${destinationRef.startsWith('refs/remotes/') ? '+' : ''}${sourceRef}:${destinationRef}`
);

const fileIdentity = (stats: Stats) => `${stats.dev}:${stats.ino}`;

export const directoryIdentity = (stats: Stats, birthtimeHolds: boolean) => (birthtimeHolds
  ? `${fileIdentity(stats)}:${stats.birthtimeMs}` : fileIdentity(stats));

export const lstatSnapshot = (stats: Stats) => ({
  identity: fileIdentity(stats),
  mode: stats.mode,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
});

export const sameLstat = (stats: Stats, snapshot: LstatSnapshot) => stats
  && fileIdentity(stats) === snapshot.identity
  && stats.mode === snapshot.mode
  && stats.size === snapshot.size
  && stats.mtimeMs === snapshot.mtimeMs
  && stats.ctimeMs === snapshot.ctimeMs;

export const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export const contentDigest = (value: BinaryLike) => crypto.createHash('sha256').update(value).digest('base64url');

export const publicTransportForContributor = () => ({
  mode: 'managed', verification: { status: 'verified', method: 'credential' },
});

export const managedEnvironment = (source: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  const result = { ...source };
  for (const name of Object.keys(result)) {
    const normalized = platform === 'win32' ? name.toUpperCase() : name;
    if (MANAGED_ENV_NAMES.has(normalized)
      || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(normalized)
      || /^GIT_TRACE(?:2)?(?:_|$)/.test(normalized)
      || normalized === 'GIT_CURL_VERBOSE'
      || normalized === 'GIT_REDIRECT_STDERR'
      || /^CURL_/.test(normalized)) delete result[name];
  }
  result.GIT_TERMINAL_PROMPT = '0';
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  return result;
};

const TRUSTED_DIRECTORIES_READ_TIMEOUT_MS = 5_000;

const gitConfigValue = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const createTrustedDirectoriesConfig = ({
  gitBinary = 'git',
  inheritedEnv = process.env,
  spawnImpl = spawn,
  fsImpl = fs,
  pathImpl = path,
  tmpdir = os.tmpdir,
}: TrustedDirectoriesOptions = {}) => {
  let directory: string | null = null;
  const readValues = () => new Promise<string[]>((resolve) => {
    let child: ReturnType<typeof spawn> & { stdout: NonNullable<ChildProcess['stdout']> };
    try {
      child = spawnImpl(gitBinary, ['config', '--null', '--includes', '--get-all', 'safe.directory'], {
        cwd: tmpdir(), env: { ...inheritedEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), TRUSTED_DIRECTORIES_READ_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').slice(0, -1) : []);
    });
  });
  const write = async (content: string) => {
    directory ??= await fsImpl.mkdtemp(pathImpl.join(tmpdir(), 'openchamber-git-trust-'));
    const target = pathImpl.join(directory, 'config');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsImpl.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(temporary, target);
    return target;
  };
  return async () => {
    const values = (await readValues()).filter((value) => !/[\r\n]/.test(value));
    if (values.length === 0) return null;
    const content = `[safe]\n${values.map((value) => `\tdirectory = ${gitConfigValue(value)}\n`).join('')}`;
    try {
      return await write(content);
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.code !== 'ENOENT') throw cause;
      directory = null;
      return write(content);
    }
  };
};

const HTTP_CONFIG_RESETS = new Map([
  ['proxy', ''],
  ['sslverify', 'true'],
  ['sslcainfo', ''],
  ['sslcapath', ''],
  ['sslcert', ''],
  ['sslcerttype', ''],
  ['sslcertpasswordprotected', 'false'],
  ['sslkey', ''],
  ['sslkeytype', ''],
  ['extraheader', ''],
  ['cookiefile', ''],
  ['savecookies', 'false'],
  ['followredirects', 'false'],
  ['emptyauth', 'false'],
  ['delegation', 'none'],
  ['sslautoclientcert', 'false'],
]);

const CREDENTIAL_CONFIG_RESETS = new Map([
  ['helper', ''],
  ['askpass', ''],
  ['username', ''],
  ['interactive', 'false'],
  ['usehttppath', 'false'],
]);

export const configResetValue = (key: string) => {
  const normalized = key.toLowerCase();
  const suffix = normalized.slice(normalized.lastIndexOf('.') + 1);
  if (normalized.startsWith('http.')) return HTTP_CONFIG_RESETS.get(suffix);
  if (normalized.startsWith('credential.')) return CREDENTIAL_CONFIG_RESETS.get(suffix);
  return undefined;
};
