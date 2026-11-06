import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HEAD = 'a'.repeat(40);
const endpoint = '/api/source-control/github/pr/review/pending';
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
let directory, previousDataDirectory, app, store, account, context, state, writes, validateRead, validateWrite;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-pending-route-'));
  previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  const auth = await import('../github/auth.js');
  await auth.setGhCliDisabled(true);
  account = await auth.setGitHubAuth({ accessToken: 'fixture-token', user: { id: 1, login: 'reviewer' } });
  const { createMutationStore } = await import('./mutation-storage.js');
  const { createMutationExecutor } = await import('./mutation-executor.js');
  const { registerGitHubRoutes } = await import('./provider-routes.github.test-support.js');
  store = createMutationStore({ filePath: path.join(directory, 'mutations.json') });
  context = { directory: '/repo', provider: 'github', instance: 'github.com', repositoryId: 'repo-one',
    bindingRevision: 3, accountId: account.accountId, primaryRemote: 'origin' };
  validateRead = vi.fn(async (input) => input);
  validateWrite = vi.fn(async (input) => input);
  app = express();
  app.use(express.json());
  registerGitHubRoutes(app, {
    validateReadContext: validateRead, validateMutationContext: validateWrite,
    mutationExecutor: createMutationExecutor({ store }),
    resolveGitHubRepoFromDirectory: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
    resolveRepoNetwork: async () => null,
  });
  state = { pending: true, ownPull: false, head: HEAD, reviewHead: HEAD, commentBody: 'Keep this comment', readFailure: false, lostWrite: false };
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (options.method === 'GET') return Response.json({
      number: 7, title: 'Title', html_url: 'https://github.com/acme/app/pull/7', state: 'open', node_id: 'PR1', draft: false, merged: false,
      base: { ref: 'main', repo: { owner: { login: 'acme' }, name: 'app', html_url: 'https://github.com/acme/app' } },
      head: { ref: 'feature', sha: state.head, repo: null },
    });
    const { query, variables } = JSON.parse(options.body);
    if (query.startsWith('mutation')) {
      const name = /\{\s+(\w+)\(input:/.exec(query)[1];
      writes.push({ name, input: variables.input });
      if (state.lostWrite) throw new Error('Fixture response lost');
      return Response.json({ data: { [name]: { clientMutationId: variables.input.clientMutationId } } });
    }
    if (state.readFailure) return Response.json({ errors: [{ message: 'Fixture provider failure' }] });
    if (query.includes('query PendingReviewComments(')) return Response.json({ data: { node: {
      id: 'REVIEW1', state: 'PENDING', author: { databaseId: 1 }, pullRequest: { id: 'PR1' },
      comments: page([{ id: 'COMMENT1', body: state.commentBody, path: 'src/a.ts', author: { databaseId: 1 }, pullRequestReview: { id: 'REVIEW1' } }]),
    } } });
    if (query.includes('query PendingReviewThreads(')) return Response.json({ data: { node: { id: 'PR1', reviewThreads: page([{
      id: 'THREAD1', path: 'src/a.ts', diffSide: 'RIGHT', line: 5, startLine: null, originalLine: 5, originalStartLine: null,
      isOutdated: false, comments: page([{ id: 'COMMENT1' }]),
    }]) } } });
    return Response.json({ data: { viewer: { databaseId: 1 }, repository: { pullRequest: {
      id: 'PR1', number: 7, state: 'OPEN', headRefOid: state.head, author: { databaseId: state.ownPull ? 1 : 2 },
      reviews: page(state.pending ? [{ id: 'REVIEW1', body: '', state: 'PENDING', author: { databaseId: 1 }, commit: { oid: state.reviewHead } }] : []),
    } } } });
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  await fs.rm(directory, { recursive: true, force: true });
});

const read = () => request(app).get(endpoint).query({ ...context, owner: 'acme', repo: 'app', number: 7 });
const send = (action, overrides = {}) => request(app).post(endpoint).send({ ...context, idempotencyKey: 'request-one',
  target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: HEAD }, action, ...overrides });

describe('versioned GitHub pending reviews through the production route shell', () => {
  it('reads the existing draft and its line locations without caching', async () => {
    const result = await read().expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({ headSha: HEAD, open: true, ownPull: false, review: {
      id: 'REVIEW1', version: expect.any(String), comments: [{ id: 'COMMENT1', body: 'Keep this comment', path: 'src/a.ts', side: 'RIGHT', line: 5 }],
    } });
    expect(validateRead).toHaveBeenCalledWith(context);
    expect(writes).toEqual([]);
  });

  it('submits the displayed draft once and replays its receipt without another write', async () => {
    const { review } = (await read().expect(200)).body;
    const action = { kind: 'submit', reviewId: review.id, version: review.version, verdict: 'approve' };
    const first = await send(action).expect(200);
    const second = await send(action).expect(200);
    expect(first.body).toMatchObject({ status: 'succeeded', result: {}, replayed: false });
    expect(second.body).toMatchObject({ status: 'succeeded', result: {}, replayed: true });
    expect(writes).toEqual([{ name: 'submitPullRequestReview', input: {
      pullRequestReviewId: 'REVIEW1', event: 'APPROVE', clientMutationId: 'request-one',
    } }]);
    expect(await store.read('request-one')).toMatchObject({ kind: 'change-request-pending-review', state: 'succeeded' });
  });

  it('reports an authoritative empty draft so approval can be enabled', async () => {
    state.pending = false;
    expect((await read().expect(200)).body).toEqual({ headSha: HEAD, open: true, ownPull: false, review: null });
  });

  it('keeps provider read failures distinct from an empty review and supports retry', async () => {
    state.readFailure = true;
    const failed = await read().expect(502);
    expect(failed.body.error).toBe('Could not load the pending review');
    expect(failed.body).not.toHaveProperty('review');
    state.readFailure = false;
    expect((await read().expect(200)).body.review.comments).toHaveLength(1);
  });

  it('validates binding authority before any provider read or mutation', async () => {
    const stale = Object.assign(new Error('Binding changed'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    validateRead.mockRejectedValueOnce(stale);
    await read().expect(409);
    validateWrite.mockRejectedValueOnce(stale);
    await send({ kind: 'discard', reviewId: 'REVIEW1', version: 'old' }).expect(409);
    expect(fetch).not.toHaveBeenCalled();
    expect(await store.read('request-one')).toBeNull();
  });

  it('refuses an unavailable exact account without falling back to the current account', async () => {
    context.accountId = 'missing-account';
    await read().expect(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a foreign repository before reading or changing its draft', async () => {
    await request(app).get(endpoint).query({ ...context, owner: 'foreign', repo: 'app', number: 7 }).expect(409);
    await send({ kind: 'discard', reviewId: 'REVIEW1', version: 'old' }, {
      target: { project: { owner: 'foreign', name: 'app' }, number: 7, headSha: HEAD },
    }).expect(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts an atomic review at the displayed commit through the migrated mutation route', async () => {
    state.pending = false;
    await send({ kind: 'comment', path: 'src/a.ts', side: 'LEFT', startLine: 2, line: 4, body: 'Check the removal' }).expect(200);
    expect(writes).toEqual([{ name: 'addPullRequestReview', input: {
      pullRequestId: 'PR1', commitOID: HEAD, clientMutationId: 'request-one',
      threads: [{ body: 'Check the removal', path: 'src/a.ts', side: 'LEFT', startSide: 'LEFT', startLine: 2, line: 4 }],
    } }]);
    expect(await fs.readFile(path.join(directory, 'mutations.json'), 'utf8')).not.toContain('Check the removal');
  });

  it.each([
    ['edit', 'updatePullRequestReviewComment', { commentId: 'COMMENT1', body: 'Updated' }],
    ['delete', 'deletePullRequestReviewComment', { commentId: 'COMMENT1' }],
    ['discard', 'deletePullRequestReview', {}],
    ['submit', 'submitPullRequestReview', { verdict: 'request-changes', body: 'Fix the branch' }],
  ])('performs a version-checked %s with one provider write', async (kind, name, input) => {
    const { review } = (await read().expect(200)).body;
    await send({ kind, reviewId: review.id, version: review.version, ...input }).expect(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].name).toBe(name);
  });

  it('refuses a changed draft or head before claiming a write', async () => {
    const { review } = (await read().expect(200)).body;
    const action = { kind: 'submit', reviewId: review.id, version: review.version, verdict: 'approve' };
    state.commentBody = 'Changed on GitHub';
    await send(action).expect(409);
    state.head = 'b'.repeat(40);
    await send(action).expect(409);
    expect(writes).toEqual([]);
    expect(await store.read('request-one')).toBeNull();
  });

  it('refuses approval of an older draft but still publishes its comments', async () => {
    state.reviewHead = 'b'.repeat(40);
    const { review } = (await read().expect(200)).body;
    const action = { kind: 'submit', reviewId: review.id, version: review.version, verdict: 'approve' };
    await send(action).expect(409);
    expect(await store.read('request-one')).toBeNull();
    await send({ ...action, verdict: 'comment' }).expect(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].input.event).toBe('COMMENT');
  });

  it('refuses own-PR approval while allowing a comment-only submission', async () => {
    state.ownPull = true;
    const { review } = (await read().expect(200)).body;
    const action = { kind: 'submit', reviewId: review.id, version: review.version, verdict: 'approve' };
    await send(action).expect(422);
    await send({ ...action, verdict: 'comment' }).expect(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].input.event).toBe('COMMENT');
  });

  it('retains a lost write as unknown and never dispatches it again', async () => {
    const { review } = (await read().expect(200)).body;
    state.lostWrite = true;
    const action = { kind: 'submit', reviewId: review.id, version: review.version, verdict: 'approve' };
    await send(action).expect(409);
    await send(action).expect(409);
    expect(writes).toHaveLength(1);
    expect(await store.read('request-one')).toMatchObject({ state: 'outcome-unknown' });
  });
});
