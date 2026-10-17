import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  PointerEvent: browser.PointerEvent ?? browser.MouseEvent,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/lib/guests/load-catalog', () => ({ loadGuestCatalog: async () => [] }));
mock.module('@/stores/useAgentMemoryStore', () => ({
  useAgentMemoryStore: { getState: () => ({ refresh: async () => {} }) },
}));

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { createTestNativeAgentsAPI } = await import('@/lib/native-agents/test-utils/runtime');
const { useUIStore } = await import('@/stores/useUIStore');
const { OpenChamberToolsSettings } = await import('./OpenChamberToolsSettings');
import type { NativeMemoryStatus } from '@/lib/native-agents/memory-schemas';
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const backend = (overrides: Partial<Extract<NativeMemoryStatus['backends'][number], { status: 'ok' }>> = {}) => ({
  status: 'ok' as const,
  backend: 'claude' as const,
  installed: false,
  ready: false,
  reviewRequired: false,
  lastSeen: null,
  ...overrides,
});

const memoryStatus = (overrides: Partial<NativeMemoryStatus> = {}): NativeMemoryStatus => ({
  enabled: true,
  canManage: true,
  backends: [backend(), backend({ backend: 'codex' })],
  progress: [],
  sources: [],
  ...overrides,
});

const runtimeApis = (
  nativeAgents: ReturnType<typeof createTestNativeAgentsAPI>,
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload> = async (changes) => {
    // SAFETY: The test runtime treats the accepted partial write as the full settings document.
    return changes as SettingsPayload;
  },
): RuntimeAPIs => ({
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  nativeAgents,
  settings: {
    load: async () => ({ settings: {}, source: 'web' }),
    save,
  },
  get terminal(): never { throw new Error('terminal not available'); },
  get git(): never { throw new Error('git not available'); },
  get files(): never { throw new Error('files not available'); },
  get permissions(): never { throw new Error('permissions not available'); },
  get notifications(): never { throw new Error('notifications not available'); },
  get sourceControl(): never { throw new Error('sourceControl not available'); },
  get sidebarState(): never { throw new Error('sidebarState not available'); },
  get followUpQueue(): never { throw new Error('followUpQueue not available'); },
});

let root: Root;
let host: HTMLDivElement;

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

const renderSettings = async (apis: RuntimeAPIs, enabled: boolean) => {
  useUIStore.setState({ agentMemoryFeatureAvailable: true, agentMemoryToolEnabled: enabled });
  registerRuntimeAPIs(apis);
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={apis}>
      <I18nProvider><OpenChamberToolsSettings /></I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));
};

const memorySwitch = () => {
  const control = host.querySelector('[role="switch"][aria-label="Agent memory tool"]');
  if (!control) throw new Error('memory switch not found');
  return control;
};

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  registerRuntimeAPIs(null);
  host.remove();
  document.body.replaceChildren();
  useUIStore.setState({ agentMemoryFeatureAvailable: false, agentMemoryToolEnabled: false });
  jest.useRealTimers();
});

test('connects missing hooks only after the settings write lands', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const native = createTestNativeAgentsAPI({
    memoryStatus: async () => memoryStatus(),
    connectMemory: async (backend) => {
      calls.push(backend);
      return { backend, installed: true, ready: false, reviewRequired: false, lastSeen: null };
    },
  });
  const saveCalls: Partial<SettingsPayload>[] = [];
  await renderSettings(runtimeApis(native, async (changes) => {
    saveCalls.push(changes);
    await gate.promise;
    return changes;
  }), false);

  await act(async () => {
    memorySwitch().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    jest.advanceTimersByTime(200);
  });
  expect(saveCalls).toEqual([{ agentMemoryToolEnabled: true }]);
  expect(calls).toEqual([]);

  gate.resolve();
  await flush();
  expect(calls).toEqual(['claude', 'codex']);
});

test('auto-connects only missing backends when the page opens with memory enabled', async () => {
  const calls: string[] = [];
  const native = createTestNativeAgentsAPI({
    memoryStatus: async () => memoryStatus({
      backends: [
        backend(),
        backend({ backend: 'codex', installed: true, ready: true, lastSeen: 10 }),
      ],
    }),
    connectMemory: async (backend) => {
      calls.push(backend);
      return { backend, installed: true, ready: false, reviewRequired: false, lastSeen: null };
    },
  });
  await renderSettings(runtimeApis(native), true);
  await flush();

  expect(calls).toEqual(['claude']);
  expect(host.textContent).not.toContain('CLI memory sharing');
  expect(host.textContent).not.toContain('Some CLI hooks');
});

test('shows only the remote hint when this client cannot install hooks', async () => {
  let called = false;
  const native = createTestNativeAgentsAPI({
    memoryStatus: async () => memoryStatus({ canManage: false }),
    connectMemory: async () => {
      called = true;
      throw new Error('unexpected connect');
    },
  });
  await renderSettings(runtimeApis(native), true);
  await flush();

  expect(called).toBe(false);
  expect(host.textContent).toContain('Connect terminal CLIs on the server computer.');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('shows one inline error without blocking the other backend', async () => {
  const calls: string[] = [];
  const native = createTestNativeAgentsAPI({
    memoryStatus: async () => memoryStatus(),
    connectMemory: async (backend) => {
      calls.push(backend);
      if (backend === 'claude') throw new Error('claude config is malformed');
      return { backend, installed: true, ready: false, reviewRequired: false, lastSeen: null };
    },
  });
  await renderSettings(runtimeApis(native), true);
  await flush();

  expect(calls).toEqual(['claude', 'codex']);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Some CLI hooks couldn't be set up");
});

test('shows the Codex review hint and never disconnects hooks when memory is turned off', async () => {
  let disconnects = 0;
  const native = createTestNativeAgentsAPI({
    memoryStatus: async () => memoryStatus({
      backends: [backend({ installed: true, ready: true, lastSeen: 10 }), backend({ backend: 'codex', installed: true, reviewRequired: true })],
    }),
    disconnectMemory: async () => {
      disconnects += 1;
      throw new Error('unexpected disconnect');
    },
  });
  await renderSettings(runtimeApis(native), true);
  await flush();
  expect(host.textContent).toContain('Review this hook in Codex before it can run.');

  await act(async () => {
    memorySwitch().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    jest.advanceTimersByTime(200);
  });
  await flush();
  expect(disconnects).toBe(0);
});
