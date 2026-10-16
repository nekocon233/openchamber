import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
const clearedPendingPolicies: Array<[string, string]> = [];
const restoredPendingPolicies: Array<[string, boolean, string]> = [];
const supersededPendingPolicies: Array<[string, string]> = [];
let supersededPendingPolicyResult: Promise<void> | null = null;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => new Map() }));
mock.module('@/sync/session-ui-store', () => ({
  clearPendingDraftPermissionPolicy: (sessionId: string, runtimeKey: string) => {
    clearedPendingPolicies.push([sessionId, runtimeKey]);
  },
  setPendingDraftPermissionPolicy: (sessionId: string, enabled: boolean, runtimeKey: string) => {
    restoredPendingPolicies.push([sessionId, enabled, runtimeKey]);
  },
  supersedePendingDraftPermissionPolicy: (sessionId: string, runtimeKey: string) => {
    supersededPendingPolicies.push([sessionId, runtimeKey]);
    return supersededPendingPolicyResult;
  },
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => '/project' }) },
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { getDirectory: () => '/fallback' },
}));

const { usePermissionStore } = await import('./permissionStore');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('permission store server policy', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset();
    usePermissionStore.setState({ legacyCandidate: null, legacyRuntimeKey: null });
    clearedPendingPolicies.length = 0;
    restoredPendingPolicies.length = 0;
    supersededPendingPolicies.length = 0;
    supersededPendingPolicyResult = null;
    fetchImpl = async () => json({ sessions: {} });
  });

  test('hydrates the authoritative server snapshot', async () => {
    fetchImpl = async () => json({ sessions: { root: true } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
  });

  test('reads modes when the server has them and on/off as auto/ask when it does not', async () => {
    fetchImpl = async () => json({ sessions: { root: true, off: false }, modes: { root: 'safety', off: 'ask' }, revision: 1 });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'safety', off: 'ask' });
    expect(usePermissionStore.getState().getSessionMode('root')).toBe('safety');

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ sessions: { root: true, off: false } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto', off: 'ask' });
  });

  test('answers the authoritative default for a session outside the policy', async () => {
    fetchImpl = async () => json({ sessions: {}, defaultEnabled: true, revision: 1 });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().getSessionMode('unlisted')).toBe('auto');

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ sessions: {}, defaultEnabled: false, revision: 1 });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().getSessionMode('unlisted')).toBe('ask');
  });

  test('preserves previous state when hydration fails', async () => {
    usePermissionStore.setState({ modes: { root: 'auto' }, loaded: true });
    fetchImpl = async () => json({}, 503);
    await expect(usePermissionStore.getState().hydrate()).rejects.toThrow();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
  });

  test('updates local state only after server persistence succeeds', async () => {
    fetchImpl = async () => json({}, 500);
    await expect(usePermissionStore.getState().setSessionMode('root', 'auto')).rejects.toThrow();
    expect(usePermissionStore.getState().modes).toEqual({});
  });

  test('sends the session directory for immediate pending reconciliation', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ sessions: { root: true } });
    };
    await usePermissionStore.getState().setSessionMode('root', 'auto');
    expect(body).toEqual({ mode: 'auto', enabled: true, directory: '/project' });
    expect(clearedPendingPolicies).toHaveLength(1);
    expect(clearedPendingPolicies[0]?.[0]).toBe('root');
  });

  test('holds an opt-out as a pending draft policy until its own write succeeds', async () => {
    fetchImpl = async () => json({ sessions: { root: false } });
    await usePermissionStore.getState().setSessionMode('root', 'ask');

    expect(restoredPendingPolicies).toHaveLength(1);
    expect(restoredPendingPolicies[0]?.[0]).toBe('root');
    expect(restoredPendingPolicies[0]?.[1]).toBe(false);
    expect(clearedPendingPolicies).toHaveLength(1);
    expect(usePermissionStore.getState().modes).toEqual({ root: 'ask' });
  });

  test('a draft write keeps its own intent instead of superseding or clearing it', async () => {
    fetchImpl = async () => json({ sessions: { root: true } });
    await usePermissionStore.getState().setSessionMode('root', 'auto', { preservePendingDraftIntent: true });

    expect(supersededPendingPolicies).toHaveLength(0);
    expect(restoredPendingPolicies).toHaveLength(0);
    expect(clearedPendingPolicies).toHaveLength(0);
  });

  test('waits for the superseded pending draft write before issuing its own request', async () => {
    let resolveSuperseded!: () => void;
    supersededPendingPolicyResult = new Promise<void>((resolve) => {
      resolveSuperseded = resolve;
    });
    let requests = 0;
    fetchImpl = async () => {
      requests += 1;
      return json({ sessions: { root: true } });
    };

    const mutation = usePermissionStore.getState().setSessionMode('root', 'auto');
    await Promise.resolve();
    expect(requests).toBe(0);
    expect(supersededPendingPolicies).toHaveLength(1);

    resolveSuperseded();
    await mutation;
    expect(requests).toBe(1);
  });

  test('serializes conflicting explicit writes for the same session in user intent order', async () => {
    let resolveSuperseded!: () => void;
    supersededPendingPolicyResult = new Promise<void>((resolve) => {
      resolveSuperseded = resolve;
    });
    const resolvers: Array<(response: Response) => void> = [];
    const requestedModes: string[] = [];
    fetchImpl = async (_input, init) => {
      requestedModes.push((JSON.parse(String(init?.body)) as { mode: string }).mode);
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    };

    const enable = usePermissionStore.getState().setSessionMode('root', 'auto');
    const disable = usePermissionStore.getState().setSessionMode('root', 'ask');
    await Promise.resolve();
    expect(requestedModes).toEqual([]);

    resolveSuperseded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedModes).toEqual(['auto']);

    resolvers[0](json({ sessions: { root: true }, revision: 1 }));
    await enable;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestedModes).toEqual(['auto', 'ask']);

    resolvers[1](json({ sessions: { root: false }, revision: 2 }));
    await disable;

    expect(usePermissionStore.getState().modes).toEqual({ root: 'ask' });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('migrates a legacy local policy when the server has no policy yet', async () => {
    usePermissionStore.setState({ legacyCandidate: { root: true }, legacyRuntimeKey: null });
    const requests: string[] = [];
    fetchImpl = async (input) => {
      requests.push(input);
      return input.includes('/sessions/')
        ? json({ sessions: { root: true } })
        : json({ sessions: {} });
    };
    await usePermissionStore.getState().hydrate();
    expect(requests).toEqual(['/api/permission-auto-accept', '/api/permission-auto-accept/sessions/root']);
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
    expect(usePermissionStore.getState().legacyCandidate).toBe(null);
  });

  test('rejects a hydration response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    fetchImpl = async () => oldResponse;
    const oldHydration = usePermissionStore.getState().hydrate();

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ sessions: { current: true }, revision: 2 });
    await usePermissionStore.getState().hydrate();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await oldHydration;

    expect(usePermissionStore.getState().modes).toEqual({ current: 'auto' });
  });

  test('rejects a mutation response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveOld = resolve; });
    const mutation = usePermissionStore.getState().setSessionMode('stale', 'auto');

    usePermissionStore.getState().reset();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await mutation;

    expect(usePermissionStore.getState().modes).toEqual({});
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('keeps the highest authoritative revision when mutations resolve out of order', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchImpl = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    const first = usePermissionStore.getState().setSessionMode('first', 'auto');
    const second = usePermissionStore.getState().setSessionMode('second', 'auto');

    resolvers[1](json({ sessions: { first: true, second: true }, revision: 2 }));
    await second;
    resolvers[0](json({ sessions: { first: true }, revision: 1 }));
    await first;

    expect(usePermissionStore.getState().modes).toEqual({ first: 'auto', second: 'auto' });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('ignores an older broadcast revision', () => {
    usePermissionStore.getState().applySnapshot({ modes: { current: 'auto' }, defaultEnabled: true, revision: 4 });
    usePermissionStore.getState().applySnapshot({ modes: { stale: 'auto' }, defaultEnabled: true, revision: 3 });

    expect(usePermissionStore.getState().modes).toEqual({ current: 'auto' });
  });
});
