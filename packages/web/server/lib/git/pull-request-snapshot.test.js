import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetworkOperations } from './network-operations.js';
import { createSourceControlAuditStore } from '../source-control/audit-storage.js';
import { createGitNetworkOperationStore } from './network-operation-storage.js';
import { parsePullRequestDiff } from '../../../../ui/src/lib/diff/pullRequestDiff';

const exec = promisify(execFile);
const roots = [];
const temporaryRepositories = [];
const children = [];
const endpoint = 'https://github.com/acme/app.git';
const account = { credentialId: 'account-7', credentialRevision: 1, providerUserId: 'github.com#7', status: 'valid' };
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all([...roots.splice(0), ...temporaryRepositories.splice(0)].map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pr-fixture-'));
  roots.push(root);
  const directory = path.join(root, 'checkout');
  await fs.mkdir(directory);
  const git = async (...args) => (await exec('git', args, { cwd: directory, env })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(directory, 'old.txt'), 'rename this\n');
  await fs.writeFile(path.join(directory, 'removed.txt'), 'remove this\n');
  await fs.writeFile(path.join(directory, 'executable'), '#!/bin/sh\n');
  await git('add', '.');
  await git('commit', '-qm', 'initial');
  const initial = await git('rev-parse', 'HEAD');
  await git('update-index', '--add', '--cacheinfo', `160000,${initial},submodule`);
  await git('commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD');
  await git('checkout', '-b', 'feature');
  for (let start = 0; start < count; start += 100) await Promise.all(
    Array.from({ length: Math.min(100, count - start) }, (_, offset) => fs.writeFile(path.join(directory, `file-${start + offset}.txt`), 'published\n')),
  );
  await fs.rename(path.join(directory, 'old.txt'), path.join(directory, 'renamed.txt'));
  await fs.rm(path.join(directory, 'removed.txt'));
  await fs.writeFile(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(directory, '引号 "\t换行\n.txt'), 'paths survive\n');
  await fs.chmod(path.join(directory, 'executable'), 0o755);
  await git('add', '.');
  await git('update-index', '--chmod=+x', 'executable');
  await git('update-index', '--add', '--cacheinfo', `160000,${base},submodule`);
  await git('commit', '-qm', 'feature');
  const head = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  await fs.writeFile(path.join(directory, 'base-only.txt'), 'not in the PR\n');
  await git('add', '.');
  await git('commit', '-qm', 'base advances');
  const baseTip = await git('rev-parse', 'HEAD');
  await git('checkout', 'feature');
  await fs.writeFile(path.join(directory, 'staged.txt'), 'local staged\n');
  await git('add', 'staged.txt');
  await fs.writeFile(path.join(directory, 'untracked.txt'), 'local untracked\n');
  await fs.writeFile(path.join(directory, 'file-0.txt'), 'local unstaged\n');
  await fs.writeFile(path.join(directory, '.git', 'FETCH_HEAD'), 'keep this\n');
  const context = { provider: 'github', instance: 'github.com', accountId: account.credentialId,
    directory, repositoryId: 'fixture', bindingRevision: 1, primaryRemote: 'origin' };
  const source = { context, repo: { owner: 'acme', repo: 'app' }, number: 7,
    headSha: head, baseSha: baseTip, mergeBaseSha: base, endpoint };
  return { root, directory, git, source };
}

function runtime(f, { resolveSource = async () => f.source, intercept, fsImpl, timeoutMs } = {}) {
  const calls = [];
  const revoked = [];
  const auditFile = path.join(f.root, 'audit.json');
  const operationFile = path.join(f.root, 'operations.json');
  const spawnImpl = (binary, args, options) => {
    calls.push({ binary, args, cwd: options.cwd, env: options.env });
    if (options.cwd?.includes('openchamber-pr-git_') && !temporaryRepositories.includes(options.cwd)) temporaryRepositories.push(options.cwd);
    const override = intercept?.(binary, args, options);
    if (override) { children.push(override); return override; }
    // Only the fixture replaces transport: the production argv and isolated
    // environment are inspected before a real fetch from a local repository.
    const finalArgs = args.map(arg => arg === endpoint ? pathToFileURL(f.directory).href : arg);
    const child = spawn(binary, finalArgs, { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: args.includes('fetch') ? 'file' : options.env.GIT_ALLOW_PROTOCOL } });
    children.push(child);
    return child;
  };
  const resolve = vi.fn(async () => ({ mode: 'managed', transport: 'https', username: 'x-access-token', password: 'fixture-secret', allowedEndpoint: endpoint }));
  const service = createNetworkOperations({
    runtimeIdentity: { id: 'fixture-runtime', platform: 'web' },
    validateGitTransportContext: async () => { throw new Error('Must use the PR authority'); },
    resolvePullRequestSnapshotSource: resolveSource,
    validatePullRequestReadContext: async () => (await resolveSource()).context,
    resolveSourceControlAccount: async () => account,
    credentialResolver: { resolve },
    credentialBroker: { start: async () => {}, issue: ({ operationId }) => ({ env: {}, gitConfigArgs: [], revoke: () => revoked.push(operationId) }), revoke: () => {} },
    inheritedEnv: { ...env, GIT_DIR: path.join(f.directory, '.git'), GIT_WORK_TREE: f.directory, GIT_INDEX_FILE: path.join(f.directory, '.git', 'index') },
    spawnImpl, fsImpl, timeoutMs,
    auditStore: createSourceControlAuditStore({ filePath: auditFile }),
    operationStore: createGitNetworkOperationStore({ filePath: operationFile }),
  });
  return { service, calls, resolve, revoked, auditFile, operationFile };
}

describe('local pull request snapshots', () => {
  it.each([301, 3001])('reads every changed file in a %s-file PR without changing the checkout', async (count) => {
    const f = await fixture(count - 6);
    const before = await f.git('status', '--porcelain=v1', '-z');
    const indexBefore = await fs.readFile(path.join(f.directory, '.git', 'index'));
    const configBefore = await fs.readFile(path.join(f.directory, '.git', 'config'));
    const r = runtime(f);
    const result = await r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 });
    expect(result.files).toHaveLength(count);
    expect(result.files.some(file => file.filename === `file-${count - 7}.txt`)).toBe(true);
    expect(result.patch).toContain('+published');
    expect(result.patch).not.toContain('local unstaged');
    expect(result.patch).not.toContain('base-only');
    expect(result.files.find(file => file.filename === 'renamed.txt')).toMatchObject({ status: 'renamed', previous_filename: 'old.txt' });
    expect(result.files.find(file => file.filename === 'removed.txt')).toMatchObject({ status: 'removed' });
    expect(result.files.some(file => file.filename === '引号 "\t换行\n.txt')).toBe(true);
    expect(result.patch).toContain('Binary files');
    expect(result.patch).toContain('new mode 100755');
    expect(result.patch).toContain('Subproject commit');
    expect(parsePullRequestDiff(result.patch).map(file => file.path)).toEqual(result.files.map(file => file.filename));
    expect(await f.git('status', '--porcelain=v1', '-z')).toBe(before);
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.source.headSha);
    expect(await fs.readFile(path.join(f.directory, '.git', 'index'))).toEqual(indexBefore);
    expect(await fs.readFile(path.join(f.directory, '.git', 'config'))).toEqual(configBefore);
    expect(await fs.readFile(path.join(f.directory, '.git', 'FETCH_HEAD'), 'utf8')).toBe('keep this\n');
    const transfers = r.calls.filter(call => call.args.includes('fetch'));
    expect(transfers).toHaveLength(1);
    expect(transfers[0].args).toEqual(expect.arrayContaining(['--depth=1', '--no-write-fetch-head', f.source.headSha, f.source.mergeBaseSha]));
    expect(transfers[0].env.GIT_ALLOW_PROTOCOL).toBe('https');
    expect(r.calls.every(call => call.cwd !== f.directory && !call.env.GIT_DIR && !call.env.GIT_INDEX_FILE)).toBe(true);
    expect(r.revoked).toHaveLength(1);
    for (const directory of temporaryRepositories) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = await fs.readFile(r.auditFile, 'utf8') + await fs.readFile(r.operationFile, 'utf8');
    expect(persisted).toContain('pr-snapshot');
    expect(persisted).not.toContain('fixture-secret');
    expect(persisted).not.toContain('published');
    expect(persisted).not.toContain(f.source.headSha);
  }, 30_000);

  it('rejects a changed binding before credentials or Git are used', async () => {
    const f = await fixture();
    let reads = 0;
    const r = runtime(f, { resolveSource: async () => (++reads === 1 ? f.source : { ...f.source, context: { ...f.source.context, bindingRevision: 2 } }) });
    await expect(r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 })).rejects.toMatchObject({ code: 'STALE_CONFIG' });
    expect(r.calls).toHaveLength(0);
    expect(r.resolve).not.toHaveBeenCalled();
  });

  it('cancels an active fetch, waits for its exit and removes its temporary repository', async () => {
    const f = await fixture();
    const controller = new AbortController();
    let release;
    const started = new Promise(resolve => { release = resolve; });
    const r = runtime(f, { intercept: (binary, args, options) => {
      if (!args.includes('fetch')) return;
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      release();
      return child;
    } });
    const reading = r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7, signal: controller.signal });
    await started;
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    for (const directory of temporaryRepositories) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a truncated patch and cleans up after the output limit', async () => {
    const f = await fixture();
    const r = runtime(f, { intercept: (binary, args, options) => args.includes('--full-index')
      ? spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(20 * 1024 * 1024 + 1, 65))'], options) : undefined });
    await expect(r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 })).rejects.toMatchObject({ code: 'PR_DIFF_TOO_LARGE', status: 413 });
    for (const directory of temporaryRepositories) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts a rejected Git credential and removes the temporary repository', async () => {
    const f = await fixture();
    const r = runtime(f, { intercept: (binary, args, options) => args.includes('fetch')
      ? spawn(process.execPath, ['-e', 'process.stderr.write("fatal: Authentication failed fixture-secret"); process.exit(128)'], options) : undefined });
    let failure;
    try { await r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(failure.message).not.toContain('fixture-secret');
    expect(await fs.readFile(r.operationFile, 'utf8')).not.toContain('fixture-secret');
    for (const directory of temporaryRepositories) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies one deadline to the fetch and waits for the child to exit', async () => {
    const f = await fixture();
    const r = runtime(f, { timeoutMs: 250, intercept: (binary, args, options) => args.includes('fetch')
      ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options) : undefined });
    await expect(r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    for (const directory of temporaryRepositories) await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports cleanup failure instead of publishing a successful snapshot', async () => {
    const f = await fixture();
    const r = runtime(f, { fsImpl: { ...fs, rename: async (from, to) => {
      if (path.basename(from).startsWith('openchamber-pr-git_')) throw Object.assign(new Error('Fixture cleanup failure'), { code: 'EACCES' });
      return fs.rename(from, to);
    } } });
    await expect(r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 }))
      .rejects.toMatchObject({ code: 'UNKNOWN', message: 'Pull request temporary repository cleanup failed' });
    const stored = JSON.parse(await fs.readFile(r.operationFile, 'utf8'));
    expect(Object.values(stored.records).every(record => record.snapshot.state === 'failed')).toBe(true);
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.source.headSha);
  });

  it('never includes a partially written patch in an operation error', async () => {
    const f = await fixture();
    const r = runtime(f, { intercept: (binary, args, options) => args.includes('--full-index')
      ? spawn(process.execPath, ['-e', 'process.stdout.write("private-patch-material"); process.exit(1)'], options) : undefined });
    await expect(r.service.readPullRequestSnapshot({ context: f.source.context, repo: f.source.repo, number: 7 }))
      .rejects.toMatchObject({ code: 'UNKNOWN', message: 'Pull request diff could not be read' });
    expect(await fs.readFile(r.operationFile, 'utf8')).not.toContain('private-patch-material');
    expect(await fs.readFile(r.auditFile, 'utf8')).not.toContain('private-patch-material');
  });

  it('does not expose snapshot planning to the public Git operation input', async () => {
    const f = await fixture();
    const r = runtime(f);
    await expect(r.service.plan({ operation: 'pr-snapshot', directory: f.directory }))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    expect(r.calls).toHaveLength(0);
    expect(r.resolve).not.toHaveBeenCalled();
  });
});
