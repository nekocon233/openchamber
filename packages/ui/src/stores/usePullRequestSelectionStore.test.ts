import { beforeEach, describe, expect, test } from 'bun:test';

import { usePullRequestSelectionStore } from './usePullRequestSelectionStore';
import { pullRequestNavigationKey } from './usePullRequestSelectionStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';

const source = { kind: 'pr' as const, number: 12, sourceRepo: { owner: 'acme', repo: 'project' } };
const context: SourceControlReadContext = { provider: 'github', instance: 'github.com', accountId: 'account', repositoryId: 'repo', bindingRevision: 1, primaryRemote: 'origin', directory: '/workspace/repo' };
const reference: GitHubPullReference = { kind: 'pull', number: 12, title: 'A pull request', url: 'https://github.com/acme/project/pull/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'project', source: 'origin' }, state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'sha', headRepo: null };

beforeEach(() => usePullRequestSelectionStore.getState().resetOpenRequests());

describe('pull request pane requests', () => {
  const opening = { workspaceDirectory: '/workspace/', sourceDirectory: '/other/repo/', url: `${reference.url}/files#diff-1`, failureBehavior: 'manual' as const };

  test('keeps the host workspace separate from the source and takes each click once', () => {
    const store = usePullRequestSelectionStore.getState();
    const selections = store.selections;
    expect(store.requestOpen(opening)).toBe(true);
    const key = pullRequestNavigationKey(getRuntimeKey(), '/workspace');
    const first = usePullRequestSelectionStore.getState().openRequests.get(key);
    expect(first).toMatchObject({ ...opening, workspaceDirectory: '/workspace', sourceDirectory: '/other/repo', runtimeKey: getRuntimeKey() });
    store.requestOpen(opening);
    const second = usePullRequestSelectionStore.getState().openRequests.get(key);
    if (!first || !second) throw new Error('Expected both open requests');
    expect(second).not.toBe(first);
    store.settleOpenRequest(first);
    expect(usePullRequestSelectionStore.getState().openRequests.get(key)).toBe(second);
    store.settleOpenRequest(second);
    expect(usePullRequestSelectionStore.getState().openRequests.has(key)).toBe(false);
    expect(usePullRequestSelectionStore.getState().selections).toBe(selections);
  });

  test('rejects non-GitHub PR links and missing owners without changing another request', () => {
    const store = usePullRequestSelectionStore.getState();
    store.requestOpen(opening);
    const requests = usePullRequestSelectionStore.getState().openRequests;
    for (const url of ['#12', 'https://github.com/acme/project/issues/12', 'https://gitlab.com/acme/project/-/merge_requests/12']) {
      expect(store.requestOpen({ ...opening, url })).toBe(false);
    }
    expect(store.requestOpen({ ...opening, sourceDirectory: '' })).toBe(false);
    expect(usePullRequestSelectionStore.getState().openRequests).toBe(requests);
  });

  test('bounds pending workspaces and reset retires every old request', () => {
    const store = usePullRequestSelectionStore.getState();
    for (let i = 0; i < 101; i += 1) store.requestOpen({ ...opening, workspaceDirectory: `/workspace-${i}` });
    const requests = usePullRequestSelectionStore.getState().openRequests;
    expect(requests.size).toBe(100);
    expect(requests.has(pullRequestNavigationKey(getRuntimeKey(), '/workspace-0'))).toBe(false);
    store.resetOpenRequests();
    expect(usePullRequestSelectionStore.getState().openRequests.size).toBe(0);
  });

  test('queues one-shot CI run navigation requests and clears competing link opens', () => {
    const store = usePullRequestSelectionStore.getState();
    const key = pullRequestNavigationKey(getRuntimeKey(), '/workspace');
    store.requestOpen(opening);
    expect(store.requestCiRun('/workspace/', '/other/repo/', '12345')).toBe(true);
    expect(usePullRequestSelectionStore.getState().openRequests.has(key)).toBe(false);
    const ciReq = usePullRequestSelectionStore.getState().ciOpenRequests.get(key);
    expect(ciReq).toMatchObject({ workspaceDirectory: '/workspace', sourceDirectory: '/other/repo', runId: '12345' });
    expect(store.requestCiRun('/workspace', '/other/repo', 'abc')).toBe(false);
    if (!ciReq) throw new Error('Expected CI run request');
    store.settleCiRunRequest(ciReq);
    expect(usePullRequestSelectionStore.getState().ciOpenRequests.has(key)).toBe(false);
  });
});

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

  test('linked previews return to their original request and a later explicit open wins', () => {
    const store = usePullRequestSelectionStore.getState();
    const runtime = getRuntimeKey();
    const workspaceKey = pullRequestNavigationKey(runtime, '/workspace');
    store.requestOpen({ workspaceDirectory: '/workspace', sourceDirectory: context.directory, url: reference.url, failureBehavior: 'manual' });
    const opening = usePullRequestSelectionStore.getState().openRequests.get(workspaceKey);
    if (!opening) throw new Error('Missing link request');
    store.settleOpenRequest(opening);
    store.requestDiff(context.directory, source, { workspaceDirectory: '/workspace', tab: 'linked', request: opening, context, reference });
    const target = usePullRequestSelectionStore.getState().diffReturnTargets.get(pullRequestNavigationKey(runtime, context.directory));
    if (!target) throw new Error('Missing linked return target');
    store.requestOpen({ ...opening, url: 'https://github.com/acme/project/pull/13' });
    expect(store.requestReturn(target)).toBe(true);
    expect(usePullRequestSelectionStore.getState().openRequests.has(workspaceKey)).toBe(false);
    expect(usePullRequestSelectionStore.getState().returnRequests.get(workspaceKey)).toMatchObject({ tab: 'linked', request: opening });
    store.requestOpen({ ...opening, url: 'https://github.com/acme/project/pull/14' });
    expect(usePullRequestSelectionStore.getState().returnRequests.has(workspaceKey)).toBe(false);
    store.settleReturnRequest(target);
    expect(usePullRequestSelectionStore.getState().openRequests.get(workspaceKey)?.url).toBe('https://github.com/acme/project/pull/14');
  });
});
