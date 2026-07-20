import { describe, expect, mock, test } from 'bun:test';
import type { PushSubscribePayload } from '@/lib/api/types';
import {
  getBrowserPushRegistrationState,
  isBrowserPushRegistrationConfirmed,
  markBrowserPushSubscriptionRemoved,
  reconcileBrowserPushSubscription,
  startBrowserPushSubscriptionReconciliation,
  unsubscribeBrowserPushSubscription,
  type BrowserPushRegistrationDependencies,
} from './browserPushRegistration';

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createSubscription = (endpoint: string, applicationServerKey: ArrayBuffer | null = null): PushSubscription => ({
  endpoint,
  expirationTime: null,
  options: { applicationServerKey, userVisibleOnly: true },
  getKey: mock(() => null),
  toJSON: () => ({
    endpoint,
    keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` },
  }),
  unsubscribe: mock(async () => true),
} as unknown as PushSubscription);

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  } as Storage;
};

const createDependencies = (options?: {
  runtimeKey?: string;
  subscription?: PushSubscription | null;
  subscribe?: (payload: PushSubscribePayload) => Promise<{ ok: true } | null>;
  storage?: Storage | null;
}) => {
  let runtimeKey = options?.runtimeKey ?? 'runtime-a';
  let runtimeChanged: (() => void) | null = null;
  const subscription: PushSubscription | null = options && 'subscription' in options
    ? options.subscription ?? null
    : createSubscription('https://push.example/current');
  const subscribe = options?.subscribe ?? mock(async () => ({ ok: true as const }));
  const pushManager = {
    getSubscription: mock(async () => subscription),
    subscribe: mock(async () => subscription as PushSubscription),
  };
  const deps: BrowserPushRegistrationDependencies = {
    getRuntimeKey: () => runtimeKey,
    getPushAPI: () => ({
      getVapidPublicKey: mock(async () => null),
      subscribe,
    }),
    getRegistration: mock(async () => ({ pushManager }) as unknown as ServiceWorkerRegistration),
    getOrigin: () => 'https://app.example',
    getPlatform: () => 'web',
    getStorage: () => options?.storage ?? null,
    subscribeRuntimeChanged: (callback) => {
      runtimeChanged = callback;
      return () => {
        runtimeChanged = null;
      };
    },
  };

  return {
    deps,
    pushManager,
    setRuntimeKey: (value: string) => {
      runtimeKey = value;
    },
    switchRuntime: () => runtimeChanged?.(),
  };
};

describe('browser push registration reconciliation', () => {
  test('registers the existing subscription on startup and again for the switched runtime', async () => {
    const calls: Array<{ runtimeKey: string; payload: PushSubscribePayload }> = [];
    const setup = createDependencies({
      subscribe: async (payload) => {
        calls.push({ runtimeKey: setup.deps.getRuntimeKey(), payload });
        return { ok: true };
      },
    });

    const stop = startBrowserPushSubscriptionReconciliation(setup.deps);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runtimeKey).toBe('runtime-a');
    expect(isBrowserPushRegistrationConfirmed('https://push.example/current', setup.deps)).toBe(true);

    setup.setRuntimeKey('runtime-b');
    setup.switchRuntime();
    await settle();

    expect(calls.map((call) => call.runtimeKey)).toEqual(['runtime-a', 'runtime-b']);
    expect(getBrowserPushRegistrationState()).toEqual({
      runtimeKey: 'runtime-b',
      endpoint: 'https://push.example/current',
      status: 'confirmed',
    });

    stop();
  });

  test('ignores a stale registration completion after a runtime switch', async () => {
    const runtimeA = deferred<{ ok: true } | null>();
    const setup = createDependencies({
      subscribe: async () => setup.deps.getRuntimeKey() === 'runtime-a'
        ? runtimeA.promise
        : { ok: true },
    });

    const stop = startBrowserPushSubscriptionReconciliation(setup.deps);
    await settle();
    setup.setRuntimeKey('runtime-b');
    setup.switchRuntime();
    await settle();

    runtimeA.resolve({ ok: true });
    await settle();

    expect(getBrowserPushRegistrationState().runtimeKey).toBe('runtime-b');
    expect(getBrowserPushRegistrationState().status).toBe('confirmed');
    stop();
  });

  test('leaves local fallback eligible when active-runtime registration fails', async () => {
    const setup = createDependencies({ subscribe: async () => null });

    const result = await reconcileBrowserPushSubscription(setup.deps);

    expect(result).toBe(false);
    expect(getBrowserPushRegistrationState().status).toBe('failed');
    expect(isBrowserPushRegistrationConfirmed('https://push.example/current', setup.deps)).toBe(false);
  });

  test('reports a missing local subscription without registering an empty value', async () => {
    let subscribeCalls = 0;
    const subscribe = async () => {
      subscribeCalls += 1;
      return { ok: true as const };
    };
    const setup = createDependencies({ subscription: null, subscribe });
    markBrowserPushSubscriptionRemoved(setup.deps);

    const result = await reconcileBrowserPushSubscription(setup.deps);

    expect(result).toBe(false);
    expect(subscribeCalls).toBe(0);
    expect(getBrowserPushRegistrationState().status).toBe('missing');
  });

  test('replaces a subscription created with another runtime VAPID key', async () => {
    let unsubscribeCalls = 0;
    let current: PushSubscription | null = createSubscription(
      'https://push.example/runtime-a',
      new Uint8Array([9, 9, 9]).buffer,
    );
    current.unsubscribe = async () => {
      unsubscribeCalls += 1;
      current = null;
      return true;
    };
    const replacement = createSubscription(
      'https://push.example/runtime-b',
      new Uint8Array([1, 2, 3]).buffer,
    );
    let registeredEndpoint = '';
    const deps: BrowserPushRegistrationDependencies = {
      getRuntimeKey: () => 'runtime-b',
      getPushAPI: () => ({
        getVapidPublicKey: async () => ({ publicKey: 'AQID' }),
        subscribe: async (payload) => {
          registeredEndpoint = payload.endpoint;
          return { ok: true };
        },
      }),
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => current,
          subscribe: async () => {
            current = replacement;
            return replacement;
          },
        },
      }) as unknown as ServiceWorkerRegistration,
      getOrigin: () => 'https://app.example',
      getPlatform: () => 'web',
      subscribeRuntimeChanged: () => () => {},
    };

    const result = await reconcileBrowserPushSubscription(deps);

    expect(result).toBe(true);
    expect(unsubscribeCalls).toBe(1);
    expect(registeredEndpoint).toBe('https://push.example/runtime-b');
    expect(isBrowserPushRegistrationConfirmed(registeredEndpoint, deps)).toBe(true);
  });

  test('preserves subscription provenance through null, empty, or failed VAPID lookup', async () => {
    for (const transientVapidLookup of [
      async () => null,
      async () => ({ publicKey: '' }),
      async () => { throw new Error('temporary key lookup failure'); },
    ]) {
      let runtimeKey = 'runtime-transient-a';
      let authoritativeRuntimeBKey = false;
      const storage = createStorage();
      const subscription = createSubscription('https://push.example/transient-vapid');
      const replacement = createSubscription('https://push.example/transient-vapid-replacement');
      let current: PushSubscription | null = subscription;
      let unsubscribeCalls = 0;
      subscription.unsubscribe = async () => {
        unsubscribeCalls += 1;
        current = null;
        return true;
      };
      const deps: BrowserPushRegistrationDependencies = {
        getRuntimeKey: () => runtimeKey,
        getPushAPI: () => ({
          getVapidPublicKey: () => {
            if (runtimeKey === 'runtime-transient-a') return Promise.resolve({ publicKey: 'AQID' });
            if (authoritativeRuntimeBKey) return Promise.resolve({ publicKey: 'BAUG' });
            return transientVapidLookup();
          },
          subscribe: async () => ({ ok: true }),
        }),
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => current,
            subscribe: async () => {
              current = replacement;
              return replacement;
            },
          },
        }) as unknown as ServiceWorkerRegistration,
        getOrigin: () => 'https://app.example',
        getPlatform: () => 'web',
        getStorage: () => storage,
        subscribeRuntimeChanged: () => () => {},
      };

      expect(await reconcileBrowserPushSubscription(deps)).toBe(true);
      runtimeKey = 'runtime-transient-b';
      await reconcileBrowserPushSubscription(deps);
      expect(unsubscribeCalls).toBe(0);

      authoritativeRuntimeBKey = true;
      expect(await reconcileBrowserPushSubscription(deps)).toBe(true);
      expect(unsubscribeCalls).toBe(1);
    }
  });

  test('preserves an existing subscription when the browser does not expose its VAPID key', async () => {
    const subscription = createSubscription('https://push.example/null-key-existing');
    let unsubscribeCalls = 0;
    subscription.unsubscribe = async () => {
      unsubscribeCalls += 1;
      return true;
    };
    let localSubscribeCalls = 0;
    const registeredEndpoints: string[] = [];
    const deps: BrowserPushRegistrationDependencies = {
      getRuntimeKey: () => 'runtime-null-key',
      getPushAPI: () => ({
        getVapidPublicKey: async () => ({ publicKey: 'AQID' }),
        subscribe: async (payload) => {
          registeredEndpoints.push(payload.endpoint);
          return { ok: true };
        },
      }),
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => {
            localSubscribeCalls += 1;
            return createSubscription('https://push.example/unexpected-replacement');
          },
        },
      }) as unknown as ServiceWorkerRegistration,
      getOrigin: () => 'https://app.example',
      getPlatform: () => 'web',
      subscribeRuntimeChanged: () => () => {},
    };

    expect(await reconcileBrowserPushSubscription(deps)).toBe(true);

    expect(unsubscribeCalls).toBe(0);
    expect(localSubscribeCalls).toBe(0);
    expect(registeredEndpoints).toEqual(['https://push.example/null-key-existing']);
  });

  test('persists null-key provenance across a renderer reload and runtime switch', async () => {
    let runtimeKey = 'runtime-null-a';
    const storage = createStorage();
    const original = createSubscription('https://push.example/null-key-runtime-a');
    const replacement = createSubscription('https://push.example/null-key-runtime-b');
    let current: PushSubscription | null = original;
    let unsubscribeCalls = 0;
    original.unsubscribe = async () => {
      unsubscribeCalls += 1;
      current = null;
      return true;
    };
    let localSubscribeCalls = 0;
    const subscribe = async () => {
      localSubscribeCalls += 1;
      current = replacement;
      return replacement;
    };
    const registeredEndpoints: string[] = [];
    const createReloadedDependencies = (): BrowserPushRegistrationDependencies => ({
      getRuntimeKey: () => runtimeKey,
      getPushAPI: () => ({
        getVapidPublicKey: async () => ({ publicKey: runtimeKey === 'runtime-null-a' ? 'AQID' : 'BAUG' }),
        subscribe: async (payload) => {
          registeredEndpoints.push(payload.endpoint);
          return { ok: true };
        },
      }),
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => current,
          subscribe,
        },
      }) as unknown as ServiceWorkerRegistration,
      getOrigin: () => 'https://app.example',
      getPlatform: () => 'web',
      getStorage: () => storage,
      subscribeRuntimeChanged: () => () => {},
    });

    expect(await reconcileBrowserPushSubscription(createReloadedDependencies())).toBe(true);
    expect(unsubscribeCalls).toBe(0);

    runtimeKey = 'runtime-null-b';
    const reloadedRuntimeB = createReloadedDependencies();
    expect(await reconcileBrowserPushSubscription(reloadedRuntimeB)).toBe(true);
    expect(await reconcileBrowserPushSubscription(reloadedRuntimeB)).toBe(true);

    expect(unsubscribeCalls).toBe(1);
    expect(localSubscribeCalls).toBe(1);
    expect(registeredEndpoints).toEqual([
      'https://push.example/null-key-runtime-a',
      'https://push.example/null-key-runtime-b',
      'https://push.example/null-key-runtime-b',
    ]);
  });

  test('replaces a null-key subscription after VAPID rotation in the same runtime', async () => {
    const storage = createStorage();
    let publicKey = 'AQID';
    const original = createSubscription('https://push.example/rotation-old');
    const replacement = createSubscription('https://push.example/rotation-new');
    let current: PushSubscription | null = original;
    let unsubscribeCalls = 0;
    original.unsubscribe = async () => {
      unsubscribeCalls += 1;
      current = null;
      return true;
    };
    let localSubscribeCalls = 0;
    const localSubscribe = async () => {
      localSubscribeCalls += 1;
      current = replacement;
      return replacement;
    };
    const createReloadedDependencies = (): BrowserPushRegistrationDependencies => ({
      getRuntimeKey: () => 'runtime-rotation',
      getPushAPI: () => ({
        getVapidPublicKey: async () => ({ publicKey }),
        subscribe: async () => ({ ok: true }),
      }),
      getRegistration: async () => ({
        pushManager: { getSubscription: async () => current, subscribe: localSubscribe },
      }) as unknown as ServiceWorkerRegistration,
      getOrigin: () => 'https://app.example',
      getPlatform: () => 'web',
      getStorage: () => storage,
      subscribeRuntimeChanged: () => () => {},
    });

    expect(await reconcileBrowserPushSubscription(createReloadedDependencies())).toBe(true);
    publicKey = 'BAUG';
    expect(await reconcileBrowserPushSubscription(createReloadedDependencies())).toBe(true);

    expect(unsubscribeCalls).toBe(1);
    expect(localSubscribeCalls).toBe(1);
  });

  test('ignores malformed and old persisted provenance', async () => {
    const storage = createStorage();
    storage.setItem('openchamber.browserPushProvenance.v1:malformed', '{');
    storage.setItem('openchamber.browserPushProvenance.v1:old', JSON.stringify({
      version: 0,
      endpoint: 'https://push.example/malformed-storage',
      publicKey: 'CQkJ',
    }));
    storage.setItem('openchamber.browserPushProvenance.v1:invalid-key', JSON.stringify({
      version: 1,
      endpoint: 'https://push.example/malformed-storage',
      publicKey: '*',
    }));
    const subscription = createSubscription('https://push.example/malformed-storage');
    let unsubscribeCalls = 0;
    subscription.unsubscribe = async () => {
      unsubscribeCalls += 1;
      return true;
    };
    const deps: BrowserPushRegistrationDependencies = {
      getRuntimeKey: () => 'runtime-malformed-storage',
      getPushAPI: () => ({
        getVapidPublicKey: async () => ({ publicKey: 'AQID' }),
        subscribe: async () => ({ ok: true }),
      }),
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => createSubscription('https://push.example/unexpected'),
        },
      }) as unknown as ServiceWorkerRegistration,
      getOrigin: () => 'https://app.example',
      getPlatform: () => 'web',
      getStorage: () => storage,
      subscribeRuntimeChanged: () => () => {},
    };

    expect(await reconcileBrowserPushSubscription(deps)).toBe(true);
    expect(unsubscribeCalls).toBe(0);
  });

  test('does not delete the server registration when local unsubscribe fails', async () => {
    for (const localUnsubscribe of [
      async () => false,
      async () => { throw new Error('browser unsubscribe failed'); },
    ]) {
      const subscription = createSubscription('https://push.example/unsubscribe-failed');
      subscription.unsubscribe = mock(localUnsubscribe);
      const setup = createDependencies({ subscription });
      let serverUnsubscribeCalls = 0;
      const serverUnsubscribe = async () => {
        serverUnsubscribeCalls += 1;
        return { ok: true as const };
      };

      const result = await unsubscribeBrowserPushSubscription(
        subscription,
        { unsubscribe: serverUnsubscribe },
        setup.deps,
      );

      expect(result).toBe('local-failed');
      expect(serverUnsubscribeCalls).toBe(0);
      expect(getBrowserPushRegistrationState()).toEqual({
        runtimeKey: 'runtime-a',
        endpoint: 'https://push.example/unsubscribe-failed',
        status: 'confirmed',
      });
    }
  });

  test('preserves an already confirmed registration when unsubscribe returns false', async () => {
    const subscription = createSubscription('https://push.example/unsubscribe-confirmed');
    subscription.unsubscribe = async () => false;
    let subscribeCalls = 0;
    const setup = createDependencies({
      subscription,
      subscribe: async () => {
        subscribeCalls += 1;
        return { ok: true };
      },
    });
    expect(await reconcileBrowserPushSubscription(setup.deps)).toBe(true);
    const serverUnsubscribeCalls: Array<{ endpoint: string }> = [];

    const result = await unsubscribeBrowserPushSubscription(
      subscription,
      {
        unsubscribe: async (payload) => {
          serverUnsubscribeCalls.push(payload);
          return { ok: true };
        },
      },
      setup.deps,
    );

    expect(result).toBe('local-failed');
    expect(subscribeCalls).toBe(1);
    expect(serverUnsubscribeCalls).toEqual([]);
    expect(getBrowserPushRegistrationState()).toEqual({
      runtimeKey: 'runtime-a',
      endpoint: subscription.endpoint,
      status: 'confirmed',
    });
  });

  test('reports server cleanup failure after the local subscription is removed', async () => {
    const storage = createStorage();
    const subscription = createSubscription('https://push.example/server-cleanup-failed');
    const setup = createDependencies({ subscription, storage });
    const serverUnsubscribeCalls: Array<{ endpoint: string }> = [];
    const serverUnsubscribe = async (payload: { endpoint: string }) => {
      serverUnsubscribeCalls.push(payload);
      return null;
    };

    const result = await unsubscribeBrowserPushSubscription(
      subscription,
      { unsubscribe: serverUnsubscribe },
      setup.deps,
    );

    expect(result).toBe('server-failed');
    expect(serverUnsubscribeCalls).toEqual([{ endpoint: subscription.endpoint }]);
    expect(getBrowserPushRegistrationState().status).toBe('missing');
  });
});
