import { beforeEach, describe, expect, test } from 'bun:test';

import type { CiWorkflowRun, CiWorkflowRunPage, SourceControlReadContext } from '@/lib/api/types';
import { getCiRunsListKey, pinCiCacheKey, useCiRunsStore } from './ciRunsStore';

const context: SourceControlReadContext = {
  provider: 'github',
  instance: 'github.com',
  directory: '/workspace/app',
  repositoryId: 'repo-1',
  accountId: 'github.com#7',
  bindingRevision: 1,
  primaryRemote: 'origin',
};

const sampleRun = (id: string): CiWorkflowRun => ({
  provider: 'github',
  instance: 'github.com',
  id,
  runNumber: Number(id),
  runAttempt: 1,
  project: {
    provider: 'github',
    instance: 'github.com',
    id: 'acme/app',
    owner: 'acme',
    name: 'app',
    url: 'https://github.com/acme/app',
  },
  workflowName: 'CI',
  title: `Run ${id}`,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  headBranch: 'main',
  headSha: 'a'.repeat(40),
  url: `https://github.com/acme/app/actions/runs/${id}`,
  actor: null,
  pullRequests: [],
});

beforeEach(() => {
  useCiRunsStore.getState().resetForRuntimeSwitch();
});

describe('useCiRunsStore', () => {
  test('retains previously loaded CI runs when a forced refresh fails', async () => {
    let fail = false;
    const api = {
      ciRunsList: async (): Promise<CiWorkflowRunPage> => {
        if (fail) throw new Error('rate limited');
        return {
          project: sampleRun('101').project,
          items: [sampleRun('101')],
          page: 1,
          hasMore: true,
        };
      },
    };
    const filter = { status: 'all' as const, query: '' };
    const key = getCiRunsListKey(context, filter);

    await useCiRunsStore.getState().ensureList(api, context, filter, false);
    expect(useCiRunsStore.getState().lists[key]?.items.map((item) => item.id)).toEqual(['101']);

    fail = true;
    await useCiRunsStore.getState().ensureList(api, context, filter, true);
    const retained = useCiRunsStore.getState().lists[key];
    expect(retained?.status).toBe('ready');
    expect(retained?.items.map((item) => item.id)).toEqual(['101']);
    expect(retained?.error).toBe('rate limited');
  });

  test('never evicts pinned list entries during idle pruning and clears on runtime switch', async () => {
    const pinnedContext: SourceControlReadContext = { ...context, repositoryId: 'pinned-repo' };
    const pinnedFilter = { status: 'all' as const };
    const pinnedKey = getCiRunsListKey(pinnedContext, pinnedFilter);
    const unpin = pinCiCacheKey(pinnedKey);

    await useCiRunsStore.getState().ensureList({
      ciRunsList: async () => ({ project: null, items: [sampleRun('1')], page: 1, hasMore: false }),
    }, pinnedContext, pinnedFilter, true);

    for (let i = 0; i < 35; i += 1) {
      await useCiRunsStore.getState().ensureList({
        ciRunsList: async () => ({ project: null, items: [sampleRun(String(i + 10))], page: 1, hasMore: false }),
      }, { ...context, repositoryId: `idle-${i}` }, pinnedFilter, true);
    }

    useCiRunsStore.getState().pruneIdle();
    expect(useCiRunsStore.getState().lists[pinnedKey]?.items[0]?.id).toBe('1');
    unpin();

    useCiRunsStore.getState().resetForRuntimeSwitch();
    expect(Object.keys(useCiRunsStore.getState().lists)).toHaveLength(0);
  });

  test('preserves loaded subsequent pages when page 1 refreshes', async () => {
    const filter = { status: 'all' as const };
    const key = getCiRunsListKey(context, filter);
    let headItem = sampleRun('200');
    const api = {
      ciRunsList: async (_ctx: SourceControlReadContext, opts?: { page?: number }): Promise<CiWorkflowRunPage> => {
        if (opts?.page === 2) {
          return { project: null, items: [sampleRun('100')], page: 2, hasMore: false };
        }
        return { project: null, items: [headItem], page: 1, hasMore: true };
      },
    };

    await useCiRunsStore.getState().ensureList(api, context, filter, false);
    await useCiRunsStore.getState().loadMoreList(api, context, filter);
    expect(useCiRunsStore.getState().lists[key]?.items.map((i) => i.id)).toEqual(['200', '100']);
    expect(useCiRunsStore.getState().lists[key]?.page).toBe(2);

    headItem = sampleRun('201');
    await useCiRunsStore.getState().ensureList(api, context, filter, true);
    const refreshed = useCiRunsStore.getState().lists[key];
    expect(refreshed?.page).toBe(2);
    expect(refreshed?.items.map((i) => i.id)).toEqual(['201', '100']);
  });
});
