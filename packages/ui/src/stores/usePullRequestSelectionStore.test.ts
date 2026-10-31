import { describe, expect, test } from 'bun:test';

import { usePullRequestSelectionStore } from './usePullRequestSelectionStore';
import { pullRequestNavigationKey } from './usePullRequestSelectionStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';

const source = { kind: 'pr' as const, number: 12, sourceRepo: { owner: 'acme', repo: 'project' } };
const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', accountId: 'account', repositoryId: 'repo', bindingRevision: 1, primaryRemote: 'origin', directory: '/workspace/repo' };
const reference: GitHubPullReference = { kind: 'pull', number: 12, title: 'A pull request', url: 'https://github.com/acme/project/pull/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'project', source: 'origin' }, state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'sha', headRepo: null };

describe('pull request diff requests', () => {
  test('a repeated request is a new one, and a taken one is dropped', () => {
    const store = usePullRequestSelectionStore.getState();
    store.requestDiff('/repo', source);
    const first = usePullRequestSelectionStore.getState().diffRequests.get('/repo');
    store.requestDiff('/repo', source);
    const second = usePullRequestSelectionStore.getState().diffRequests.get('/repo');
    expect(second).toEqual(source);
    expect(second).not.toBe(first);

    // Settling an older request leaves the newer one in place.
    if (!first || !second) throw new Error('Expected both requests');
    store.settleDiffRequest('/repo', first);
    expect(usePullRequestSelectionStore.getState().diffRequests.get('/repo')).toBe(second);
    store.settleDiffRequest('/repo', second);
    expect(usePullRequestSelectionStore.getState().diffRequests.has('/repo')).toBe(false);
  });

  test('returning keeps the exact PR and workspace after Changes consumes the handoff', () => {
    const store = usePullRequestSelectionStore.getState();
    const runtime = getRuntimeKey();
    store.requestDiff(context.directory, source, { workspaceDirectory: '/workspace', tab: 'project', context, reference });
    const request = usePullRequestSelectionStore.getState().diffRequests.get(context.directory);
    const target = usePullRequestSelectionStore.getState().diffReturnTargets.get(pullRequestNavigationKey(runtime, context.directory));
    if (!request || !target) throw new Error('Navigation missing');
    store.settleDiffRequest(context.directory, request);
    expect(usePullRequestSelectionStore.getState().diffReturnTargets.get(pullRequestNavigationKey(runtime, context.directory))).toBe(target);
    expect(store.requestReturn({ ...target, runtimeKey: 'another-runtime' })).toBe(false);
    expect(store.requestReturn(target)).toBe(true);
    expect(usePullRequestSelectionStore.getState().returnRequests.get(pullRequestNavigationKey(runtime, '/workspace'))).toMatchObject({ reference, context, tab: 'project' });
    expect(store.requestReturn(target)).toBe(false);
    store.settleReturnRequest(target);
    expect(usePullRequestSelectionStore.getState().returnRequests.has(pullRequestNavigationKey(runtime, '/workspace'))).toBe(false);
  });

  test('a later navigation replaces the return target and a plain diff request clears it', () => {
    const store = usePullRequestSelectionStore.getState();
    const key = pullRequestNavigationKey(getRuntimeKey(), context.directory);
    store.requestDiff(context.directory, source, { workspaceDirectory: '/workspace', tab: 'project', context, reference });
    const old = usePullRequestSelectionStore.getState().diffReturnTargets.get(key);
    if (!old) throw new Error('Return target missing');
    store.requestDiff(context.directory, { ...source, number: 13 }, { workspaceDirectory: '/workspace', tab: 'branch', context, reference: { ...reference, number: 13 } });
    expect(store.requestReturn(old)).toBe(false);
    expect(usePullRequestSelectionStore.getState().diffReturnTargets.get(key)?.reference.number).toBe(13);
    store.requestDiff(context.directory, source);
    expect(usePullRequestSelectionStore.getState().diffReturnTargets.has(key)).toBe(false);
  });
});
