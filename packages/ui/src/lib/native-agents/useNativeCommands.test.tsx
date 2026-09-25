import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { NativeCommandList } from '@/lib/api/types';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from './test-utils/runtime';
import { useNativeCommands } from './useNativeCommands';

let dom: ReturnType<typeof installHookTestDom>;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { dom = installHookTestDom(); root = createRoot(dom.container); });
afterEach(async () => { await act(() => root.unmount()); dom.restore(); });

const list = (name: string): NativeCommandList => ({ commands: [{ name, description: name, argumentHint: '' }] });

describe('native command discovery ownership', () => {
  test('discards a late directory response and reloads the same directory after a runtime switch', async () => {
    const requests: Array<{ directory: string; signal?: AbortSignal; resolve: (list: NativeCommandList) => void }> = [];
    const api = createTestNativeAgentsAPI({ commands: (_backend, directory, options) => new Promise<NativeCommandList>((resolve) => {
      requests.push({ directory, signal: options?.signal, resolve });
    }) });
    const apis = createTestRuntimeAPIs(api);
    let latest: ReturnType<typeof useNativeCommands> = { status: 'loading' };
    function Probe({ directory }: { directory: string }) {
      const state = useNativeCommands('codex', directory);
      latest = state;
      return <div>{state.status === 'ready' ? state.commands.map((entry) => entry.name).join(',') : state.status}</div>;
    }
    const render = (directory: string) => root.render(<RuntimeAPIContext.Provider value={apis}><Probe directory={directory} /></RuntimeAPIContext.Provider>);
    await act(() => render('/work/a'));
    await act(() => render('/work/b'));
    expect(requests.map((entry) => entry.directory)).toEqual(['/work/a', '/work/b']);
    expect(requests[0].signal?.aborted).toBe(true);
    await act(async () => { requests[1].resolve(list('current')); });
    await act(async () => { requests[0].resolve(list('stale')); });
    expect(latest).toMatchObject({ status: 'ready', commands: list('current').commands });

    await act(() => switchRuntimeEndpoint({ apiBaseUrl: 'http://native-commands.test', runtimeKey: 'native-commands-next' }));
    expect(requests).toHaveLength(3);
    expect(latest).toEqual({ status: 'loading' });
    await act(async () => { requests[2].resolve(list('next-runtime')); });
    expect(latest).toMatchObject({ status: 'ready', commands: list('next-runtime').commands });
  });

  test('keeps an inactive result referentially stable and makes no discovery requests', async () => {
    const results: Array<ReturnType<typeof useNativeCommands>> = [];
    const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({}));
    function Probe({ marker }: { marker: number }) {
      results.push(useNativeCommands(null, null));
      return <div>{marker}</div>;
    }
    await act(() => root.render(<RuntimeAPIContext.Provider value={apis}><Probe marker={1} /></RuntimeAPIContext.Provider>));
    await act(() => root.render(<RuntimeAPIContext.Provider value={apis}><Probe marker={2} /></RuntimeAPIContext.Provider>));
    expect(results[0]).toEqual({ status: 'ready', commands: [] });
    expect(results[1]).toBe(results[0]);
  });
});
