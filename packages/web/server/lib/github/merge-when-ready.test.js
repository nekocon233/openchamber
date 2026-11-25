import { describe, expect, it, vi } from 'vitest';
import { cancelWaitingMerge, enableMergeWhenReady } from './merge-when-ready.js';

const project = { owner: 'acme', name: 'app' };
const target = { number: 7, base: 'main', headSha: 'abc' };
const pull = (overrides = {}) => ({ id: 'PR_7', state: 'OPEN', headRefOid: 'abc', mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED', isInMergeQueue: false, autoMergeRequest: null, ...overrides });
const client = (pr = pull(), queue = null) => ({ graphql: vi.fn(async (query, variables) => {
  if (query.startsWith('query')) return { repository: { pullRequest: pr, mergeQueue: queue } };
  if (query.includes('enablePullRequestAutoMerge')) return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: '2026-11-03', mergeMethod: variables.mergeMethod } } } };
  if (query.includes('disablePullRequestAutoMerge')) return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
  return { dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } };
}) });

describe('GitHub merge when ready', () => {
  it('enables auto-merge with the chosen method and an expected head guard', async () => {
    const octokit = client();
    expect(await enableMergeWhenReady(octokit, project, target, 'squash')).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][1]).toEqual({ id: 'PR_7', mergeMethod: 'SQUASH', sha: 'abc' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('expectedHeadOid: $sha');
  });
  it.each([
    [pull(), { id: 'MQ' }], [pull({ state: 'CLOSED' }), null], [pull({ headRefOid: 'moved' }), null],
    [pull({ mergeable: 'CONFLICTING' }), null], [pull({ mergeStateStatus: 'CLEAN' }), null],
  ])('does not auto-merge a queue, moved head, conflict or a settled pull', async (pr, queue) => {
    const octokit = client(pr, queue);
    expect(await enableMergeWhenReady(octokit, project, target, 'merge')).toBeNull();
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
  it('asks for squash when an existing auto-merge uses another method', async () => {
    const octokit = client(pull({ autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }));
    expect(await enableMergeWhenReady(octokit, project, target, 'squash')).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][1].mergeMethod).toBe('SQUASH');
  });

  it('does not schedule another write when automatic squash is already enabled', async () => {
    const octokit = client(pull({ autoMergeRequest: { enabledAt: 'now', mergeMethod: 'SQUASH' } }));
    expect(await enableMergeWhenReady(octokit, project, target, 'squash')).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('asks GitHub to re-enable squash when the cancelled request still appears in a waiting read', async () => {
    const cancelled = { enabledAt: '2026-11-25T08:25:39Z', mergeMethod: 'SQUASH' };
    const octokit = client(pull({ autoMergeRequest: cancelled }));
    expect(await enableMergeWhenReady(octokit, project, target, 'squash', cancelled)).toEqual({ merged: false, outcome: 'auto-merge' });
    expect(octokit.graphql.mock.calls[1][1]).toMatchObject({ mergeMethod: 'SQUASH', sha: target.headSha });
  });

  it('passes on a retained merge method when GitHub does not apply the requested one', async () => {
    const existing = { enabledAt: 'now', mergeMethod: 'MERGE' };
    const octokit = client(pull({ autoMergeRequest: existing }));
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ autoMergeRequest: existing }), mergeQueue: null } }))
      .mockImplementationOnce(async () => ({ enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: existing } } }));
    await expect(enableMergeWhenReady(octokit, project, target, 'squash')).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
  });

  it('preserves a refusal when the state read fails', async () => {
    expect(await enableMergeWhenReady({ graphql: async () => { throw new Error('offline'); } }, project, target, 'merge')).toBeNull();
  });
  it('passes on a refused auto-merge without claiming it was enabled', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull(), mergeQueue: null } }))
      .mockImplementationOnce(async () => { throw new Error('Auto-merge is not allowed'); });
    await expect(enableMergeWhenReady(octokit, project, target, 'merge')).rejects.toThrow('Auto-merge is not allowed');
  });
  it('keeps a replacement head in the queue', async () => {
    const octokit = client(pull({ headRefOid: 'next', isInMergeQueue: true }));
    await expect(cancelWaitingMerge(octokit, project, target)).rejects.toMatchObject({ status: 409 });
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });

  it('dequeues and disables any remaining auto-merge request', async () => {
    const octokit = client(pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }));
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }))
      .mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql.mock.calls[1][0]).toContain('dequeuePullRequest(input: { id: $id })');
    expect(octokit.graphql.mock.calls[3][0]).toContain('disablePullRequestAutoMerge');
  });
  it('does not disable again when dequeue already cleared auto-merge', async () => {
    const octokit = client();
    octokit.graphql.mockImplementationOnce(async () => ({ repository: { pullRequest: pull({ isInMergeQueue: true, autoMergeRequest: { enabledAt: 'now', mergeMethod: 'MERGE' } }), mergeQueue: { id: 'MQ' } } }))
      .mockImplementationOnce(async () => ({ dequeuePullRequest: { mergeQueueEntry: { id: 'MQ_7' } } }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: false, outcome: 'cancelled' });
    expect(octokit.graphql).toHaveBeenCalledTimes(3);
  });
  it('reports a merge that won the race with cancellation truthfully', async () => {
    const octokit = client(pull({ state: 'MERGED' }));
    expect(await cancelWaitingMerge(octokit, project, target)).toEqual({ merged: true });
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
  });
});
