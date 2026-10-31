import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pr-diff-routes-'));
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const repo = { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' };
const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
const file = (number) => ({ filename: `file-${number}.txt`, status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+new\n' });

describe('PR context diff fallback', () => {
  let accountId, app, routes, number = 10;
  let total, refusal, failedPage;
  const readSnapshot = vi.fn(async () => ({ patch, files: Array.from({ length: total }, (_, index) => file(index)) }));
  const context = () => ({ provider: 'github', instance: 'github.com', directory: '/fixture', accountId,
    repositoryId: 'repo', bindingRevision: '1', primaryRemote: 'origin' });
  const read = (diff = true) => request(app).get('/api/source-control/github/pulls/context')
    .query({ ...context(), number, diff: diff ? '1' : '0' });
  const serve = () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input);
      calls.push(url);
      if (/\/pulls\/\d+$/.test(url.pathname)) {
        if (new Headers(init.headers).get('accept')?.includes('.diff')) {
          if (refusal) return Response.json({ message: 'Diff too large', errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }] }, { status: refusal });
          return new Response(patch, { headers: { 'content-type': 'text/plain' } });
        }
        return Response.json({ number, title: 'Large PR', html_url: `${repo.url}/pull/${number}`, state: 'open', user: null,
          head: { sha: headSha, ref: 'feature', repo: null }, base: { sha: baseSha, ref: 'main' }, changed_files: total });
      }
      if (url.pathname.endsWith('/files')) {
        const page = Number(url.searchParams.get('page'));
        if (page === failedPage) return Response.json({ message: 'Page unavailable' }, { status: 503 });
        return Response.json(Array.from({ length: Math.max(0, Math.min(100, total - (page - 1) * 100)) }, (_, index) => file((page - 1) * 100 + index)));
      }
      if (url.pathname.endsWith('/comments')) return Response.json([]);
      if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] });
      if (url.pathname.endsWith('/status')) return Response.json({ statuses: [] });
      if (url.pathname.includes('/compare/')) return Response.json({ merge_base_commit: { sha: baseSha } });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    }));
    return calls;
  };
  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fixture-token', user: { id: 7, login: 'tester' } }));
    app = express();
    routes = registerGitHubRoutes(app, {
      validateReadContext: async input => ({ ...input, bindingRevision: 1 }),
      resolveGitHubRepoFromDirectory: async () => ({ repo }),
      resolveRepoNetwork: async () => [{ ...repo, source: 'origin' }],
      readPullRequestSnapshot: readSnapshot,
    });
  });
  beforeEach(() => { number += 1; total = 301; refusal = 422; failedPage = 0; });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('returns the entire local diff and file list without fetching API file pages', async () => {
    const calls = serve();
    const { body } = await read().expect(200);
    expect(body.diff).toBe(patch);
    expect(body.files).toHaveLength(301);
    expect(calls.some(url => url.pathname.endsWith('/files'))).toBe(false);
    expect(readSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ accountId, repositoryId: 'repo', primaryRemote: 'origin' }),
      repo: { owner: 'acme', repo: 'app' }, number, expectedHeadSha: headSha, expectedBaseSha: baseSha, signal: expect.any(AbortSignal),
    }));
  });

  it('supports more than 3,000 files even when only context is requested', async () => {
    total = 3001;
    const calls = serve();
    const { body } = await read(false).expect(200);
    expect(body.files).toHaveLength(3001);
    expect(body.diff).toBeUndefined();
    expect(calls.some(url => url.pathname.endsWith('/files'))).toBe(false);
    expect(readSnapshot).toHaveBeenCalledOnce();
  });

  it('paginates the native context files beyond its old 100-file limit', async () => {
    refusal = 0; total = 201;
    const calls = serve();
    const { body } = await read().expect(200);
    expect(body.files).toHaveLength(201);
    expect(calls.filter(url => url.pathname.endsWith('/files')).map(url => url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('does not publish a successful partial file list when a later page fails', async () => {
    refusal = 0; total = 201; failedPage = 2;
    serve();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { body } = await read().expect(500);
      expect(body.files).toBeUndefined();
      expect(readSnapshot).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('refuses out-of-network snapshot sources before a provider read', async () => {
    const calls = serve();
    await expect(routes.resolvePullRequestSnapshotSource({ context: context(), repo: { owner: 'other', repo: 'private' }, number }))
      .rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  it('resolves immutable snapshot coordinates from the bound account', async () => {
    serve();
    await expect(routes.resolvePullRequestSnapshotSource({ context: context(), repo, number, expectedHeadSha: headSha }))
      .resolves.toMatchObject({ context: expect.objectContaining({ accountId }), headSha, baseSha, mergeBaseSha: baseSha, endpoint: 'https://github.com/acme/app.git' });
  });
});
