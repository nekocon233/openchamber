import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
const sessionById = new Map<string, Session>();
const clearedPendingPolicies: Array<[string, string]> = [];
const restoredPendingPolicies: Array<[string, boolean, string]> = [];
const supersededPendingPolicies: Array<[string, string]> = [];
let supersededPendingPolicyResult: Promise<void> | null = null;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => sessionById }));
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
    sessionById.clear();
    clearedPendingPolicies.length = 0;
    restoredPendingPolicies.length = 0;
    supersededPendingPolicies.length = 0;
    supersededPendingPolicyResult = null;
    fetchImpl = async () => json({ sessions: {} });
  });

  test('hydrates the authoritative server snapshot', async () => {
    fetchImpl = async () => json({ sessions: { root: true }, defaultEnabled: true });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().defaultEnabled).toBe(true);
  });

  test('uses the authoritative default for a known unconfigured session', async () => {
    sessionById.set('root', { id: 'root' } as Session);
    fetchImpl = async () => json({ sessions: {}, defaultEnabled: true });

    await usePermissionStore.getState().hydrate();

    expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(true);
  });

  test('keeps unconfigured sessions disabled when an older owner omits the default', async () => {
    sessionById.set('root', { id: 'root' } as Session);
    fetchImpl = async () => json({ sessions: {} });

    await usePermissionStore.getState().hydrate();

    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
    expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(false);
  });

  test('preserves previous state when hydration fails', async () => {
    usePermissionStore.setState({ autoAccept: { root: true }, loaded: true });
    fetchImpl = async () => json({}, 503);
    await expect(usePermissionStore.getState().hydrate()).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
  });

  test('updates local state only after server persistence succeeds', async () => {
    fetchImpl = async () => json({}, 500);
    await expect(usePermissionStore.getState().setSessionAutoAccept('root', true)).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({});
  });

  test('restores a failed explicit disable as a send-blocking retry intent', async () => {
    fetchImpl = async () => json({}, 500);

    await expect(usePermissionStore.getState().setSessionAutoAccept('root', false)).rejects.toThrow();

    expect(restoredPendingPolicies).toHaveLength(1);
    expect(restoredPendingPolicies[0]?.slice(0, 2)).toEqual(['root', false]);
  });

  test('waits for an older draft-policy retry before sending an explicit override', async () => {
    let resolveSuperseded!: () => void;
    supersededPendingPolicyResult = new Promise<void>((resolve) => {
      resolveSuperseded = resolve;
    });
    let requests = 0;
    fetchImpl = async () => {
      requests += 1;
      return json({ sessions: { root: true } });
    };

    const mutation = usePermissionStore.getState().setSessionAutoAccept('root', true);
    await Promise.resolve();
    expect(requests).toBe(0);

    resolveSuperseded();
    await mutation;
    expect(requests).toBe(1);
    expect(supersededPendingPolicies).toHaveLength(1);
  });

  test('sends the session directory for immediate pending reconciliation', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ sessions: { root: true } });
    };
    await usePermissionStore.getState().setSessionAutoAccept('root', true);
    expect(body).toEqual({ enabled: true, directory: '/project' });
    expect(clearedPendingPolicies).toHaveLength(1);
    expect(clearedPendingPolicies[0]?.[0]).toBe('root');
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
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
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

    expect(usePermissionStore.getState().autoAccept).toEqual({ current: true });
  });

  test('rejects a mutation response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveOld = resolve; });
    const mutation = usePermissionStore.getState().setSessionAutoAccept('stale', true);

    usePermissionStore.getState().reset();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await mutation;

    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('keeps the highest authoritative revision when mutations resolve out of order', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchImpl = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    const first = usePermissionStore.getState().setSessionAutoAccept('first', true);
    const second = usePermissionStore.getState().setSessionAutoAccept('second', true);

    resolvers[1](json({ sessions: { first: true, second: true }, revision: 2 }));
    await second;
    resolvers[0](json({ sessions: { first: true }, revision: 1 }));
    await first;

    expect(usePermissionStore.getState().autoAccept).toEqual({ first: true, second: true });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('serializes conflicting explicit writes for the same session in user intent order', async () => {
    let resolveSuperseded!: () => void;
    supersededPendingPolicyResult = new Promise<void>((resolve) => {
      resolveSuperseded = resolve;
    });
    const resolvers: Array<(response: Response) => void> = [];
    const enabledRequests: boolean[] = [];
    fetchImpl = async (_input, init) => {
      enabledRequests.push((JSON.parse(String(init?.body)) as { enabled: boolean }).enabled);
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    };

    const enable = usePermissionStore.getState().setSessionAutoAccept('root', true);
    const disable = usePermissionStore.getState().setSessionAutoAccept('root', false);
    await Promise.resolve();
    expect(enabledRequests).toEqual([]);

    resolveSuperseded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enabledRequests).toEqual([true]);

    resolvers[0](json({ sessions: { root: true }, revision: 1 }));
    await enable;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enabledRequests).toEqual([true, false]);

    resolvers[1](json({ sessions: { root: false }, revision: 2 }));
    await disable;

    expect(usePermissionStore.getState().autoAccept).toEqual({ root: false });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('ignores an older broadcast revision', () => {
    usePermissionStore.getState().applySnapshot({ sessions: { current: true }, defaultEnabled: true, revision: 4 });
    usePermissionStore.getState().applySnapshot({ sessions: { stale: true }, defaultEnabled: true, revision: 3 });

    expect(usePermissionStore.getState().autoAccept).toEqual({ current: true });
  });
});
