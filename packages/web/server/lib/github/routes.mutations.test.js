import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';

let auth;
let registerGitHubRoutes;

const makeStore = (initial = []) => {
  const records = new Map(initial.map((record) => [record.key, record]));
  return {
    records,
    withExecutionLock: async (_key, operation) => operation(),
    async read(key) {
      return records.get(key) ?? null;
    },
    async claim(record) {
      const existing = records.get(record.key);
      if (existing) return existing.inputDigest === record.inputDigest
        ? { status: 'existing', record: existing }
        : { status: 'conflict', record: existing };
      const running = { ...record, state: 'running' };
      records.set(record.key, running);
      return { status: 'claimed', record: running };
    },
    async complete(key, inputDigest, completion) {
      const existing = records.get(key);
      if (!existing || existing.inputDigest !== inputDigest || existing.state !== 'running') throw new Error('conflict');
      const completed = { ...existing, ...completion };
      records.set(key, completed);
      return completed;
    },
  };
};

const pullRequest = (overrides = {}) => ({
  number: 7,
  title: 'Title',
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  draft: true,
  merged: false,
  merged_at: null,
  node_id: 'PR_node',
  user: { id: 1, login: 'author' },
  base: {
    ref: 'main',
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
    },
  },
  head: {
    ref: 'feature',
    sha: 'abc123',
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
      clone_url: 'https://github.com/acme/app.git',
      ssh_url: 'git@github.com:acme/app.git',
    },
  },
  ...overrides,
});

const context = (accountId, overrides = {}) => ({
  provider: 'github',
  instance: 'github.com',
  directory: '/repo',
  repositoryId: 'repo-one',
  accountId,
  bindingRevision: 3,
  primaryRemote: 'origin',
  idempotencyKey: 'request-one',
  target: { project: { owner: 'acme', name: 'app' }, head: 'feature', base: 'main' },
  ...overrides,
});
const credentialFor = (account) => ({
  accountId: account.accountId,
  credentialRevision: account.credentialRevision,
});

const jsonResponse = (value, status = 200) => Response.json(value, { status });

const servePendingReview = ({ loseResponse = false } = {}) => {
  const headSha = 'a'.repeat(40);
  let review = null;
  const comments = [];
  const writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/repos/acme/app/pulls/7') return jsonResponse(pullRequest({ user: { id: 8, login: 'author' }, head: { ...pullRequest().head, sha: headSha } }));
    if (url.pathname !== '/graphql') throw new Error(`Unexpected request: ${url.pathname}`);
    const { query, variables } = JSON.parse(init.body);
    const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    if (query.includes('query PendingReviewComments(')) return jsonResponse({ data: { node: {
      ...review, pullRequest: { id: 'PR_node' }, comments: page(comments.map(comment => ({
        id: comment.node_id, body: comment.body, path: comment.path, author: { databaseId: comment.user.id }, pullRequestReview: { id: review.id },
      }))),
    } } });
    if (query.includes('query PendingReviewThreads(')) return jsonResponse({ data: { node: {
      id: 'PR_node', reviewThreads: page(comments.map(comment => ({
        id: `THREAD_${comment.node_id}`, path: comment.path, diffSide: comment.side,
        line: comment.line, startLine: comment.start_line, originalLine: comment.original_line,
        originalStartLine: comment.original_start_line, isOutdated: false, comments: page([{ id: comment.node_id }]),
      }))),
    } } });
    if (!variables.input) return jsonResponse({ data: { viewer: { databaseId: 7 }, repository: { pullRequest: {
      id: 'PR_node', number: 7, state: 'OPEN', headRefOid: headSha, author: { databaseId: 8 },
      reviews: { nodes: review ? [review] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } });
    const name = /\{\s+(\w+)\(input:/.exec(query)[1];
    writes.push({ name, input: variables.input });
    if (name === 'addPullRequestReview' || name === 'addPullRequestReviewThread') {
      review ??= { id: 'REVIEW_node', databaseId: 9, body: '', state: 'PENDING', author: { databaseId: 7 }, commit: { oid: headSha } };
      const thread = name === 'addPullRequestReview' ? variables.input.threads[0] : variables.input;
      comments.push({ node_id: `COMMENT_${comments.length + 1}`, pull_request_review_id: 9, body: thread.body, path: thread.path,
        side: thread.side, line: thread.line, original_line: thread.line, start_line: thread.startLine ?? null, original_start_line: thread.startLine ?? null, user: { id: 7 } });
    }
    if (name === 'submitPullRequestReview') review = null;
    if (loseResponse && writes.length === 1) throw new Error('Response lost after dispatch');
    return jsonResponse({ data: { [name]: { clientMutationId: variables.input.clientMutationId } } });
  }));
  return { headSha, writes, comments };
};

const forceMergeHead = 'a'.repeat(40);
const forceMergeBody = (accountId, extra = {}) => ({
  ...context(accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: forceMergeHead } }),
  method: 'squash', force: true, ...extra,
});
const serveForceMerge = () => {
  const state = {
    node: { __typename: 'PullRequest', id: 'PR_node', number: 7, state: 'OPEN', isDraft: false,
      mergeable: 'MERGEABLE', viewerCanMergeAsAdmin: true, headRefOid: forceMergeHead, headRefName: 'feature', baseRefName: 'main',
      repository: { name: 'app', owner: { login: 'acme' } } },
    result: { mergePullRequest: { pullRequest: { id: 'PR_node', merged: true } } },
    queryFailure: false, queryStatus: null, mutationFailure: null, waitForMerge: null,
    reads: [], writes: [], credentials: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(input);
    state.credentials.push(new Headers(init.headers).get('authorization'));
    if (url.pathname === '/repos/acme/app/pulls/7') {
      state.reads.push('rest');
      return jsonResponse(pullRequest({ draft: false, head: { ...pullRequest().head, sha: forceMergeHead } }));
    }
    if (url.pathname === '/repos/acme/app/pulls/7/merge') {
      state.writes.push(JSON.parse(init.body));
      return jsonResponse({ merged: true });
    }
    if (url.pathname !== '/graphql') throw new Error(`Unexpected fixture request ${url.pathname}`);
    const body = JSON.parse(init.body);
    if (body.query.startsWith('query ForceMergeTarget')) {
      state.reads.push('graphql');
      if (state.queryFailure) throw new Error('Fixture permission query disconnected');
      if (state.queryStatus) return jsonResponse({ message: 'Fixture permission query refused' }, state.queryStatus);
      return jsonResponse({ data: { node: state.node } });
    }
    state.writes.push(body);
    if (state.waitForMerge) await state.waitForMerge;
    if (state.mutationFailure === 'network') throw new Error('Fixture merge response lost');
    if (state.mutationFailure === 'refused') return jsonResponse({ errors: [{ message: 'Branch rules prohibit administrator merge', type: 'UNPROCESSABLE' }], data: { mergePullRequest: null } });
    if (state.mutationFailure === 'null-bubbling') return jsonResponse({ errors: [{ message: 'A response field failed', type: 'INTERNAL' }], data: { mergePullRequest: null } });
    if (state.mutationFailure === 'partial') return jsonResponse({ errors: [{ message: 'A response field failed' }], data: state.result });
    return jsonResponse({ data: state.result });
  }));
  return state;
};

const makeApp = ({ store = makeStore(), validateMutationContext, resolveRepo, resolveNetwork, resolveStatus } = {}) => {
  const app = express();
  app.use(express.json());
  const routeOptions = {
    validateReadContext: async (input) => input,
    validateMutationContext: validateMutationContext ?? (async (body) => ({ ...body, target: { ...body.target, project: { ...body.target.project } } })),
    mutationExecutor: createMutationExecutor({ store }),
    resolveGitHubRepoFromDirectory: resolveRepo ?? (async (_directory, remote) => ({
      repo: remote === 'upstream' ? { owner: 'upstream', repo: 'app' } : { owner: 'acme', repo: 'app' },
    })),
    resolveRepoNetwork: resolveNetwork ?? (async () => null),
  };
  if (resolveStatus) routeOptions.resolveGitHubPrStatus = resolveStatus;
  registerGitHubRoutes(app, routeOptions);
  return { app, store };
};

let directory;
let previousDataDirectory;

describe('pending review routes', () => {
  it('returns a failed read for GitHub GraphQL errors carried by HTTP 200', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'review-token', user: { id: 7, login: 'reviewer' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ errors: [{ message: 'Unavailable', type: 'FORBIDDEN' }] })));
    const { app } = makeApp();
    const read = await request(app).get('/api/source-control/github/pr/review/pending')
      .query({ ...context(account.accountId), owner: 'acme', repo: 'app', number: 7 }).expect(502);
    expect(read.body.error).toBe('Could not load the pending review');
    expect(read.body).not.toHaveProperty('review');
  });

  it('starts one private review, adds comments, and publishes one changes-requested verdict', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'review-token', user: { id: 7, login: 'reviewer' } });
    const fake = servePendingReview();
    const { app } = makeApp();
    const base = context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: fake.headSha } });
    const first = { ...base, action: { kind: 'comment', path: 'a.ts', side: 'RIGHT', line: 3, body: 'private review note' } };
    await request(app).post('/api/source-control/github/pr/review/pending').send(first).expect(200);
    await request(app).post('/api/source-control/github/pr/review/pending').send(first).expect(200);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].input.event).toBeUndefined();
    await request(app).post('/api/source-control/github/pr/review/pending').send({ ...base, idempotencyKey: 'second-note',
      action: { kind: 'comment', reviewId: 'REVIEW_node', path: 'b.ts', side: 'LEFT', line: 6, body: 'second private note' } }).expect(200);
    const read = await request(app).get('/api/source-control/github/pr/review/pending')
      .query({ ...context(account.accountId), owner: 'acme', repo: 'app', number: 7 }).expect(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body.review.comments).toHaveLength(2);
    await request(app).post('/api/source-control/github/pr/review/pending').send({ ...base, idempotencyKey: 'submit-review',
      action: { kind: 'submit', reviewId: 'REVIEW_node', version: read.body.review.version, verdict: 'request-changes', body: 'Please address both notes' } }).expect(200);
    expect(fake.writes.map(write => write.name)).toEqual(['addPullRequestReview', 'addPullRequestReviewThread', 'submitPullRequestReview']);
    expect(fake.writes[2].input.event).toBe('REQUEST_CHANGES');
  });

  it('keeps a lost-response write uncertain instead of posting the note twice', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'review-token', user: { id: 7, login: 'reviewer' } });
    const fake = servePendingReview({ loseResponse: true });
    const { createMutationStore } = await import('../source-control/mutation-storage.js');
    const filePath = path.join(directory, 'pending-review-mutations.json');
    const { app } = makeApp({ store: createMutationStore({ filePath }) });
    const payload = { ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: fake.headSha } }),
      action: { kind: 'comment', path: 'a.ts', side: 'RIGHT', line: 3, body: 'private review note' } };
    await request(app).post('/api/source-control/github/pr/review/pending').send(payload).expect(409);
    await request(app).post('/api/source-control/github/pr/review/pending').send(payload).expect(409);
    expect(fake.writes).toHaveLength(1);
    expect(fake.comments).toHaveLength(1);
    const persisted = await fs.readFile(filePath, 'utf8');
    expect(persisted).toContain('change-request-pending-review');
    expect(persisted).not.toContain('private review note');
    expect(persisted).not.toContain('review-token');
  });
});

beforeEach(async () => {
  // The auth store resolves its directory at import, so the isolated data
  // directory must be in place before the module loads — otherwise fixture
  // accounts land in the person's real store.
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-github-mutations-'));
  previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('./auth.js');
  ({ registerGitHubRoutes } = await import('./routes.js'));
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('canonical GitHub mutations', () => {
  it('fails closed without canonical mutation dependencies', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {
      resolveGitHubRepoFromDirectory: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
    });

    const canonical = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(501);
    expect(canonical.body.code).toBe('SOURCE_CONTROL_MUTATION_UNAVAILABLE');
  });

  it.each([
    ['busy lock', Object.assign(new Error('Stop all writers before stale-lock cleanup'), { status: 503, code: 'SOURCE_CONTROL_LOCK_BUSY' })],
    ['failed lock', Object.assign(new Error('Stop all writers before stale-lock cleanup'), { status: 500, code: 'SOURCE_CONTROL_LOCK_FAILED' })],
    ['missing account', Object.assign(new Error('accountId is required'), { status: 400, code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' })],
    ['stale binding', Object.assign(new Error('Source control repository binding changed'), {
      status: 409,
      code: 'SOURCE_CONTROL_BINDING_STALE',
      current: { repositoryId: 'repo-two', bindingRevision: 4 },
    })],
  ])('rejects %s before credentials, repository resolution, or provider work', async (_label, validationError) => {
    const resolveRepo = vi.fn();
    const resolveNetwork = vi.fn();
    const validateMutationContext = vi.fn(async () => { throw validationError; });
    const { app } = makeApp({ validateMutationContext, resolveRepo, resolveNetwork });
    const response = await request(app).post('/api/source-control/github/pr/create').send({ title: 'private' });

    expect(response.status).toBe(validationError.status);
    expect(response.body.code).toBe(validationError.code);
    expect(response.body.error).toBe(validationError.message);
    if (validationError.current) expect(response.body.current).toEqual(validationError.current);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('rejects targets outside the strict fork network before mutation', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveNetwork = vi.fn(async () => [
      { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      { owner: 'upstream', repo: 'app', url: 'https://github.com/upstream/app', source: 'upstream' },
    ]);
    const { app } = makeApp({ resolveNetwork });
    const payload = context(account.accountId, { target: { project: { owner: 'other', name: 'app' }, head: 'feature', base: 'main' } });

    const response = await request(app).post('/api/source-control/github/pr/create').send({ ...payload, title: 'Title' }).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveNetwork).toHaveBeenCalledOnce();
  });

  it('fails once on ambiguous fork metadata without provider mutation retry', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveNetwork = vi.fn(async () => [
      { owner: 'upstream', repo: 'app', url: 'https://github.com/upstream/app', source: 'upstream' },
    ]);
    const { app } = makeApp({ resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(500);
    expect(response.body.code).toBe('MALFORMED_PROVIDER_RESPONSE');
    expect(resolveNetwork).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a changed explicit remote and an arbitrary source remote', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    vi.stubGlobal('fetch', vi.fn());
    const resolveRepo = async (_directory, remote) => ({
      repo: remote === 'changed' ? { owner: 'other', repo: 'app' }
        : remote === 'source' ? { owner: 'attacker', repo: 'app' }
          : { owner: 'acme', repo: 'app' },
    });
    const { app } = makeApp({ resolveRepo });
    const payload = { ...context(account.accountId), title: 'Title' };

    await request(app).post('/api/source-control/github/pr/create').send({ ...payload, remote: 'changed' }).expect(409);
    await request(app).post('/api/source-control/github/pr/create').send({ ...payload, idempotencyKey: 'two', headRemote: 'source' }).expect(409);
  });

  it('uses the validated actor even after another account becomes active', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'active' } });
    const fetch = vi.fn(async (_url, options) => {
      expect(options.headers.authorization).toBe('token token-one');
      return jsonResponse(pullRequest());
    });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);
    expect(response.body).toEqual({
      status: 'succeeded',
      actor: { provider: 'github', instance: 'github.com', providerAccountId: acting.providerUserId },
      target: {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main', number: 7,
      },
      replayed: false,
      result: {},
    });
  });

  it('records the created pull request number and names it in replayed receipts', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pullRequest())));
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };

    const created = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(created.body).toMatchObject({ target: { number: 7 }, result: {} });
    expect(store.records.get('request-one')).toMatchObject({ state: 'succeeded', result: { number: 7 } });

    const replay = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(replay.body).toMatchObject({ replayed: true, target: { number: 7 }, result: {} });
  });

  it('keeps credential authority in replay input while deriving one provider actor for sibling credentials', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const second = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 1, login: 'renamed' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pullRequest())));
    const { app, store } = makeApp();

    const firstResponse = await request(app).post('/api/source-control/github/pr/create').send({
      ...context(first.accountId), idempotencyKey: 'first', title: 'Title', providerUserId: 'github.com#999',
    }).expect(200);
    const secondResponse = await request(app).post('/api/source-control/github/pr/create').send({
      ...context(second.accountId), idempotencyKey: 'second', title: 'Title', providerUserId: 'github.com#999',
    }).expect(200);

    expect(firstResponse.body.actor).toEqual({ provider: 'github', instance: 'github.com', providerAccountId: 'github.com#1' });
    expect(secondResponse.body.actor).toEqual(firstResponse.body.actor);
    expect(store.records.get('first').actor.accountId).toBe(first.accountId);
    expect(store.records.get('second').actor.accountId).toBe(second.accountId);
    expect(store.records.get('first').inputDigest).not.toBe(store.records.get('second').inputDigest);
  });

  it('joins duplicate keys, replays completion, and conflicts on changed normalized input', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse(pullRequest());
    });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };

    const [owner, duplicate] = await Promise.all([
      request(app).post('/api/source-control/github/pr/create').send(payload),
      request(app).post('/api/source-control/github/pr/create').send(payload),
    ]);
    expect([owner.body.replayed, duplicate.body.replayed].sort()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledOnce();

    const replay = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();

    const conflict = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...payload, title: 'Changed' }).expect(409);
    expect(conflict.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([500, 502, 504])('records a provider %i after dispatch as outcome-unknown and never repeats it', async (status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse({ message: 'provider unavailable' }, status));
    vi.stubGlobal('fetch', fetch);
    const resolveRepo = vi.fn(async () => ({ repo: { owner: 'acme', repo: 'app' } }));
    const resolveNetwork = vi.fn(async () => null);
    const { app, store } = makeApp({ resolveRepo, resolveNetwork });
    const payload = { ...context(account.accountId), title: 'Title' };

    const initial = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(initial.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(store.records.get('request-one')).toMatchObject({ state: 'outcome-unknown' });

    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveRepo).toHaveBeenCalledTimes(2);
    expect(resolveNetwork).toHaveBeenCalledOnce();
  });

  it('records a statusless socket failure after dispatch as outcome-unknown', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };

    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(store.records.get('request-one')).toMatchObject({ state: 'outcome-unknown' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['succeeded', {}, 200, 'succeeded'],
    ['failed', { failureStatus: 422, failureCode: 'GITHUB_MUTATION_REJECTED' }, 422, 'GITHUB_MUTATION_REJECTED'],
    ['outcome-unknown', undefined, 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
  ])('replays a terminal %s record without repository, fork-network, PR, or provider access', async (state, result, status, expected) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' };
    const record = {
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-create', actor, target, state,
    };
    if (result !== undefined) record.result = result;
    const resolveRepo = vi.fn(async () => { throw new Error('repository unavailable'); });
    const resolveNetwork = vi.fn(async () => { throw new Error('network unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('provider unavailable'); });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(status);
    expect(status === 200 ? response.body.status : response.body.code).toBe(expected);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('conflicts on stored binding authority before provider preflight', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-other', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn();
    const resolveNetwork = vi.fn();
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('replays a succeeded record despite changed provider repository state', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn(async () => ({ repo: { owner: 'moved', repo: 'elsewhere' } }));
    const resolveNetwork = vi.fn(async () => [{ owner: 'moved', repo: 'elsewhere', source: 'origin' }]);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(200);
    expect(response.body).toMatchObject({ status: 'succeeded', replayed: true, result: {} });
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('replays when the stored target has provider metadata omitted by the request', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' },
      number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'update', actor, credential: credentialFor(account), target, title: 'Updated' }),
      kind: 'change-request-update', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn(async () => { throw new Error('repository unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('provider unavailable'); });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo });

    const response = await request(app).post('/api/source-control/github/pr/update').send({
      ...context(account.accountId, {
        target: { project: { owner: 'acme', name: 'app' }, number: 7 },
      }),
      title: 'Updated',
    }).expect(200);

    expect(response.body.replayed).toBe(true);
    expect(response.body.target).toEqual(target);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the exact local account before terminal replay', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const store = makeStore([record]);
    const read = vi.spyOn(store, 'read');
    await auth.removeGitHubAuthAccount(account.accountId);
    const { app } = makeApp({ store });

    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('revalidates an existing target once before update and performs one write without another lookup', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const methods = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      methods.push(options.method);
      return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
    }));
    const { app } = makeApp();
    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };

    const response = await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed', body: 'private body' }).expect(200);
    expect(response.body.result).toEqual({});
    expect(response.body.target).toMatchObject({ number: 7, head: 'feature', base: 'main', headSha: 'abc123' });
    expect(methods).toEqual(['GET', 'PATCH']);
  });

  it('binds merge to the exact head SHA validated before dispatch', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requests.push({ method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return options.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ merged: true, message: 'Pull Request successfully merged' });
    }));
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, {
        target: {
          project: { owner: 'acme', name: 'app' }, number: 7,
          head: 'feature', base: 'main', headSha: 'abc123',
        },
      }),
      method: 'merge',
    }).expect(200);

    expect(response.body.result).toEqual({ merged: true });
    expect(requests).toEqual([
      { method: 'GET', body: null },
      { method: 'PUT', body: { merge_method: 'merge', sha: 'abc123' } },
    ]);
  });

  it('performs administrator merge with the exact acting account, fresh node and expected head', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'another-actor' } });
    const fake = serveForceMerge();
    const { app } = makeApp();
    const response = await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId)).expect(200);
    expect(response.body.result).toEqual({ merged: true });
    expect(fake.reads).toEqual(['rest', 'graphql']);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({
      query: expect.stringContaining('mergePullRequest(input: $input)'),
      variables: { input: { pullRequestId: 'PR_node', mergeMethod: 'SQUASH', expectedHeadOid: forceMergeHead } },
    });
    expect(fake.credentials.every((value) => value === 'token token-one')).toBe(true);
  });

  it('replays a completed administrator merge after permissions and PR state change', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    const { app } = makeApp();
    const payload = forceMergeBody(account.accountId);
    await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(200);
    fake.node = { ...fake.node, viewerCanMergeAsAdmin: false, state: 'MERGED' };
    const replay = await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(200);
    expect(replay.body).toMatchObject({ replayed: true, result: { merged: true } });
    expect(fake.reads).toEqual(['rest', 'graphql']);
    expect(fake.writes).toHaveLength(1);
  });

  it('joins concurrent administrator merges with the same key instead of dispatching twice', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    let release;
    fake.waitForMerge = new Promise((resolve) => { release = resolve; });
    const { app } = makeApp();
    const payload = forceMergeBody(account.accountId);
    const first = request(app).post('/api/source-control/github/pr/merge').send(payload).then((response) => response);
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    const second = request(app).post('/api/source-control/github/pr/merge').send(payload).then((response) => response);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.reads.filter((kind) => kind === 'graphql')).toHaveLength(1);
  });

  it('reconciles an interrupted administrator merge after restart without checking later permissions or writing again', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const target = { repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: forceMergeHead };
    const store = makeStore([{ key: 'request-one', kind: 'change-request-merge', actor, target, state: 'running',
      inputDigest: digestMutationInput({ kind: 'merge', actor, credential: credentialFor(account), target, method: 'squash', force: true }) }]);
    const fetch = vi.fn(async () => jsonResponse(pullRequest({ draft: false, state: 'closed', merged: true,
      merged_at: '2026-01-01T00:00:00Z', head: { ...pullRequest().head, sha: forceMergeHead } })));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store });
    const response = await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId)).expect(200);
    expect(response.body).toMatchObject({ replayed: true, result: { merged: true } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('keeps omitted and false force on the original ordinary merge digest', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    const { app } = makeApp();
    const payload = forceMergeBody(account.accountId);
    delete payload.force;
    await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(200);
    const replay = await request(app).post('/api/source-control/github/pr/merge').send({ ...payload, force: false }).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(fake.writes).toEqual([{ merge_method: 'squash', sha: forceMergeHead }]);
    await request(app).post('/api/source-control/github/pr/merge').send({ ...payload, force: true }).expect(409);
    expect(fake.writes).toHaveLength(1);
  });

  it.each([null, 'true', 1, [], {}])('rejects an invalid force flag %o before provider access', async (force) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    const { app } = makeApp();
    await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId, { force })).expect(400);
    expect(fake.reads).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it.each([
    ['already merged', { viewerCanMergeAsAdmin: false, state: 'MERGED' }, 409],
    ['head changed during preflight', { headRefOid: 'b'.repeat(40) }, 409],
    ['draft', { isDraft: true }, 409],
    ['merge conflict', { mergeable: 'CONFLICTING' }, 409],
  ])('records %s as definitely not dispatched', async (_label, changed, status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    fake.node = { ...fake.node, ...changed };
    const { app, store } = makeApp();
    await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId)).expect(status);
    expect(store.records.get('request-one').state).toBe('failed');
    expect(fake.writes).toEqual([]);
  });

  it('records a failed permission query as unwritten and replays that failure without another query', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    fake.queryFailure = true;
    const { app, store } = makeApp();
    const payload = forceMergeBody(account.accountId);
    await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(502);
    await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(502);
    expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureCode: 'SOURCE_CONTROL_MUTATION_PRECHECK_FAILED' } });
    expect(fake.reads).toEqual(['rest', 'graphql']);
    expect(fake.writes).toEqual([]);
  });

  it.each([401, 403])('retains preflight %s and only invalidates the exact account on 401', async (status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const other = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'another-actor' } });
    const fake = serveForceMerge();
    fake.queryStatus = status;
    const { app, store } = makeApp();
    await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId)).expect(status);
    expect(store.records.get('request-one').state).toBe('failed');
    expect(fake.writes).toEqual([]);
    const accounts = await auth.getGitHubAuthAccounts();
    expect(accounts.find((entry) => entry.id === account.accountId).status).toBe(status === 401 ? 'invalid' : 'valid');
    expect(accounts.find((entry) => entry.id === other.accountId).status).toBe('valid');
  });

  it('reports an explicit administrator merge refusal as a definite rejection', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    fake.mutationFailure = 'refused';
    const { app, store } = makeApp();
    const response = await request(app).post('/api/source-control/github/pr/merge').send(forceMergeBody(account.accountId)).expect(422);
    expect(response.body).toMatchObject({ error: 'Branch rules prohibit administrator merge', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(store.records.get('request-one').state).toBe('failed');
    expect(fake.writes).toHaveLength(1);
  });

  it.each(['network', 'partial', 'invalid', 'null-bubbling'])('retains a %s administrator merge outcome without repeating dispatch', async (failure) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fake = serveForceMerge();
    fake.mutationFailure = failure;
    if (failure === 'invalid') fake.result = {};
    const { app, store } = makeApp();
    const payload = forceMergeBody(account.accountId);
    const response = await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(409);
    expect(store.records.get('request-one').state).toBe('outcome-unknown');
    expect(fake.writes).toHaveLength(1);
  });

  it.each([
    ['ready', { ready: true }, pullRequest({ draft: false })],
    ['merge', { merged: true }, pullRequest({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' })],
  ])('reconciles a running %s mutation from provider state without repeating the write', async (kind, result, providerState) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind, actor, credential: credentialFor(account), target };
    if (kind === 'merge') input.method = 'merge';
    const record = { key: 'request-one', inputDigest: digestMutationInput(input), kind: `change-request-${kind}`, actor, target, state: 'running' };
    const store = makeStore([record]);
    const fetch = vi.fn(async () => jsonResponse(providerState));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store });
    const body = context(account.accountId, {
      target: { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' },
    });

    if (kind === 'merge') body.method = 'merge';
    const response = await request(app).post(`/api/source-control/github/pr/${kind}`)
      .send(body).expect(200);
    expect(response.body).toMatchObject({ replayed: true, result });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it.each([
    ['one create match', [pullRequest()], 200, 'succeeded'],
    ['no create match', [], 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
    ['ambiguous create matches', [pullRequest(), pullRequest({ number: 8, html_url: 'https://github.com/acme/app/pull/8' })], 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
  ])('reconciles restart create with %s', async (_label, pulls, status, expected) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' };
    const store = makeStore([{
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-create', actor, target, state: 'running',
    }]);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pulls)));
    const { app } = makeApp({ store });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(status);
    expect(status === 200 ? response.body.status : response.body.code).toBe(expected);
    if (status === 200) expect(response.body.target.number).toBe(7);
  });

  describe('comments and reviews', () => {
    const pullTarget = { project: { owner: 'acme', name: 'app' }, number: 7 };
    const recordRequests = (respond) => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const entry = { method: options.method, path: new URL(String(url)).pathname, body: options.body ? JSON.parse(options.body) : null };
        requests.push(entry);
        return respond(entry);
      }));
      return requests;
    };

    it('comments on a pull request after checking it belongs to the bound repository', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse({ id: 11 }, 201)));
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/comment')
        .send({ ...context(account.accountId, { target: pullTarget }), body: 'Looks good' }).expect(200);

      expect(response.body.result).toEqual({});
      expect(requests).toEqual([
        { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
        { method: 'POST', path: '/repos/acme/app/issues/7/comments', body: { body: 'Looks good' } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-comment', state: 'succeeded' });
    });

    it('reviews the head commit the client read, with the text as the review body', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ id: 12, state: entry.body.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED' })));
      const { app } = makeApp();
      const target = { ...pullTarget, headSha: 'abc123' };

      const approved = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target }), verdict: 'approve' }).expect(200);
      const requested = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target, idempotencyKey: 'request-two' }), verdict: 'request-changes', body: 'Rename it' }).expect(200);

      expect(approved.body.result).toEqual({ commented: false });
      expect(requested.body.result).toEqual({ commented: true });
      expect(requests.filter((entry) => entry.method === 'POST')).toEqual([
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'APPROVE' } },
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'REQUEST_CHANGES', body: 'Rename it' } },
      ]);
    });

    it('refuses a review once the pull request moved past the commit the client read', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests(() => jsonResponse(pullRequest({ head: { ...pullRequest().head, sha: 'def456' } })));
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'approve' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_CHANGED');
      expect(requests.map((entry) => entry.method)).toEqual(['GET']);
    });

    it('asks for text before requesting changes and for the reviewed commit, and writes nothing', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests(() => jsonResponse(pullRequest()));
      const { app } = makeApp();

      await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'request-changes', body: '  ' }).expect(400);
      await request(app).post('/api/source-control/github/pr/comment')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }) }).expect(400);
      await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-three' }), verdict: 'approve' }).expect(400);

      expect(requests).toEqual([]);
    });

    const threadOn = (number, repo = 'app') => ({
      data: { node: { __typename: 'PullRequestReviewThread', isResolved: false, pullRequest: { number, repository: { name: repo, owner: { login: 'acme' } } } } },
    });

    it('answers and resolves a review thread of the target pull request', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'GET') return jsonResponse(pullRequest());
        const query = entry.body.query;
        if (query.includes('addPullRequestReviewThreadReply')) return jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1' } } } });
        if (query.includes('resolveReviewThread')) return jsonResponse({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        return jsonResponse(threadOn(7));
      });
      const { app, store } = makeApp();

      await request(app).post('/api/source-control/github/pr/thread/reply')
        .send({ ...context(account.accountId, { target: pullTarget }), threadId: 'PRRT_one', body: 'Fixed' }).expect(200);
      await request(app).post('/api/source-control/github/pr/thread/resolve')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), threadId: 'PRRT_one', resolved: true }).expect(200);

      const writes = requests.filter((entry) => entry.method === 'POST' && /mutation/.test(entry.body.query));
      expect(writes.map((entry) => entry.body.variables)).toEqual([{ threadId: 'PRRT_one', body: 'Fixed' }, { threadId: 'PRRT_one' }]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-thread-reply', state: 'succeeded' });
      expect(store.records.get('request-two')).toMatchObject({ kind: 'change-request-thread-resolve', state: 'succeeded' });
    });

    it('refuses a thread of another pull request and writes nothing', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(threadOn(8))));
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/thread/reply')
        .send({ ...context(account.accountId, { target: pullTarget }), threadId: 'PRRT_other', body: 'Fixed' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.some((entry) => entry.method === 'POST' && /mutation/.test(entry.body.query))).toBe(false);
    });

    it("passes GitHub's reason when it refuses a review", async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      recordRequests((entry) => (entry.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }, 422)));
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'approve' }).expect(422);

      expect(response.body).toEqual({ error: 'Review Can not approve your own pull request', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
      expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422 } });
    });

    it('comments on an issue and refuses a pull request number on the issue route', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'POST') return jsonResponse({ id: 13 }, 201);
        return entry.path.endsWith('/issues/8')
          ? jsonResponse({ number: 8, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' } })
          : jsonResponse({ number: 5 });
      });
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), body: 'On it' }).expect(200);
      const refused = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 8 }, idempotencyKey: 'request-two' }), body: 'On it' }).expect(409);

      expect(response.body.target).toEqual({
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      });
      expect(refused.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.filter((entry) => entry.method === 'POST')).toEqual([
        { method: 'POST', path: '/repos/acme/app/issues/5/comments', body: { body: 'On it' } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-comment', state: 'succeeded' });
    });

    it('closes a pull request and reopens an issue, and passes GitHub\'s reason for a merged one', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.path.endsWith('/pulls/7')) {
          return entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(pullRequest({ state: 'closed' }));
        }
        if (entry.path.endsWith('/pulls/9')) {
          return entry.method === 'GET'
            ? jsonResponse(pullRequest({ number: 9, html_url: 'https://github.com/acme/app/pull/9', state: 'closed', merged: true }))
            : jsonResponse({ message: 'Validation Failed', errors: [{ message: 'state cannot be changed. The pull request has been merged.' }] }, 422);
        }
        return entry.method === 'GET' ? jsonResponse({ number: 5, state: 'closed' }) : jsonResponse({ number: 5, state: 'open' });
      });
      const { app, store } = makeApp();

      const closed = await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: pullTarget }), state: 'closed' }).expect(200);
      const reopened = await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 }, idempotencyKey: 'request-two' }), state: 'open' }).expect(200);
      const merged = await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: { ...pullTarget, number: 9 }, idempotencyKey: 'request-three' }), state: 'open' }).expect(422);
      await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-four' }), state: 'merged' }).expect(400);

      expect(closed.body.result).toEqual({ state: 'closed' });
      expect(reopened.body.result).toEqual({ state: 'open' });
      expect(merged.body).toEqual({ error: 'state cannot be changed. The pull request has been merged.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
      expect(requests.filter((entry) => entry.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/repos/acme/app/pulls/7', body: { state: 'closed' } },
        { method: 'PATCH', path: '/repos/acme/app/issues/5', body: { state: 'open' } },
        { method: 'PATCH', path: '/repos/acme/app/pulls/9', body: { state: 'open' } },
      ]);
      expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-state', state: 'succeeded', result: { state: 'open' } });
    });

    it.each([
      ['closed', 'succeeded'],
      ['open', 'failed'],
    ])('reconciles an interrupted close from the issue being %s without writing again', async (current, outcome) => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-state', actor, credential: credentialFor(account), target, state: 'closed' };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-state', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({ number: 5, state: current }));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), state: 'closed' })
        .expect(outcome === 'succeeded' ? 200 : 409);

      expect(store.records.get('request-one').state).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('sets labels as one sorted set on pull requests and issues', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'PUT') return jsonResponse(entry.body.labels.map((name) => ({ name })));
        return entry.path.endsWith('/pulls/7') ? jsonResponse(pullRequest()) : jsonResponse({ number: 5, state: 'open' });
      });
      const { app, store } = makeApp();

      await request(app).post('/api/source-control/github/pr/labels')
        .send({ ...context(account.accountId, { target: pullTarget }), labels: ['docs', 'bug', 'docs'] }).expect(200);
      await request(app).post('/api/source-control/github/issues/labels')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 }, idempotencyKey: 'request-two' }), labels: [] }).expect(200);
      await request(app).post('/api/source-control/github/pr/labels')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-three' }), labels: ['  '] }).expect(400);

      expect(requests.filter((entry) => entry.method === 'PUT')).toEqual([
        { method: 'PUT', path: '/repos/acme/app/issues/7/labels', body: { labels: ['bug', 'docs'] } },
        { method: 'PUT', path: '/repos/acme/app/issues/5/labels', body: { labels: [] } },
      ]);
      expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-labels', state: 'succeeded' });
    });

    it('asks and stops asking reviewers so the requested set matches', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.path.endsWith('/requested_reviewers') && entry.method === 'GET') {
          return jsonResponse({ users: [{ login: 'ann' }, { login: 'bob' }], teams: [] });
        }
        if (entry.path.endsWith('/requested_reviewers')) return jsonResponse(pullRequest());
        return jsonResponse(pullRequest());
      });
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/reviewers')
        .send({ ...context(account.accountId, { target: pullTarget }), reviewers: ['cid', 'ann'] }).expect(200);

      expect(response.body.result).toEqual({});
      expect(requests.filter((entry) => entry.method !== 'GET')).toEqual([
        { method: 'POST', path: '/repos/acme/app/pulls/7/requested_reviewers', body: { reviewers: ['cid'] } },
        { method: 'DELETE', path: '/repos/acme/app/pulls/7/requested_reviewers', body: { reviewers: ['bob'] } },
      ]);
    });

    it('leaves a comment interrupted mid-write as outcome unknown instead of posting it again', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-comment', actor, credential: credentialFor(account), target, body: 'On it' };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-comment', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({}));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      const response = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), body: 'On it' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('does not retry or invalidate after a definite provider rejection', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse({ message: 'A pull request already exists for acme:feature.' }, 422));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();
    const now = vi.spyOn(Date, 'now');
    const statusQuery = {
      directory: '/repo', branch: 'feature', repositoryId: 'repo-one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };
    now.mockReturnValue(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);

    now.mockReturnValue(2_000);
    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'private title' }).expect(422);
    expect(response.body).toEqual({ error: 'A pull request already exists for acme:feature.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422, failureCode: 'GITHUB_MUTATION_REJECTED' } });
    now.mockReturnValue(3_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);
  });

  it('answers with GitHub\'s reason when it refuses a read before the write', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const restricted = 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.';
    const fetch = vi.fn(async () => jsonResponse({ message: restricted }, 403));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge')
      .send({ ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7 } }), method: 'squash' })
      .expect(403);

    expect(response.body).toEqual({ error: restricted, code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.records.size).toBe(0);
  });

  it('invalidates canonical status only for the successful mutation authority', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const unrelated = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'other' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const now = vi.spyOn(Date, 'now');
    const statusQuery = (accountId, directory = '/repo', repositoryId = 'repo-one') => ({
      directory, branch: 'feature', repositoryId, bindingRevision: 3,
      accountId, primaryRemote: 'origin', instance: 'github.com',
    });

    now.mockReturnValue(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(1_000);
    now.mockReturnValue(2_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    now.mockReturnValue(2_100);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(2_100);
    now.mockReturnValue(2_200);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);

    now.mockReturnValue(3_000);
    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);

    now.mockReturnValue(4_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(4_000);
    now.mockReturnValue(5_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    now.mockReturnValue(6_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(6_000);
    now.mockReturnValue(7_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);
  });

  it('does not let an older canonical status read refill an invalidated authority', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const unrelated = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'other' } });
    let releaseStatus;
    let markStatusStarted;
    const heldStatus = new Promise((resolve) => { releaseStatus = resolve; });
    const statusStarted = new Promise((resolve) => { markStatusStarted = resolve; });
    const resolveStatus = vi.fn(async () => {
      if (resolveStatus.mock.calls.length === 1) {
        markStatusStarted();
        await heldStatus;
      }
      return { repo: null, pr: null, defaultBranch: null, resolvedRemoteName: null };
    });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ resolveStatus });
    const query = (accountId) => ({
      directory: '/repo', branch: 'feature', repositoryId: 'repo-one', bindingRevision: 3,
      accountId, primaryRemote: 'origin', instance: 'github.com',
    });

    const staleRead = request(app).get('/api/source-control/github/pr/status')
      .query(query(acting.accountId)).expect(200).then((response) => response);
    await statusStarted;
    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);
    releaseStatus();
    await staleRead;

    await request(app).get('/api/source-control/github/pr/status').query(query(acting.accountId)).expect(200);
    await request(app).get('/api/source-control/github/pr/status').query(query(unrelated.accountId)).expect(200);
    await request(app).get('/api/source-control/github/pr/status').query(query(unrelated.accountId)).expect(200);
    expect(resolveStatus).toHaveBeenCalledTimes(3);
  });

  it('invalidates canonical pull context across linked worktree directories only', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pullReads = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/acme/app/pulls/7') {
        if (options.method === 'GET') pullReads.push(pathname);
        return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
      }
      return jsonResponse([]);
    }));
    const { app } = makeApp();
    const query = (directory, repositoryId = 'repo-one') => ({
      directory,
      number: 7,
      repositoryId,
      bindingRevision: 3,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    });

    await request(app).get('/api/source-control/github/pulls/context').query(query('/repo')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/worktree')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/other', 'repo-two')).expect(200);
    expect(pullReads).toHaveLength(3);

    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };
    await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed' }).expect(200);

    await request(app).get('/api/source-control/github/pulls/context').query(query('/repo')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/worktree')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/other', 'repo-two')).expect(200);
    expect(pullReads).toHaveLength(6);
  });

  it('does not let an older canonical pull context refill an invalidated target', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let releaseContext;
    let markContextStarted;
    const heldContext = new Promise((resolve) => { releaseContext = resolve; });
    const contextStarted = new Promise((resolve) => { markContextStarted = resolve; });
    let pullGets = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/acme/app/pulls/7') {
        if (options.method === 'GET') {
          pullGets += 1;
          if (pullGets === 1) {
            markContextStarted();
            await heldContext;
          }
        }
        return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
      }
      return jsonResponse([]);
    }));
    const { app } = makeApp();
    const query = {
      directory: '/worktree', number: 7, repositoryId: 'repo-one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };

    const staleRead = request(app).get('/api/source-control/github/pulls/context')
      .query(query).expect(200).then((response) => response);
    await contextStarted;
    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };
    await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed' }).expect(200);
    releaseContext();
    await staleRead;

    await request(app).get('/api/source-control/github/pulls/context').query(query).expect(200);
    expect(pullGets).toBe(3);
  });
});

describe('legacy GitHub mutations', () => {
  it('retires ambient reads and writes without provider calls', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const query = { directory: '/repo', branch: 'feature', remote: 'origin', accountId: account.accountId };

    await request(app).get('/api/github/pr/status').query(query).expect(410);
    await request(app).post('/api/github/pr/create').send({
      directory: '/repo', title: 'Title', head: 'feature', base: 'main', remote: 'origin', accountId: account.accountId,
    }).expect(410);
    expect(fetch).not.toHaveBeenCalled();
  });
});
