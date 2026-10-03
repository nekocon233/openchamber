import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ClaudeConnection } from '@/lib/native-agents/connections';
import type { ProviderResult } from '@/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { useQuotaStore } from './useQuotaStore';

const id = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const quotaId = `kimi-claude:${id}`;
const connection = (revision = 1): ClaudeConnection => ({
  id, kind: 'anthropic', name: 'Kimi account', baseURL: 'https://api.kimi.ai/coding/', auth: 'api-key', hasKey: true, revision,
  quotaProviderId: quotaId,
  models: [{ id, name: 'Kimi', modelID: 'kimi-for-coding', contextWindow: 262144, outputLimit: 32000, input: { image: false, pdf: false }, efforts: [] }],
});
const quota = (percent: number): ProviderResult => ({
  providerId: quotaId, providerName: 'Kimi account / Claude Code', configured: true, ok: true, fetchedAt: 1,
  usage: { windows: { weekly: { usedPercent: percent, remainingPercent: 100 - percent, windowSeconds: null, resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null } } },
});
const deferred = <T>() => {
  let complete: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, complete };
};
let connections: ClaudeConnection[];
let fail = false;
let discoveryCalls = 0;
let requests: (url: string) => Promise<Response>;
const fetcher = spyOn(globalThis, 'fetch');
afterAll(() => fetcher.mockRestore());
beforeEach(() => {
  useQuotaStore.getState().resetForRuntimeSwitch();
  connections = [connection()]; fail = false; discoveryCalls = 0;
  requests = async () => Response.json(quota(10));
  fetcher.mockImplementation((url) => requests(url.toString()));
  registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ listClaudeConnections: async () => {
    discoveryCalls++;
    if (fail) throw new Error('Connection list unavailable');
    return connections;
  } })));
});
afterEach(() => { registerRuntimeAPIs(null); useQuotaStore.getState().resetForRuntimeSwitch(); fetcher.mockReset(); });

describe('native connection quota identity', () => {
  test('discovers a distinct quota source and leaves explicit display choices intact', async () => {
    await useQuotaStore.getState().loadNativeProviders();
    expect(useQuotaStore.getState().nativeProviders).toEqual([{ id: quotaId, name: 'Kimi account / Claude Code', revision: 1 }]);
    expect(useQuotaStore.getState().dropdownProviderIds).toContain(quotaId);
    useQuotaStore.getState().setDropdownProviderIds(['claude']);
    connections = [connection(2)];
    await useQuotaStore.getState().loadNativeProviders(true);
    expect(useQuotaStore.getState().dropdownProviderIds).toEqual(['claude']);
  });

  test('disabled native quotas add no periodic discovery or provider requests', async () => {
    useQuotaStore.getState().setDropdownProviderIds([]);
    expect(await useQuotaStore.getState().refreshSelectedQuotas()).toBe(false);
    expect(discoveryCalls).toBe(0);
    expect(fetcher.mock.calls).toHaveLength(0);
    useQuotaStore.getState().setDropdownProviderIds(['claude']);
    requests = async () => Response.json({ ...quota(10), providerId: 'claude' });
    await useQuotaStore.getState().refreshSelectedQuotas();
    expect(discoveryCalls).toBe(0);
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  test('a failed connection read keeps the previous quota and metadata', async () => {
    await useQuotaStore.getState().loadNativeProviders();
    await useQuotaStore.getState().fetchProviderQuota(quotaId);
    const before = useQuotaStore.getState(); fail = true;
    await useQuotaStore.getState().loadNativeProviders(true);
    expect(useQuotaStore.getState().nativeProviders).toBe(before.nativeProviders);
    expect(useQuotaStore.getState().results).toBe(before.results);
    expect(useQuotaStore.getState().error).toBe('Connection list unavailable');
  });

  test('changing credentials rejects an older in-flight quota even when the transport ignores abort', async () => {
    await useQuotaStore.getState().loadNativeProviders();
    const old = deferred<Response>();
    const started = deferred<void>();
    requests = async () => { started.complete(); return old.promise; };
    const pending = useQuotaStore.getState().fetchProviderQuota(quotaId);
    await started.promise;
    connections = [connection(2)];
    await useQuotaStore.getState().loadNativeProviders(true);
    requests = async () => Response.json(quota(5));
    await useQuotaStore.getState().fetchProviderQuota(quotaId);
    old.complete(Response.json(quota(99)));
    await pending;
    expect(useQuotaStore.getState().results[0].usage?.windows.weekly.usedPercent).toBe(5);
  });

  test('a deleted connection drops only its own result and selection', async () => {
    await useQuotaStore.getState().loadNativeProviders();
    await useQuotaStore.getState().fetchProviderQuota(quotaId);
    useQuotaStore.getState().setSelectedProvider(quotaId);
    connections = [];
    await useQuotaStore.getState().loadNativeProviders(true);
    expect(useQuotaStore.getState().nativeProviders).toEqual([]);
    expect(useQuotaStore.getState().results).toEqual([]);
    expect(useQuotaStore.getState().selectedProviderId).toBeNull();
    expect(useQuotaStore.getState().dropdownProviderIds).toContain('claude');
    expect(useQuotaStore.getState().dropdownProviderIds).not.toContain(quotaId);
  });

  test('old-runtime discovery cannot add a connection to the next runtime', async () => {
    const old = deferred<ClaudeConnection[]>();
    registerRuntimeAPIs(createTestRuntimeAPIs(createTestNativeAgentsAPI({ listClaudeConnections: () => old.promise })));
    const loading = useQuotaStore.getState().loadNativeProviders();
    useQuotaStore.getState().resetForRuntimeSwitch();
    old.complete([connection()]); await loading;
    expect(useQuotaStore.getState().nativeProviders).toEqual([]);
  });
});
