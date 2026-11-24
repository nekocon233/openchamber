import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readGitHubPullFiles } from './pull-diff.js';
import type { GitHubPullRepo } from './pull-diff.js';
import type { PullRequestSnapshot } from '../git/pull-request-snapshot.js';
import { isCacheIdentity } from './contracts.js';
import type { Octokit } from './contracts.js';

export const MAX_INLINE_PR_FILES_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_PR_FILE_PATCH_BYTES = 512 * 1024;
export const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SINGLE_FILE_PATCH_BYTES = 5 * 1024 * 1024;

const FILE_DIFF_TIMEOUT_MS = 30_000;
const MERGE_BASE_CACHE_LIMIT = 128;

export type PullRequestComparisonFileStatus = 'A' | 'D' | 'M' | 'R' | 'C' | 'T';

export interface PullRequestComparisonFile {
  path: string;
  previousPath?: string;
  status: PullRequestComparisonFileStatus;
  insertions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubPullFileListResult {
  headSha: string;
  files: PullRequestComparisonFile[];
}

export interface GitHubPullFileDiffResult {
  diff: string;
  headSha: string;
}

export interface ReadGitHubPullFileListInput {
  octokit: Octokit;
  repo: GitHubPullRepo;
  number: number;
  readSnapshot?: ((input: {
    expectedHeadSha: string;
    expectedBaseSha: string;
  }) => Promise<Pick<PullRequestSnapshot, 'files'>>) | undefined;
  signal?: AbortSignal | undefined;
}

export interface ReadGitHubPullFileDiffInput {
  octokit: Octokit;
  repo: GitHubPullRepo;
  number: number;
  path: string;
  previousPath?: string | undefined;
  status: string;
  expectedHeadSha?: string | undefined;
  signal?: AbortSignal | undefined;
  computeDiff?: ((input: ComputeUnifiedFilePatchInput) => Promise<string>) | undefined;
}

export interface ComputeUnifiedFilePatchInput {
  path: string;
  previousPath?: string | undefined;
  status: string;
  original: string;
  modified: string;
  signal?: AbortSignal | undefined;
  maxOutputBytes?: number | undefined;
}

type FileSide =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'submodule'; sha: string };

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const pullListRevisionSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({ sha: shaSchema }),
  base: z.object({ sha: shaSchema }),
  changed_files: z.number().int().nonnegative(),
});
const pullHeadSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({ sha: shaSchema }),
  base: z.object({ sha: shaSchema }),
});
const compareSchema = z.object({ merge_base_commit: z.object({ sha: shaSchema }) });
const contentFileSchema = z.object({
  type: z.literal('file'),
  size: z.number().int().nonnegative().optional(),
  sha: z.string().min(1).optional(),
  encoding: z.string().nullish(),
  content: z.string().nullish(),
});
const contentSubmoduleSchema = z.object({
  type: z.literal('submodule'),
  sha: z.string().min(1),
});
const contentSymlinkSchema = z.object({
  type: z.literal('symlink'),
  target: z.string().optional(),
});
const directoryListingSchema = z.array(z.object({
  type: z.string(),
  path: z.string(),
  name: z.string(),
  sha: z.string().min(1),
  size: z.number().int().nonnegative().optional(),
}));
const blobSchema = z.object({
  size: z.number().int().nonnegative().optional(),
  encoding: z.string(),
  content: z.string(),
});
const tooLargeContentSchema = z.object({
  status: z.union([z.literal(403), z.literal(422)]),
  response: z.object({
    data: z.object({
      errors: z.array(z.object({ code: z.string() })),
    }),
  }),
});

const mergeBaseByOctokit = new WeakMap<object, Map<string, string>>();
const mergeBaseByIdentity = new Map<string, string>();

const staleError = () => Object.assign(new Error('Pull request changed; refresh the diff'), {
  status: 409,
  statusCode: 409,
  code: 'STALE_CONFIG',
});

const fileTooLargeError = (message = 'This file is too large to show') => Object.assign(new Error(message), {
  status: 413,
  statusCode: 413,
  code: 'file-too-large',
});

const rawTextSchema = z.string();

const tooLargeErrorMatches = (parsed: ReturnType<typeof tooLargeContentSchema.safeParse>): boolean =>
  parsed.success && parsed.data.response.data.errors.some((entry) => entry.code === 'too_large');

const needsGitPathQuoting = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) return true;
  }
  return false;
};

const formatGitPath = (value: string): string => {
  if (!needsGitPathQuoting(value)) return value;
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    const code = value.charCodeAt(index);
    if (char === '\\') escaped += '\\\\';
    else if (char === '"') escaped += '\\"';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\r') escaped += '\\r';
    else if (char === '\t') escaped += '\\t';
    else if (code < 0x20 || code === 0x7f) escaped += `\\${code.toString(8).padStart(3, '0')}`;
    else escaped += char;
  }
  return `"${escaped}"`;
};

export const formatGitDiffPath = (prefix: 'a/' | 'b/', filePath: string): string => formatGitPath(`${prefix}${filePath}`);

export function mapGitHubFileStatus(status: string): PullRequestComparisonFileStatus {
  switch (status) {
    case 'A':
    case 'added':
      return 'A';
    case 'D':
    case 'removed':
      return 'D';
    case 'R':
    case 'renamed':
      return 'R';
    case 'C':
    case 'copied':
      return 'C';
    case 'T':
    case 'changed':
      return 'T';
    default:
      return 'M';
  }
}

function buildPatchHeaderLines(file: {
  path: string;
  previousPath?: string | undefined;
  status: string;
}) {
  const code = mapGitHubFileStatus(file.status);
  const newPath = file.path;
  const oldPath = file.previousPath || file.path;
  const lines = [`diff --git ${formatGitDiffPath('a/', oldPath)} ${formatGitDiffPath('b/', newPath)}`];
  if (code === 'A') {
    lines.push('new file mode 100644');
  } else if (code === 'D') {
    lines.push('deleted file mode 100644');
  } else if (code === 'R') {
    lines.push(`rename from ${formatGitPath(oldPath)}`, `rename to ${formatGitPath(newPath)}`);
  } else if (code === 'C') {
    lines.push(`copy from ${formatGitPath(oldPath)}`, `copy to ${formatGitPath(newPath)}`);
  }
  return { code, oldPath, newPath, lines };
}

export function buildGitHubFilePatch(file: {
  path: string;
  previousPath?: string | undefined;
  status: string;
  patch: string;
}): string {
  const { code, oldPath, newPath, lines } = buildPatchHeaderLines(file);
  lines.push(
    `--- ${code === 'A' ? '/dev/null' : formatGitDiffPath('a/', oldPath)}`,
    `+++ ${code === 'D' ? '/dev/null' : formatGitDiffPath('b/', newPath)}`,
  );
  const body = file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`;
  return `${lines.join('\n')}\n${body}`;
}

export function buildBinaryFilePatch(file: {
  path: string;
  previousPath?: string | undefined;
  status: string;
}): string {
  const { code, oldPath, newPath, lines } = buildPatchHeaderLines(file);
  const left = code === 'A' ? '/dev/null' : formatGitDiffPath('a/', oldPath);
  const right = code === 'D' ? '/dev/null' : formatGitDiffPath('b/', newPath);
  lines.push(`Binary files ${left} and ${right} differ`);
  return `${lines.join('\n')}\n`;
}

export function buildMetadataOnlyFilePatch(file: {
  path: string;
  previousPath?: string | undefined;
  status: string;
}): string {
  const { lines } = buildPatchHeaderLines(file);
  return `${lines.join('\n')}\n`;
}

export function buildSubmoduleFilePatch(file: {
  path: string;
  previousPath?: string | undefined;
  status: string;
  oldSha?: string | undefined;
  newSha?: string | undefined;
}): string {
  const { oldSha, newSha } = file;
  if (!oldSha && !newSha) return buildMetadataOnlyFilePatch(file);
  const hunk = oldSha && newSha
    ? `@@ -1 +1 @@\n-Subproject commit ${oldSha}\n+Subproject commit ${newSha}\n`
    : newSha
      ? `@@ -0,0 +1 @@\n+Subproject commit ${newSha}\n`
      : `@@ -1 +0,0 @@\n-Subproject commit ${oldSha}\n`;
  return buildGitHubFilePatch({ ...file, patch: hunk });
}

const isBinaryBuffer = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0);

const isBinaryText = (text: string): boolean => text.slice(0, 8000).includes('\0');

const isolatedGitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of Object.keys(env)) {
    if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|SHALLOW_FILE|NAMESPACE|REPLACE_REF_BASE|GRAFT_FILE|TEMPLATE_DIR|EXEC_PATH|ATTR_SOURCE|PREFIX)$/i.test(name)) {
      delete env[name];
    }
  }
  return env;
};

export async function computeUnifiedFilePatch({
  path: filePath,
  previousPath,
  status,
  original,
  modified,
  signal,
  maxOutputBytes = MAX_SINGLE_FILE_PATCH_BYTES,
}: ComputeUnifiedFilePatchInput): Promise<string> {
  if (original === modified) {
    return buildMetadataOnlyFilePatch({ path: filePath, previousPath, status });
  }
  signal?.throwIfAborted();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-file-diff-'));
  try {
    await fs.chmod(tempDir, 0o700);
    await Promise.all([
      fs.writeFile(path.join(tempDir, 'old'), original, 'utf8'),
      fs.writeFile(path.join(tempDir, 'new'), modified, 'utf8'),
    ]);
    signal?.throwIfAborted();
    const hooksPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', [
        '-c', `core.hooksPath=${hooksPath}`,
        '-c', 'core.quotePath=false',
        '-c', 'core.attributesFile=',
        'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', 'old', 'new',
      ], {
        cwd: tempDir,
        env: isolatedGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      let failure: Error | null = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const abortChild = (error: Error) => {
        if (!failure) failure = error;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          return;
        }
        finish(() => reject(failure ?? error));
      };
      const onAbort = () => {
        abortChild(Object.assign(new Error('Pull request file diff was cancelled'), { status: 499, statusCode: 499, code: 'CANCELLED' }));
      };
      const timer = setTimeout(() => {
        abortChild(Object.assign(new Error('Pull request file diff timed out'), { status: 504, statusCode: 504, code: 'TIMEOUT' }));
      }, FILE_DIFF_TIMEOUT_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return;
        totalBytes += chunk.length;
        if (totalBytes > maxOutputBytes) {
          abortChild(fileTooLargeError('This file diff is too large to show'));
          return;
        }
        chunks.push(chunk);
      });
      child.on('error', (error) => {
        finish(() => reject(failure ?? error));
      });
      child.on('close', (code) => {
        finish(() => {
          if (failure) {
            reject(failure);
            return;
          }
          if (code === 0 || code === 1) {
            resolve(Buffer.concat(chunks).toString('utf8'));
            return;
          }
          reject(Object.assign(new Error('Pull request file diff could not be computed'), { status: 502, statusCode: 502 }));
        });
      });
    });

    if (!stdout) return buildMetadataOnlyFilePatch({ path: filePath, previousPath, status });
    const hunkStart = stdout.startsWith('@@ ') ? 0 : stdout.indexOf('\n@@ ');
    if (hunkStart >= 0) {
      const hunks = hunkStart === 0 ? stdout : stdout.slice(hunkStart + 1);
      return buildGitHubFilePatch({ path: filePath, previousPath, status, patch: hunks });
    }
    if (/^Binary files .+ differ$/m.test(stdout)) {
      return buildBinaryFilePatch({ path: filePath, previousPath, status });
    }
    return buildMetadataOnlyFilePatch({ path: filePath, previousPath, status });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function readGitHubPullFileList({
  octokit,
  repo,
  number,
  readSnapshot,
  signal,
}: ReadGitHubPullFileListInput): Promise<GitHubPullFileListResult> {
  const pullParameters = () => {
    const params: Parameters<Octokit['rest']['pulls']['get']>[0] = {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
    };
    if (signal) params.request = { signal };
    return params;
  };
  const readRevision = async () => pullListRevisionSchema.parse((await octokit.rest.pulls.get(pullParameters())).data);
  const before = await readRevision();
  if (before.number !== number) throw staleError();

  let usedSnapshot = false;
  const entries = await readGitHubPullFiles({
    octokit,
    repo,
    number,
    expectedCount: before.changed_files,
    signal,
    readSnapshot: readSnapshot
      ? async () => {
        usedSnapshot = true;
        return readSnapshot({ expectedHeadSha: before.head.sha, expectedBaseSha: before.base.sha });
      }
      : undefined,
  });

  if (!usedSnapshot) {
    if (entries.length !== before.changed_files || new Set(entries.map((entry) => entry.filename)).size !== entries.length) {
      const after = await readRevision();
      if (after.number !== number || after.head.sha !== before.head.sha || after.base.sha !== before.base.sha || after.changed_files !== before.changed_files) {
        throw staleError();
      }
      throw new Error('GitHub returned an incomplete pull request file list');
    }
    const after = await readRevision();
    if (after.number !== number || after.head.sha !== before.head.sha || after.base.sha !== before.base.sha || after.changed_files !== before.changed_files) {
      throw staleError();
    }
  }

  let inlineBytes = 0;
  const files: PullRequestComparisonFile[] = entries.map((entry) => {
    const status = mapGitHubFileStatus(entry.status);
    const file: PullRequestComparisonFile = {
      path: entry.filename,
      status,
      insertions: entry.additions,
      deletions: entry.deletions,
    };
    if (entry.previous_filename) {
      file.previousPath = entry.previous_filename;
    }
    if (entry.patch) {
      const fullPatch = buildGitHubFilePatch({
        path: entry.filename,
        previousPath: entry.previous_filename,
        status,
        patch: entry.patch,
      });
      const bytes = Buffer.byteLength(fullPatch);
      if (bytes <= MAX_INLINE_PR_FILE_PATCH_BYTES && inlineBytes + bytes <= MAX_INLINE_PR_FILES_PATCH_BYTES) {
        file.patch = fullPatch;
        inlineBytes += bytes;
      }
    } else if ('binary' in entry && entry.binary === true) {
      file.patch = buildBinaryFilePatch({
        path: entry.filename,
        previousPath: entry.previous_filename,
        status,
      });
    }
    return file;
  });

  return { headSha: before.head.sha, files };
}

function getMergeBaseCache(octokit: Octokit) {
  const identity = 'openChamberCacheIdentity' in octokit && isCacheIdentity(octokit.openChamberCacheIdentity)
    ? octokit.openChamberCacheIdentity
    : '';
  if (identity) {
    return { store: mergeBaseByIdentity, keyPrefix: `${identity}\0` };
  }
  let store = mergeBaseByOctokit.get(octokit);
  if (!store) {
    store = new Map();
    mergeBaseByOctokit.set(octokit, store);
  }
  return { store, keyPrefix: '' };
}

async function resolveMergeBaseSha(
  octokit: Octokit,
  repo: GitHubPullRepo,
  baseSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<string> {
  const { store, keyPrefix } = getMergeBaseCache(octokit);
  const key = `${keyPrefix}${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}\0${baseSha}\0${headSha}`;
  const cached = store.get(key);
  if (cached) {
    store.delete(key);
    store.set(key, cached);
    return cached;
  }
  const params: Parameters<Octokit['rest']['repos']['compareCommitsWithBasehead']>[0] = {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: 1,
  };
  if (signal) params.request = { signal };
  const comparison = compareSchema.parse((await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', params)).data);
  const mergeBaseSha = comparison.merge_base_commit.sha;
  store.set(key, mergeBaseSha);
  if (store.size > MERGE_BASE_CACHE_LIMIT) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return mergeBaseSha;
}

async function readBlobSide(
  octokit: Octokit,
  repo: GitHubPullRepo,
  blobSha: string,
  signal?: AbortSignal,
): Promise<FileSide> {
  const params: Parameters<Octokit['rest']['git']['getBlob']>[0] = {
    owner: repo.owner,
    repo: repo.repo,
    file_sha: blobSha,
  };
  if (signal) params.request = { signal };
  let response: { data: unknown };
  try {
    response = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', params);
  } catch (error) {
    if (tooLargeErrorMatches(tooLargeContentSchema.safeParse(error))) throw fileTooLargeError();
    throw error;
  }
  const blob = blobSchema.parse(response.data);
  if (blob.size !== undefined && blob.size > MAX_SINGLE_FILE_BYTES) {
    throw fileTooLargeError();
  }
  if (blob.encoding !== 'base64') {
    throw new Error('GitHub returned unsupported file encoding');
  }
  const buffer = Buffer.from(blob.content, 'base64');
  if (buffer.byteLength > MAX_SINGLE_FILE_BYTES) {
    throw fileTooLargeError();
  }
  if (isBinaryBuffer(buffer)) return { kind: 'binary' };
  return { kind: 'text', content: buffer.toString('utf8') };
}

async function readRawFallbackSide(
  octokit: Octokit,
  repo: GitHubPullRepo,
  filePath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<FileSide> {
  const params: Parameters<Octokit['rest']['repos']['getContent']>[0] = {
    owner: repo.owner,
    repo: repo.repo,
    path: filePath,
    ref,
    headers: { accept: 'application/vnd.github.raw+json' },
  };
  if (signal) params.request = { signal };
  let response: { data: unknown };
  try {
    response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', params);
  } catch (error) {
    if (tooLargeErrorMatches(tooLargeContentSchema.safeParse(error))) throw fileTooLargeError();
    throw error;
  }
  const content = response.data;
  const textContent = rawTextSchema.safeParse(content);
  if (textContent.success) {
    if (Buffer.byteLength(textContent.data) > MAX_SINGLE_FILE_BYTES) throw fileTooLargeError();
    if (isBinaryText(textContent.data)) return { kind: 'binary' };
    return { kind: 'text', content: textContent.data };
  }
  if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
    const buffer = content instanceof ArrayBuffer
      ? Buffer.from(content)
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (buffer.byteLength > MAX_SINGLE_FILE_BYTES) throw fileTooLargeError();
    if (isBinaryBuffer(buffer)) return { kind: 'binary' };
    return { kind: 'text', content: buffer.toString('utf8') };
  }
  throw new Error('GitHub returned invalid file contents');
}

async function readGitHubFileSide(
  octokit: Octokit,
  repo: GitHubPullRepo,
  filePath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<FileSide> {
  const params: Parameters<Octokit['rest']['repos']['getContent']>[0] = {
    owner: repo.owner,
    repo: repo.repo,
    path: filePath,
    ref,
  };
  if (signal) params.request = { signal };
  let response: { data: unknown };
  try {
    response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', params);
  } catch (error) {
    if (!tooLargeErrorMatches(tooLargeContentSchema.safeParse(error))) throw error;
    const slash = filePath.lastIndexOf('/');
    const parentDir = slash >= 0 ? filePath.slice(0, slash) : '';
    const dirParams: Parameters<Octokit['rest']['repos']['getContent']>[0] = {
      owner: repo.owner,
      repo: repo.repo,
      path: parentDir,
      ref,
    };
    if (signal) dirParams.request = { signal };
    try {
      const listingResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', dirParams);
      const listing = directoryListingSchema.safeParse(listingResponse.data);
      const entry = listing.success
        ? listing.data.find((item) => item.path === filePath || item.name === filePath.slice(slash + 1))
        : undefined;
      if (entry?.type === 'file') {
        if (entry.size !== undefined && entry.size > MAX_SINGLE_FILE_BYTES) {
          throw fileTooLargeError();
        }
        return readBlobSide(octokit, repo, entry.sha, signal);
      }
    } catch (listingError) {
      if (signal?.aborted || !tooLargeErrorMatches(tooLargeContentSchema.safeParse(listingError))) {
        throw listingError;
      }
    }
    return readRawFallbackSide(octokit, repo, filePath, ref, signal);
  }

  const submodule = contentSubmoduleSchema.safeParse(response.data);
  if (submodule.success) {
    return { kind: 'submodule', sha: submodule.data.sha };
  }
  const symlink = contentSymlinkSchema.safeParse(response.data);
  if (symlink.success) {
    return { kind: 'text', content: symlink.data.target ?? '' };
  }
  const file = contentFileSchema.safeParse(response.data);
  if (!file.success) {
    throw new Error('GitHub returned invalid file contents');
  }
  if (file.data.size !== undefined && file.data.size > MAX_SINGLE_FILE_BYTES) {
    throw fileTooLargeError();
  }
  if (file.data.encoding === 'base64' && file.data.content) {
    const buffer = Buffer.from(file.data.content, 'base64');
    if (buffer.byteLength > MAX_SINGLE_FILE_BYTES) throw fileTooLargeError();
    if (isBinaryBuffer(buffer)) return { kind: 'binary' };
    return { kind: 'text', content: buffer.toString('utf8') };
  }
  if (file.data.size === 0) {
    return { kind: 'text', content: '' };
  }
  if (file.data.sha) {
    return readBlobSide(octokit, repo, file.data.sha, signal);
  }
  throw new Error('GitHub returned invalid file contents');
}

export async function readGitHubPullFileDiff({
  octokit,
  repo,
  number,
  path: filePath,
  previousPath,
  status,
  expectedHeadSha,
  signal,
  computeDiff = computeUnifiedFilePatch,
}: ReadGitHubPullFileDiffInput): Promise<GitHubPullFileDiffResult> {
  const pullParams: Parameters<Octokit['rest']['pulls']['get']>[0] = {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: number,
  };
  if (signal) pullParams.request = { signal };
  const pull = pullHeadSchema.parse((await octokit.rest.pulls.get(pullParams)).data);
  if (pull.number !== number || (expectedHeadSha && pull.head.sha !== expectedHeadSha)) {
    throw staleError();
  }

  const code = mapGitHubFileStatus(status);
  const needsOld = code !== 'A';
  const needsNew = code !== 'D';
  const mergeBaseSha = needsOld ? await resolveMergeBaseSha(octokit, repo, pull.base.sha, pull.head.sha, signal) : '';

  const [oldSide, newSide] = await Promise.all([
    needsOld ? readGitHubFileSide(octokit, repo, previousPath || filePath, mergeBaseSha, signal) : Promise.resolve<FileSide>({ kind: 'text', content: '' }),
    needsNew ? readGitHubFileSide(octokit, repo, filePath, pull.head.sha, signal) : Promise.resolve<FileSide>({ kind: 'text', content: '' }),
  ]);

  if (oldSide.kind === 'binary' || newSide.kind === 'binary') {
    return {
      diff: buildBinaryFilePatch({ path: filePath, previousPath, status: code }),
      headSha: pull.head.sha,
    };
  }
  if (oldSide.kind === 'submodule' || newSide.kind === 'submodule') {
    return {
      diff: buildSubmoduleFilePatch({
        path: filePath,
        previousPath,
        status: code,
        oldSha: oldSide.kind === 'submodule' ? oldSide.sha : undefined,
        newSha: newSide.kind === 'submodule' ? newSide.sha : undefined,
      }),
      headSha: pull.head.sha,
    };
  }

  const diff = await computeDiff({
    path: filePath,
    previousPath,
    status: code,
    original: oldSide.content,
    modified: newSide.content,
    signal,
  });
  return { diff, headSha: pull.head.sha };
}
