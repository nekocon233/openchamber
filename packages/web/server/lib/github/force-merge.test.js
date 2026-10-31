import { describe, expect, it } from 'vitest';
import { ForceMergePreflightError, forceMergePullRequest } from './force-merge.js';

const HEAD = 'a'.repeat(40);
const TARGET = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: HEAD };
const pull = () => ({ __typename: 'PullRequest', id: 'PR_node', number: 7, state: 'OPEN', isDraft: false,
  mergeable: 'MERGEABLE', viewerCanMergeAsAdmin: true, headRefOid: HEAD, headRefName: 'feature', baseRefName: 'main',
  repository: { name: 'app', owner: { login: 'acme' } } });
const fixture = () => {
  const state = { node: pull(), queryError: null, mutationError: null, result: { mergePullRequest: { pullRequest: { id: 'PR_node', merged: true } } } };
  const calls = [];
  const octokit = { graphql: async (query, variables) => {
    calls.push({ query, variables });
    if (query.startsWith('query')) {
      if (state.queryError) throw state.queryError;
      return { node: state.node };
    }
    if (state.mutationError) throw state.mutationError;
    return state.result;
  } };
  return { state, calls, merge: (method = 'squash') => forceMergePullRequest({ octokit, nodeId: 'PR_node', target: TARGET, method }) };
};

describe('GitHub administrator direct merge', () => {
  it.each(['merge', 'squash', 'rebase'])('checks the exact target and binds %s to its approved head', async (method) => {
    const h = fixture();
    expect(await h.merge(method)).toEqual({ merged: true });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].variables).toEqual({ id: 'PR_node' });
    expect(h.calls[1].query).toContain('mergePullRequest(input: $input)');
    expect(h.calls[1].variables).toEqual({ input: { pullRequestId: 'PR_node', mergeMethod: method.toUpperCase(), expectedHeadOid: HEAD } });
  });

  it('matches the GitHub owner and repository name without case sensitivity', async () => {
    const h = fixture();
    h.state.node.repository = { name: 'APP', owner: { login: 'Acme' } };
    expect(await h.merge()).toEqual({ merged: true });
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    { id: 'PR_other' }, { number: 8 }, { headRefOid: 'b'.repeat(40) }, { headRefName: 'other' }, { baseRefName: 'other' },
    { repository: { name: 'other', owner: { login: 'acme' } } }, { repository: { name: 'app', owner: { login: 'other' } } },
  ])('rejects a changed target without a provider write: %o', async (changed) => {
    const h = fixture();
    h.state.node = { ...h.state.node, ...changed };
    await expect(h.merge()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', status: 409 });
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    { viewerCanMergeAsAdmin: false }, { state: 'CLOSED' }, { state: 'MERGED' }, { isDraft: true },
    { mergeable: 'CONFLICTING' }, { mergeable: 'UNKNOWN' },
  ])('refuses an unauthorized or unready pull without a provider write: %o', async (changed) => {
    const h = fixture();
    h.state.node = { ...h.state.node, ...changed };
    await expect(h.merge()).rejects.toBeInstanceOf(ForceMergePreflightError);
    expect(h.calls).toHaveLength(1);
  });

  it('treats query transport errors and malformed permissions as definitely before dispatch', async () => {
    const h = fixture();
    h.state.queryError = new Error('Response lost');
    await expect(h.merge()).rejects.toBeInstanceOf(ForceMergePreflightError);
    h.state.queryError = null;
    h.state.node = { ...h.state.node, viewerCanMergeAsAdmin: null };
    await expect(h.merge()).rejects.toBeInstanceOf(ForceMergePreflightError);
    expect(h.calls.every((call) => call.query.startsWith('query'))).toBe(true);
  });

  it.each([401, 403])('preserves explicit preflight authentication status %s and exact account metadata', async (status) => {
    const h = fixture();
    const identity = { provider: 'github', instance: 'github.com', accountId: 'fixture-account' };
    h.state.queryError = Object.assign(new Error('Fixture authentication refused'), {
      status, sourceControlIdentity: identity, sourceControlPersistedAccount: true, sourceControlInvalidated: true,
    });
    await expect(h.merge()).rejects.toMatchObject({ name: 'ForceMergePreflightError', status,
      sourceControlIdentity: identity, sourceControlPersistedAccount: true, sourceControlInvalidated: true });
    expect(h.calls).toHaveLength(1);
  });

  it.each([{ status: '401' }, { status: 500 }, {}])('keeps unverified preflight status as 502: %o', async (error) => {
    const h = fixture();
    h.state.queryError = error;
    await expect(h.merge()).rejects.toMatchObject({ name: 'ForceMergePreflightError', status: 502 });
    expect(h.calls).toHaveLength(1);
  });

  it('reports an explicit GraphQL mutation refusal separately from a lost or partial response', async () => {
    const h = fixture();
    h.state.mutationError = { errors: [{ message: 'Branch rules do not allow this merge', type: 'UNPROCESSABLE' }], data: { mergePullRequest: null } };
    await expect(h.merge()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_REJECTED', status: 422 });
    const partial = { errors: [{ message: 'A response field failed' }], data: { mergePullRequest: { pullRequest: { id: 'PR_node', merged: true } } } };
    h.state.mutationError = partial;
    await expect(h.merge()).rejects.toBe(partial);
    const network = new Error('Connection lost after dispatch');
    h.state.mutationError = network;
    await expect(h.merge()).rejects.toBe(network);
  });

  it.each([
    { errors: [{ message: 'A response field failed', type: 'INTERNAL' }], data: { mergePullRequest: null } },
    { errors: [{ message: 'An execution error has no type' }], data: null },
    { errors: [{ message: 'A refused field', type: 'FORBIDDEN' }, { message: 'A response field failed', type: 'INTERNAL' }], data: { mergePullRequest: null } },
    { errors: [{ type: 'FORBIDDEN' }], data: { mergePullRequest: null } },
  ])('preserves an ambiguous error after null bubbling: %o', async (error) => {
    const h = fixture();
    h.state.mutationError = error;
    await expect(h.merge()).rejects.toBe(error);
  });

  it.each([null, {}, { mergePullRequest: null }, { mergePullRequest: { pullRequest: { id: 'PR_other', merged: true } } }])('never acknowledges malformed mutation output %o', async (result) => {
    const h = fixture();
    h.state.result = result;
    await expect(h.merge()).rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
    expect(h.calls).toHaveLength(2);
  });
});
