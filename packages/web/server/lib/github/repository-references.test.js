import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-repository-prs-'));
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const repo = { owner: 'example', repo: 'project', url: 'https://github.com/example/project' };
const upstream = { owner: 'upstream', repo: 'project', source: 'upstream' };
const node = (number, state = 'OPEN', owner = 'example') => ({
  __typename: 'PullRequest', number, title: `PR ${number}`, url: `https://github.com/${owner}/project/pull/${number}`,
  createdAt: null, updatedAt: null, body: '', author: null, labels: { nodes: [] }, comments: { totalCount: 0 },
  repository: { name: 'project', owner: { login: owner } }, state, isDraft: false,
  headRefName: `feature-${number}`, baseRefName: 'main', headRefOid: `sha-${number}`, headRepository: null,
});
const connection = (nodes, more = false, total = nodes.length) => ({
  data: { repository: { pullRequests: { nodes, totalCount: total, pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } } } },
});

describe('single-repository PR references', () => {
  let app;
  let accountId;
  const resolveNetwork = vi.fn(async () => [{ ...repo, source: 'origin' }, upstream]);
  const resolveRepo = vi.fn(async () => ({ repo }));
  const validate = vi.fn(async (context) => ({ ...context, bindingRevision: 1 }));
  const context = () => ({ provider: 'github', instance: 'github.com', directory: '/fixture', repositoryId: 'repo-1', accountId, bindingRevision: '1', primaryRemote: 'origin' });
  const get = (options = {}) => request(app).get('/api/source-control/github/references').query({ ...context(), kind: 'pull', scope: 'repository', state: 'all', ...options });
  const serve = (answer) => {
    const fetch = vi.fn(async (url, init) => {
      expect(new URL(url).pathname).toBe('/graphql');
      return Response.json(await answer(JSON.parse(init.body)));
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    ({ accountId } = await setGitHubAuth({ accessToken: 'fixture-token', user: { id: 7, login: 'tester' } }));
    app = express();
    registerGitHubRoutes(app, { validateReadContext: validate, resolveGitHubRepoFromDirectory: resolveRepo, resolveRepoNetwork: resolveNetwork });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists every state from the bound repository without asking about its upstream', async () => {
    const fetch = serve(({ query, variables }) => {
      expect(query).toContain('pullRequests(states:');
      expect(query).toContain('UPDATED_AT, direction: DESC');
      expect(variables).toEqual({ owner: 'example', repo: 'project', states: null, first: 30, after: null });
      return connection([node(3), node(2, 'MERGED'), node(1, 'CLOSED')]);
    });
    const { body } = await get().expect(200);
    expect(body.scope).toBe('repository');
    expect(body.items.map((item) => item.state)).toEqual(['open', 'merged', 'closed']);
    expect(resolveNetwork).not.toHaveBeenCalled();
    expect(resolveRepo).toHaveBeenCalledWith('/fixture', 'origin');
    expect(validate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns checks for open, merged and closed PRs in one status request', async () => {
    const fetch = serve(({ variables }) => {
      expect(variables).toMatchObject({ p0: 1, p1: 2, p2: 3, p3: 4 });
      const summary = (number, state, checks) => ({
        ...node(number, state), mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
      });
      const check = (state) => [{ __typename: 'StatusContext', context: 'ci', state }];
      return { data: {
        a0: { pullRequest: summary(1, 'OPEN', check('FAILURE')) },
        a1: { pullRequest: summary(2, 'MERGED', check('SUCCESS')) },
        a2: { pullRequest: summary(3, 'CLOSED', []) },
        a3: { pullRequest: null },
      } };
    });
    const { body } = await request(app).get('/api/source-control/github/references/status')
      .query({ ...context(), pulls: 'example/project#1,example/project#2,example/project#3,example/project#4' }).expect(200);
    expect(body.statuses.map(({ number, checks }) => ({ number, checks }))).toEqual([
      { number: 1, checks: expect.objectContaining({ state: 'failure', total: 1, failure: 1 }) },
      { number: 2, checks: expect.objectContaining({ state: 'success', total: 1, success: 1 }) },
      { number: 3, checks: expect.objectContaining({ state: 'unknown', total: 0 }) },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([['open', ['OPEN']], ['merged', ['MERGED']], ['closed', ['CLOSED', 'MERGED']]])('filters %s through the repository connection', async (state, states) => {
    serve(({ variables }) => { expect(variables.states).toEqual(states); return connection([]); });
    await get({ state }).expect(200);
  });

  it('passes the cursor through after 1,000 PRs without a search cutoff', async () => {
    serve(({ variables }) => {
      expect(variables.after).toBe('page-after-1000');
      return connection([node(1001)], true, 1200);
    });
    const { body } = await get({ cursor: 'page-after-1000' }).expect(200);
    expect(body).toMatchObject({ total: 1200, cursor: 'next', hasMore: true, items: [{ number: 1001 }] });
  });

  it('keeps the network scope for callers that do not select a scope', async () => {
    serve(({ variables }) => {
      expect(variables.q).toContain('repo:example/project repo:upstream/project');
      return { data: { search: { nodes: [node(1, 'OPEN', 'upstream')], issueCount: 1, pageInfo: { endCursor: null, hasNextPage: false } } } };
    });
    const { body } = await request(app).get('/api/source-control/github/references').query({ ...context(), kind: 'pull' }).expect(200);
    expect(body.items[0].sourceRepo.owner).toBe('upstream');
    expect(resolveNetwork).toHaveBeenCalledOnce();
  });

  it('searches one repository and preserves the count for a search-limit notice', async () => {
    serve(({ variables }) => {
      expect(variables.q).toBe('repo:example/project is:pr sort:updated-desc author:@me crash');
      return { data: { search: { nodes: [node(7)], issueCount: 1500, pageInfo: { endCursor: 'search-next', hasNextPage: true } } } };
    });
    const { body } = await get({ query: 'crash', people: 'created' }).expect(200);
    expect(body).toMatchObject({ total: 1500, items: [{ number: 7 }], cursor: 'search-next' });
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('does not substitute an issue for a PR with the same number', async () => {
    serve(({ variables }) => {
      expect(variables).toEqual({ number: 4, o0: 'example', n0: 'project' });
      return { data: { a0: { issueOrPullRequest: { ...node(4), __typename: 'Issue', stateReason: null } } } };
    });
    const { body } = await get({ query: '#4' }).expect(200);
    expect(body.items).toEqual([]);
  });

  it('does not look up a pasted upstream URL', async () => {
    const fetch = serve(() => { throw new Error('Unexpected lookup'); });
    const { body } = await get({ query: 'https://github.com/upstream/project/pull/4' }).expect(200);
    expect(body.items).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['repo:upstream/project', 'org:upstream', 'user:someone'])('rejects scope-changing search %s', async (query) => {
    await get({ query }).expect(400);
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  it('rejects an invalid scope', async () => { await get({ scope: 'all-github' }).expect(400); });

  it('reports unreadable or malformed pages as errors', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      serve(() => ({ data: { repository: null } }));
      await get().expect(500);
      serve(() => connection([node(1, 'OPEN', 'upstream')]));
      await get().expect(500);
    } finally { errorLog.mockRestore(); }
  });
});
