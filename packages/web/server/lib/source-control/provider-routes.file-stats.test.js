import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerProviderRoutes } from './provider-routes.js';
import { githubDescriptor } from '../github/descriptor.js';

const context = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo', accountId: 'exact-account', bindingRevision: 2, primaryRemote: 'origin' };
const stats = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: [{ path: 'a.ts', additions: 3, deletions: 0 }] };
function setup({ validationError, supported = true } = {}) {
  const resolve = vi.fn(async () => ({ instance: context.instance, accountId: context.accountId }));
  const read = vi.fn(async () => stats);
  const validate = vi.fn(async input => { if (validationError) throw validationError; return input; });
  const impl = { auth: { resolveAccount: resolve }, resources: supported ? { changeRequestFileStats: read } : {}, classifyFailure: () => 'provider-error' };
  const app = express();app.use(express.json());
  registerProviderRoutes(app, { providers: { list: () => [githubDescriptor], implementation: async () => impl, events: { subscribe: () => () => {} } }, validateReadContext: validate });
  const get = (query = {}) => request(app).get('/api/source-control/github/pulls/file-stats').query({ ...context, number: 7, owner: 'acme', repo: 'app', expectedHeadSha: stats.headSha, ...query });
  return { get, read, resolve, validate };
}
describe('bound file statistics route', () => {
  it('validates binding before resolving the exact account and returning metadata', async () => {
    const { get, read, resolve, validate } = setup();
    expect((await get().expect(200)).body).toEqual(stats);
    expect(validate).toHaveBeenCalledWith(context);
    expect(resolve).toHaveBeenCalledWith({ instance: context.instance, accountId: context.accountId });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ context, number: 7, project: { owner: 'acme', name: 'app' }, expectedHeadSha: stats.headSha, signal: expect.any(AbortSignal) }));
  });
  it('rejects malformed targets before binding or account work', async () => {
    const { get, validate, resolve, read } = setup();
    for (const query of [{ number: 0 }, { expectedHeadSha: 'bad' }, { repo: '' }]) await get(query).expect(400);
    expect(validate).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
  });
  it('a stale binding cannot perform provider work', async () => {
    const { get, resolve, read } = setup({ validationError: Object.assign(new Error('stale'), { code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 }) });
    await get().expect(409);expect(resolve).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
  });
  it('a missing provider operation is explicitly unsupported', async () => {
    const { get, resolve } = setup({ supported: false });
    expect((await get().expect(501)).body.code).toBe('SOURCE_CONTROL_CAPABILITY_UNSUPPORTED');expect(resolve).not.toHaveBeenCalled();
  });
});

it('a 3001-file read reaches the real immutable snapshot resolver through source-control registration', async () => {
  const { createGitHubResources } = await import('../github/resources.js');
  const { registerSourceControlRoutes } = await import('./routes.js');
  const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), mergeBaseSha = 'c'.repeat(40);
  const get = vi.fn(async () => ({ data: { number: 7, head: { sha: headSha, repo: null }, base: { sha: baseSha }, changed_files: 3001 } }));
  const compare = vi.fn(async () => ({ data: { merge_base_commit: { sha: mergeBaseSha } } }));
  const listFiles = vi.fn();
  const octokit = { rest: { pulls: { get, listFiles } }, request: compare };
  const session = { instance: 'github.com', accountId: context.accountId };
  let routes;
  let coordinates;
  const resources = createGitHubResources({
    accountOf: () => ({ octokit }), resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
    resolveNetwork: async () => [{ owner: 'acme', repo: 'app', source: 'origin' }],
    readPullRequestSnapshot: async input => {
      coordinates = await routes.resolveGitHubPullRequestSnapshot(input);
      return { files: Array.from({ length: 3001 }, (_, index) => ({ filename: `file-${index}.ts`, additions: 1, deletions: 0 })) };
    },
  });
  const checkout = vi.fn(async () => { throw new Error('Must not resolve a checkout source'); });
  const resolveAccount = vi.fn(async () => session);
  const providers = { list: () => [githubDescriptor], has: id => id === 'github', describe: () => githubDescriptor,
    events: { subscribe: () => () => {} }, implementation: async () => ({ auth: { resolveAccount }, resources: { ...resources, resolveChangeRequestSource: checkout }, classifyFailure: () => 'provider-error' }) };
  const app = express();app.use(express.json());
  routes = registerSourceControlRoutes(app, { providers, bindingService: { validateReadContext: async input => input } });
  const { body } = await request(app).get('/api/source-control/github/pulls/file-stats').query({ ...context, number: 7, owner: 'acme', repo: 'app', expectedHeadSha: headSha }).expect(200);
  expect(body.files).toHaveLength(3001);
  expect(coordinates).toEqual({ context, repo: { owner: 'acme', repo: 'app' }, number: 7, headSha, baseSha, mergeBaseSha, endpoint: 'https://github.com/acme/app.git' });
  expect(compare).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/compare/{basehead}', { owner: 'acme', repo: 'app', basehead: `${baseSha}...${headSha}` });
  expect(checkout).not.toHaveBeenCalled();expect(listFiles).not.toHaveBeenCalled();
  expect(resolveAccount.mock.calls.every(([input]) => input.accountId === context.accountId)).toBe(true);
  const before = get.mock.calls.length;
  await expect(routes.resolveGitHubPullRequestSnapshot({ context, repo: { owner: 'other', repo: 'private' }, number: 7 })).rejects.toMatchObject({ sourceControlResponse: { status: 400 } });
  expect(get).toHaveBeenCalledTimes(before);
});
