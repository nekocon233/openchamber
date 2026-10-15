import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, NativeCapabilities } from '@/lib/api/types';
import type { NativePlanSnapshot } from '@/lib/native-agents/task-schemas';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { NativePlanState } from './session-native-plan';

// Install the event target before the owner's runtime-lifecycle subscription.
const dom = installHookTestDom();
const {
  clearSessionNativePlan, loadSessionNativePlan, markSessionNativePlansStale, refreshSessionNativePlan, useSessionNativePlan,
} = await import('./session-native-plan');

const SESSION = 'ncx_plan';
const OTHER = 'ncx_other';
const CLAUDE = 'ncl_claude';
const DIRECTORY = '/repo';
const capabilities: NativeCapabilities = {
  supported: true,
  backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true, tasks: { plan: true } } },
  registry: { reset: false },
};
const plan = (text = '# Ship it'): NativePlanSnapshot => ({ state: 'ready', observedAt: 7, text, truncated: false, turnId: 'turn-1' });
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
let root: ReturnType<typeof createRoot>;
let api: NativeAgentsAPI;
let planCalls: string[];
const states = new Map<string, NativePlanState>();

function Probe({ session = SESSION, directory = DIRECTORY, visible = false }: { session?: string; directory?: string; visible?: boolean }) {
  const state = useSessionNativePlan(session, directory, { visible });
  states.set(`${directory}:${session}`, state);
  return null;
}
const render = async (children: React.ReactNode) => {
  const apis = createTestRuntimeAPIs(api);
  registerRuntimeAPIs(apis);
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}>{children}</RuntimeAPIContext.Provider>));
};
const held = (session = SESSION): NativePlanState => {
  const state = states.get(`${DIRECTORY}:${session}`);
  if (!state) throw new Error('Probe not mounted');
  return state;
};
const heldPlan = (session = SESSION) => {
  const state = held(session);
  if (!('plan' in state) || !state.plan) throw new Error('No plan held');
  return state.plan;
};

beforeEach(() => {
  root = createRoot(dom.container);
  states.clear();
  planCalls = [];
  api = createTestNativeAgentsAPI({
    capabilities: async () => capabilities,
    plan: async (sessionId) => { planCalls.push(sessionId); return plan(); },
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  switchRuntimeEndpoint({ apiBaseUrl: 'http://plan.test', runtimeKey: 'plan' });
  await pause();
});
afterAll(() => dom.restore());

describe('native plan owner', () => {
  test('reads the plan of a Codex session that has one', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    expect(held().status).toBe('ready');
    expect(heldPlan()).toMatchObject({ state: 'ready', text: '# Ship it', turnId: 'turn-1' });
  });

  test('a thread without a plan is its own state, not an empty or failed read', async () => {
    api = createTestNativeAgentsAPI({ capabilities: async () => capabilities, plan: async () => ({ state: 'empty' }) });
    await render(<Probe visible />);
    await act(() => pause());
    expect(held().status).toBe('empty');
  });

  test('a failed read is an error, and a later one keeps the plan it already had', async () => {
    let failing = false;
    api = createTestNativeAgentsAPI({
      capabilities: async () => capabilities,
      plan: async () => { if (failing) throw new Error('boom'); return plan(); },
    });
    await render(<Probe visible />);
    await act(() => pause());
    expect(held().status).toBe('ready');
    failing = true;
    await act(async () => { await loadSessionNativePlan(SESSION, DIRECTORY); });
    expect(held().status).toBe('stale');
    expect(heldPlan()).toMatchObject({ text: '# Ship it' });
  });

  test('a server without the Codex plan view is never asked for one', async () => {
    api = createTestNativeAgentsAPI({
      capabilities: async () => ({ ...capabilities, backends: { ...capabilities.backends, codex: { cli: true } } }),
      plan: async () => { planCalls.push(SESSION); return plan(); },
    });
    await render(<Probe visible />);
    await act(() => pause());
    expect(held().status).toBe('unsupported');
    expect(planCalls).toEqual([]);
  });

  test('a Claude session reports unsupported without a request', async () => {
    await render(<Probe session={CLAUDE} visible />);
    await act(() => pause());
    expect(held(CLAUDE).status).toBe('unsupported');
    expect(planCalls).toEqual([]);
  });

  test('a settled turn reloads only the session it names', async () => {
    await render(<><Probe visible /><Probe session={OTHER} visible /></>);
    await act(() => pause());
    planCalls.length = 0;
    refreshSessionNativePlan(OTHER, DIRECTORY);
    await act(() => pause());
    expect(planCalls).toEqual([OTHER]);
  });

  test('a session nobody opened allocates nothing when its turn settles', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    planCalls.length = 0;
    refreshSessionNativePlan(OTHER, DIRECTORY);
    await act(() => pause());
    expect(planCalls).toEqual([]);
  });

  test('connection loss keeps the plan and marks it stale', async () => {
    await render(<Probe visible />);
    await act(() => pause());
    await act(() => { markSessionNativePlansStale(); });
    expect(held().status).toBe('stale');
    expect(heldPlan()).toMatchObject({ text: '# Ship it' });
  });

  test('clearing one session leaves another alone', async () => {
    await render(<><Probe visible /><Probe session={OTHER} visible /></>);
    await act(() => pause());
    await act(() => { clearSessionNativePlan(SESSION, DIRECTORY, getRuntimeKey()); });
    await act(() => pause());
    expect(held(SESSION).status).toBe('idle');
    expect(held(OTHER).status).toBe('ready');
  });
});
