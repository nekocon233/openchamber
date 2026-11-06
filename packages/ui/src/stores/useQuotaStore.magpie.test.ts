import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import type { ProviderResult } from '@/types';
import { useQuotaStore } from './useQuotaStore';

const result = (fetchedAt = 1): ProviderResult => ({
  providerId: 'magpie', providerName: 'Magpie', configured: true, ok: true, fetchedAt,
  usage: { windows: {}, accounts: [{ id: 'account', providerId: 'custom', providerName: 'Custom',
    accountLabel: 'work', planLabel: null, sampledAt: 1, error: null, windows: {} }] },
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const network = spyOn(globalThis, 'fetch');
afterAll(() => network.mockRestore());
afterEach(() => { useQuotaStore.getState().resetForRuntimeSwitch(); network.mockReset(); });

test('automatic Magpie batches read cache while explicit refreshes POST, coalescing readouts', async () => {
  let complete: (response: Response) => void = () => {};
  network.mockImplementation(async (_input, init) => {
    if (init?.method === 'POST') return new Promise(resolve => { complete = resolve; });
    return Response.json(result());
  });
  const state = useQuotaStore.getState();
  await state.fetchQuotas(['magpie']);
  expect(network.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([['/api/quota/magpie', undefined]]);
  const first = state.fetchQuotas(['magpie'], { manual: true });
  const second = state.fetchQuotas(['magpie'], { manual: true });
  await flush();
  const automatic = state.fetchQuotas(['magpie']);
  await flush();
  expect(network.mock.calls).toHaveLength(2);
  expect(network.mock.calls[1][0]).toBe('/api/quota/magpie/refresh');
  expect(network.mock.calls[1][1]?.method).toBe('POST');
  complete(Response.json(result(2)));
  await Promise.all([first, second, automatic]);
  expect(useQuotaStore.getState().results[0].fetchedAt).toBe(2);
});

test('a late automatic cache cannot overwrite a manually refreshed Magpie snapshot', async () => {
  let complete: (response: Response) => void = () => {};
  network.mockImplementation(async (_input, init) => init?.method === 'POST'
    ? Response.json(result(2)) : new Promise(resolve => { complete = resolve; }));
  const automatic = useQuotaStore.getState().fetchQuotas(['magpie']);
  await flush();
  await useQuotaStore.getState().fetchQuotas(['magpie'], { manual: true });
  complete(Response.json(result(1)));
  await automatic;
  expect(useQuotaStore.getState().results[0].fetchedAt).toBe(2);
});

test('overall Magpie failure retains the previous accounts and error while successful emptiness clears them', async () => {
  network.mockResolvedValue(Response.json(result()));
  await useQuotaStore.getState().fetchQuotas(['magpie']);
  const accounts = useQuotaStore.getState().results[0].usage?.accounts;
  network.mockImplementation(async () => Response.json({ ...result(2), ok: false, usage: null, error: 'MAGPIE_UNAVAILABLE' }));
  await useQuotaStore.getState().fetchQuotas(['magpie'], { manual: true });
  expect(useQuotaStore.getState().results[0]).toMatchObject({ ok: false, error: 'MAGPIE_UNAVAILABLE' });
  expect(useQuotaStore.getState().results[0].usage?.accounts).toBe(accounts);
  network.mockImplementation(async () => Response.json({ ...result(3), usage: { windows: {}, accounts: [] } }));
  await useQuotaStore.getState().fetchQuotas(['magpie']);
  expect(useQuotaStore.getState().results[0].usage?.accounts).toEqual([]);
  expect(useQuotaStore.getState().refreshErrors.magpie).toBeUndefined();
});

test('a runtime switch rejects an old Magpie response and clears account data', async () => {
  let complete: (response: Response) => void = () => {};
  network.mockImplementation(async () => new Promise(resolve => { complete = resolve; }));
  const automatic = useQuotaStore.getState().fetchQuotas(['magpie']);
  await flush();
  useQuotaStore.getState().resetForRuntimeSwitch();
  complete(Response.json(result()));
  await automatic;
  expect(useQuotaStore.getState().results).toEqual([]);
});
