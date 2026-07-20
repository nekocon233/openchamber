import { describe, expect, test } from 'bun:test';

import type {
  SidebarStateAPI,
  SidebarStateMutationRequest,
  SidebarStateSnapshot,
} from '@/lib/api/types';
import { SidebarStateConflictError, applySidebarStateOperation } from '@/lib/sidebarState';
import { createSidebarStateClientStore } from './useSidebarStateStore';

const emptySnapshot = (): SidebarStateSnapshot => ({
  schemaVersion: 1,
  revision: 0,
  projects: [],
  pinnedSessionIds: [],
  worktreeOrderByProject: {},
  sessionFoldersByScope: {},
});

const snapshotAt = (revision: number): SidebarStateSnapshot => ({
  ...emptySnapshot(),
  revision,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushScheduledWork = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const scheduleRetryImmediately = (callback: () => void): (() => void) => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) callback();
  });
  return () => {
    cancelled = true;
  };
};

const createRetryScheduler = () => {
  const retries: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    retries,
    scheduleRetry: (callback: () => void, delayMs: number) => {
      const retry = { callback, delayMs, cancelled: false };
      retries.push(retry);
      return () => {
        retry.cancelled = true;
      };
    },
  };
};

describe('sidebar state client convergence', () => {
  test('retries concurrent intents and converges both clients after a revision hint', async () => {
    let authoritative = emptySnapshot();
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => authoritative,
      mutate: async (request: SidebarStateMutationRequest) => {
        await Promise.resolve();
        if (request.baseRevision !== authoritative.revision) {
          throw new SidebarStateConflictError(authoritative);
        }
        authoritative = {
          ...applySidebarStateOperation(authoritative, request.operation),
          revision: authoritative.revision + 1,
        };
        return {
          snapshot: authoritative,
          applied: true,
          deduplicated: false,
          mutationRevision: authoritative.revision,
        };
      },
    };
    let mutationId = 0;
    const createClient = () => createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      createMutationId: () => `mutation-${mutationId += 1}`,
    });
    const first = createClient();
    const second = createClient();

    await Promise.all([first.getState().initialize(), second.getState().initialize()]);
    await Promise.all([
      first.getState().mutate({ type: 'session.pin', sessionId: 'session-first' }),
      second.getState().mutate({ type: 'session.pin', sessionId: 'session-second' }),
    ]);

    expect(authoritative.revision).toBe(2);
    expect(authoritative.pinnedSessionIds).toEqual(['session-first', 'session-second']);

    first.getState().handleRevisionHint(authoritative.revision);
    second.getState().handleRevisionHint(authoritative.revision);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.getState().snapshot).toEqual(authoritative);
    expect(second.getState().snapshot).toEqual(authoritative);
  });

  test('rolls an optimistic mutation back when authoritative persistence fails', async () => {
    const authoritative = snapshotAt(7);
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => authoritative,
      mutate: async () => {
        throw new Error('injected persistence failure');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      createMutationId: () => 'failed-mutation',
    });
    await client.getState().initialize();

    const mutation = client.getState().mutate({ type: 'session.pin', sessionId: 'session-failed' });
    expect(client.getState().snapshot?.pinnedSessionIds).toEqual(['session-failed']);
    expect(client.getState().snapshot?.revision).toBe(7);
    expect(client.getState().baseSnapshot?.revision).toBe(7);
    let failure: unknown;
    try {
      await mutation;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(client.getState().snapshot).toEqual(authoritative);
    expect(client.getState().baseSnapshot?.revision).toBe(7);
    expect(client.getState().pendingOperations).toEqual([]);
  });

  test('recovers a standalone initial bootstrap after a transient failure', async () => {
    let loadCount = 0;
    const scheduler = createRetryScheduler();
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) throw new Error('temporary bootstrap failure');
        return snapshotAt(4);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: scheduler.scheduleRetry,
    });

    await client.getState().initialize();
    expect(client.getState().status).toBe('error');
    expect(client.getState().baseSnapshot).toBeNull();
    expect(scheduler.retries.map((retry) => retry.delayMs)).toEqual([250]);

    scheduler.retries[0].callback();
    await flushScheduledWork();

    expect(loadCount).toBe(2);
    expect(client.getState().status).toBe('ready');
    expect(client.getState().baseSnapshot?.revision).toBe(4);
    expect(scheduler.retries).toHaveLength(1);

    scheduler.retries[0].callback();
    await flushScheduledWork();
    expect(loadCount).toBe(2);
  });

  test('bounds repeated standalone bootstrap failures with capped exponential backoff', async () => {
    let loadCount = 0;
    const scheduler = createRetryScheduler();
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        throw new Error(`bootstrap failure ${loadCount}`);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: scheduler.scheduleRetry,
    });

    await client.getState().initialize();
    for (let index = 0; index < 5; index += 1) {
      scheduler.retries[index].callback();
      await flushScheduledWork();
    }

    expect(loadCount).toBe(6);
    expect(scheduler.retries.map((retry) => retry.delayMs)).toEqual([250, 500, 1_000, 2_000, 2_000]);
    expect(client.getState().status).toBe('error');
    expect(client.getState().baseSnapshot).toBeNull();

    scheduler.retries[4].callback();
    await flushScheduledWork();
    expect(loadCount).toBe(6);
    expect(scheduler.retries).toHaveLength(5);
  });

  test('cancels a standalone bootstrap retry when the runtime changes', async () => {
    let runtimeKey = 'runtime-old';
    let oldLoadCount = 0;
    let newLoadCount = 0;
    const scheduler = createRetryScheduler();
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        if (runtimeKey === 'runtime-old') {
          oldLoadCount += 1;
          throw new Error('old runtime unavailable');
        }
        newLoadCount += 1;
        return snapshotAt(8);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => runtimeKey,
      getAPI: () => api,
      scheduleRetry: scheduler.scheduleRetry,
    });
    await client.getState().initialize();
    const obsoleteRetry = scheduler.retries[0];

    runtimeKey = 'runtime-new';
    client.getState().switchRuntime(runtimeKey);
    await flushScheduledWork();

    expect(obsoleteRetry.cancelled).toBe(true);
    expect(client.getState().runtimeKey).toBe('runtime-new');
    expect(client.getState().baseSnapshot?.revision).toBe(8);
    expect(oldLoadCount).toBe(1);
    expect(newLoadCount).toBe(1);

    obsoleteRetry.callback();
    await flushScheduledWork();
    expect(oldLoadCount).toBe(1);
    expect(newLoadCount).toBe(1);
  });

  test('explicit reinitialization cancels stale retry work and resets bootstrap backoff', async () => {
    let loadCount = 0;
    const scheduler = createRetryScheduler();
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        if (loadCount < 3) throw new Error('still starting');
        return snapshotAt(2);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: scheduler.scheduleRetry,
    });
    await client.getState().initialize();
    const obsoleteRetry = scheduler.retries[0];

    await client.getState().initialize();

    expect(obsoleteRetry.cancelled).toBe(true);
    expect(scheduler.retries.map((retry) => retry.delayMs)).toEqual([250, 250]);
    expect(client.getState().status).toBe('error');

    obsoleteRetry.callback();
    await flushScheduledWork();
    expect(loadCount).toBe(2);

    scheduler.retries[1].callback();
    await flushScheduledWork();
    expect(loadCount).toBe(3);
    expect(client.getState().status).toBe('ready');
    expect(client.getState().baseSnapshot?.revision).toBe(2);
  });

  test('keeps a pre-bootstrap mutation pending across a transient load failure and retries it', async () => {
    let authoritative = emptySnapshot();
    let loadCount = 0;
    let mutationCount = 0;
    const scheduledRetries: Array<() => void> = [];
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) throw new Error('temporary bootstrap failure');
        return authoritative;
      },
      mutate: async (request) => {
        mutationCount += 1;
        authoritative = {
          ...applySidebarStateOperation(authoritative, request.operation),
          revision: authoritative.revision + 1,
        };
        return {
          snapshot: authoritative,
          applied: true,
          deduplicated: false,
          mutationRevision: authoritative.revision,
        };
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      createMutationId: () => 'pre-bootstrap-mutation',
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return () => {};
      },
    });

    let settled = false;
    const mutation = client.getState().mutate({ type: 'session.pin', sessionId: 'session-pending' })
      .finally(() => {
        settled = true;
      });
    await flushScheduledWork();

    expect(settled).toBe(false);
    expect(client.getState().status).toBe('error');
    expect(client.getState().baseSnapshot).toBeNull();
    expect(client.getState().pendingOperations).toHaveLength(1);
    expect(scheduledRetries).toHaveLength(1);

    scheduledRetries[0]();
    await mutation;

    expect(loadCount).toBe(2);
    expect(mutationCount).toBe(1);
    expect(client.getState().baseSnapshot?.revision).toBe(1);
    expect(client.getState().snapshot?.pinnedSessionIds).toEqual(['session-pending']);
    expect(client.getState().pendingOperations).toEqual([]);
  });

  test('retries a failed hinted refresh without discarding the prior authoritative snapshot', async () => {
    let loadCount = 0;
    const scheduledRetries: Array<() => void> = [];
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        if (loadCount === 1) return snapshotAt(0);
        if (loadCount === 2) throw new Error('temporary 503');
        return snapshotAt(1);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: (callback) => {
        scheduledRetries.push(callback);
        return () => {};
      },
    });
    await client.getState().initialize();

    client.getState().handleRevisionHint(1);
    await flushScheduledWork();

    expect(loadCount).toBe(2);
    expect(client.getState().status).toBe('error');
    expect(client.getState().baseSnapshot?.revision).toBe(0);
    expect(client.getState().snapshot?.revision).toBe(0);
    expect(scheduledRetries).toHaveLength(1);

    scheduledRetries[0]();
    await flushScheduledWork();

    expect(loadCount).toBe(3);
    expect(client.getState().status).toBe('ready');
    expect(client.getState().baseSnapshot?.revision).toBe(1);
  });

  test('rejects an old queued mutation before it can run against a new runtime', async () => {
    const oldLoad = deferred<SidebarStateSnapshot>();
    let runtimeKey = 'runtime-old';
    let api: SidebarStateAPI;
    let oldMutationCount = 0;
    let newMutationCount = 0;
    const oldApi: SidebarStateAPI = {
      supported: true,
      load: async () => oldLoad.promise,
      mutate: async () => {
        oldMutationCount += 1;
        throw new Error('old mutation must not run');
      },
    };
    const newApi: SidebarStateAPI = {
      supported: true,
      load: async () => snapshotAt(10),
      mutate: async () => {
        newMutationCount += 1;
        throw new Error('old intent reached the new runtime');
      },
    };
    api = oldApi;
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => runtimeKey,
      getAPI: () => api,
      createMutationId: () => 'old-runtime-mutation',
    });

    const initialization = client.getState().initialize();
    const mutationResult = client.getState().mutate({ type: 'project.remove', projectId: 'project-old' })
      .then(() => null, (error: unknown) => error);
    await flushScheduledWork();

    runtimeKey = 'runtime-new';
    api = newApi;
    client.getState().switchRuntime(runtimeKey);
    oldLoad.resolve(snapshotAt(0));
    await initialization;
    await flushScheduledWork();

    expect(await mutationResult).toBeInstanceOf(Error);
    expect(oldMutationCount).toBe(0);
    expect(newMutationCount).toBe(0);
    expect(client.getState().runtimeKey).toBe('runtime-new');
    expect(client.getState().baseSnapshot?.revision).toBe(10);
    expect(client.getState().pendingOperations).toEqual([]);
  });

  test('ignores a revision hint delivered by an obsolete runtime pipeline', async () => {
    let runtimeKey = 'runtime-old';
    let oldLoadCount = 0;
    let newLoadCount = 0;
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        if (runtimeKey === 'runtime-old') {
          oldLoadCount += 1;
          return snapshotAt(0);
        }
        newLoadCount += 1;
        return snapshotAt(10);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => runtimeKey,
      getAPI: () => api,
    });
    await client.getState().initialize();
    const obsoleteContext = {
      runtimeKey: client.getState().runtimeKey,
      generation: client.getState().generation,
    };

    runtimeKey = 'runtime-new';
    client.getState().switchRuntime(runtimeKey);
    await flushScheduledWork();
    client.getState().handleRevisionHint(100, obsoleteContext);
    await flushScheduledWork();

    expect(oldLoadCount).toBe(1);
    expect(newLoadCount).toBe(1);
    expect(client.getState().baseSnapshot?.revision).toBe(10);
  });

  test('retries a revision hint received during an older in-flight load', async () => {
    const firstLoad = deferred<SidebarStateSnapshot>();
    const secondLoad = deferred<SidebarStateSnapshot>();
    const loads = [firstLoad, secondLoad];
    let loadCount = 0;
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        const load = loads[loadCount];
        loadCount += 1;
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        try {
          return await load.promise;
        } finally {
          activeLoads -= 1;
        }
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: scheduleRetryImmediately,
    });

    const initialization = client.getState().initialize();
    client.getState().handleRevisionHint(2);
    client.getState().handleRevisionHint(2);
    await flushScheduledWork();
    expect(loadCount).toBe(1);

    firstLoad.resolve(snapshotAt(1));
    await initialization;
    await flushScheduledWork();
    expect(loadCount).toBe(2);
    expect(maxActiveLoads).toBe(1);

    secondLoad.resolve(snapshotAt(2));
    await flushScheduledWork();
    expect(client.getState().baseSnapshot?.revision).toBe(2);
    expect(loadCount).toBe(2);
  });

  test('continues toward the newest hint without overlapping deferred loads', async () => {
    const firstRetry = deferred<SidebarStateSnapshot>();
    const secondRetry = deferred<SidebarStateSnapshot>();
    const retries = [firstRetry, secondRetry];
    let retryCount = 0;
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        if (retryCount === 0) {
          retryCount += 1;
          return snapshotAt(0);
        }
        const load = retries[retryCount - 1];
        retryCount += 1;
        activeLoads += 1;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        try {
          return await load.promise;
        } finally {
          activeLoads -= 1;
        }
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: scheduleRetryImmediately,
    });
    await client.getState().initialize();

    client.getState().handleRevisionHint(1);
    await flushScheduledWork();
    expect(retryCount).toBe(2);

    client.getState().handleRevisionHint(3);
    client.getState().handleRevisionHint(2);
    await flushScheduledWork();
    expect(retryCount).toBe(2);

    firstRetry.resolve(snapshotAt(1));
    await flushScheduledWork();
    expect(retryCount).toBe(3);
    expect(maxActiveLoads).toBe(1);

    secondRetry.resolve(snapshotAt(3));
    await flushScheduledWork();
    expect(client.getState().baseSnapshot?.revision).toBe(3);
    expect(retryCount).toBe(3);
  });

  test('backs off repeated stale snapshots instead of starting a request loop', async () => {
    let authoritativeRevision = 0;
    let loadCount = 0;
    const scheduledRetries: Array<{ callback: () => void; cancelled: boolean }> = [];
    const api: SidebarStateAPI = {
      supported: true,
      load: async () => {
        loadCount += 1;
        return snapshotAt(authoritativeRevision);
      },
      mutate: async () => {
        throw new Error('not used');
      },
    };
    const client = createSidebarStateClientStore({
      getRuntimeKey: () => 'runtime-test',
      getAPI: () => api,
      scheduleRetry: (callback) => {
        const retry = { callback, cancelled: false };
        scheduledRetries.push(retry);
        return () => {
          retry.cancelled = true;
        };
      },
    });
    await client.getState().initialize();

    client.getState().handleRevisionHint(2);
    await flushScheduledWork();
    expect(loadCount).toBe(2);
    expect(scheduledRetries).toHaveLength(1);

    client.getState().handleRevisionHint(2);
    await flushScheduledWork();
    expect(loadCount).toBe(2);
    expect(scheduledRetries).toHaveLength(1);

    authoritativeRevision = 2;
    scheduledRetries[0].callback();
    await flushScheduledWork();
    expect(client.getState().baseSnapshot?.revision).toBe(2);
    expect(loadCount).toBe(3);
    expect(scheduledRetries).toHaveLength(1);
  });
});
