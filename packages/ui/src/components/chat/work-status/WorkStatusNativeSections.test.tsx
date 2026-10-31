import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, SettingsAPI } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useI18nStore } from '@/lib/i18n/store';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import type { NativeChecklistSnapshot, NativeTaskSnapshot } from '@/lib/native-agents/task-schemas';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

let WorkStatusChecklistSection: typeof import('./WorkStatusChecklistSection').WorkStatusChecklistSection;
let WorkStatusBackgroundTasksSection: typeof import('./WorkStatusBackgroundTasksSection').WorkStatusBackgroundTasksSection;
let WorkStatusPlanSection: typeof import('./WorkStatusPlanSection').WorkStatusPlanSection;
let WorkStatusTodosSection: typeof import('./WorkStatusTodosSection').WorkStatusTodosSection;

const directory = '/fixture/work-status';
const sdk = OpenCode.make({ baseUrl: 'https://work-status.test', fetch: async (request) => {
  const pathname = new URL(request instanceof Request ? request.url : request.toString()).pathname;
  return pathname.endsWith('/event') ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
    : Response.json(pathname.endsWith('/session/active') ? {} : { data: [] });
} });
const CLAUDE = 'ncl_sections';
const CODEX = 'ncx_sections';
const capabilities: NativeAgentsAPI['capabilities'] = async () => ({
  supported: true,
  backends: {
    claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } },
    codex: { cli: true, tasks: { plan: true, todos: true } },
  },
  registry: { reset: false },
});
const checklist: Extract<NativeChecklistSnapshot, { state: 'ready' }> = {
  state: 'ready', identity: 'fixture-list', source: 'files', revision: 1, observedAt: 1,
  complete: true, unreadable: 0,
  items: [{ id: '1', subject: 'Review changes', status: 'in_progress', blocks: [], blockedBy: [] }],
};
const background: NativeTaskSnapshot = {
  state: 'active', generation: 'query-1', revision: 1, omitted: 0,
  tasks: [{ id: 'task-1', type: 'local_bash', description: 'Build task-1', active: true, ambient: false, status: 'running', canStop: true, outputAvailable: false }],
};

let win: Window;
let root: Root;
let restoreGlobals: () => void;
let serial = 0;
let api: NativeAgentsAPI;

const runtime = (nativeAgents: NativeAgentsAPI) => {
  const apis = createTestRuntimeAPIs(nativeAgents, { sidebarState: { supported: false, load: async () => null, mutate: async () => null } });
  Object.defineProperty(apis, 'settings', { value: { load: async () => ({ settings: {}, source: 'web' }), save: async (changes) => changes } as SettingsAPI });
  return apis;
};
const setup = (methods: Partial<NativeAgentsAPI> = {}) => {
  api = createTestNativeAgentsAPI({
    capabilities,
    checklist: async () => checklist,
    sessionTasks: async () => background,
    plan: async () => ({ state: 'ready', observedAt: 1, text: '# Ship it', truncated: false, turnId: 'turn-1' }),
    codexTodos: async () => ({ state: 'active', generation: 'query-1', revision: 1, todos: [{ id: '1', content: 'Read notes', status: 'pending' }] }),
    ...methods,
  });
  registerRuntimeAPIs(runtime(api));
};
const render = async (sessionId: string, sections = true) => {
  const apis = runtime(api);
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={apis}>
      <I18nProvider><SyncProvider sdk={sdk} directory="">
        {sections ? (
          <>
            <WorkStatusChecklistSection sessionId={sessionId} directory={directory} />
            <WorkStatusBackgroundTasksSection sessionId={sessionId} directory={directory} />
            <WorkStatusPlanSection sessionId={sessionId} directory={directory} />
            <WorkStatusTodosSection sessionId={sessionId} directory={directory} />
          </>
        ) : null}
      </SyncProvider></I18nProvider>
    </RuntimeAPIContext.Provider>,
  ));
  await act(async () => { await Promise.resolve(); });
};
const text = () => (document.body.textContent ?? '');

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' });
  const values = {
    window: win, document: win.document, navigator: win.navigator, location: win.location,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
    HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
    Document: win.Document, DocumentFragment: win.DocumentFragment,
    DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => Response.json({ home: '/fixture', data: [] }),
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restoreGlobals = () => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } };
  ({ WorkStatusChecklistSection } = await import('./WorkStatusChecklistSection'));
  ({ WorkStatusBackgroundTasksSection } = await import('./WorkStatusBackgroundTasksSection'));
  ({ WorkStatusPlanSection } = await import('./WorkStatusPlanSection'));
  ({ WorkStatusTodosSection } = await import('./WorkStatusTodosSection'));
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: `work-status-test-${++serial}` });
  useI18nStore.getState().setLocale('en');
  useUIStore.setState({ isMobile: false, workStatusExpandedSections: {} });
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  setup();
});

afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => { await Promise.resolve(); });
  restoreGlobals();
});

describe('native task sections in the work status panel', () => {
  test('Antigravity summaries count saved tasks without claiming active membership', async () => {
    setup({
      capabilities: async () => {
        const base = await capabilities();
        return { ...base, backends: { ...base.backends, antigravity: { cli: true, tasks: { background: true, output: true, stop: false } } } };
      },
      sessionTasks: async () => ({ state: 'history', generation: 'agy-history:fixture', revision: 1, omitted: 0, tasks: [
        { id: 'native/task-2', type: 'bash', description: 'Saved native task', active: false, ambient: false, status: 'unknown', canStop: false, outputAvailable: false },
      ] }),
    });
    await render('nag_sections');
    expect(text()).toContain('Saved tasks: 1');
    expect(text()).toContain('Saved native task');
    expect(text()).toContain('Unknown');
  });

  test('a Claude session shows its checklist and background tasks, not the Codex views', async () => {
    await render(CLAUDE);
    expect(text()).toContain('Review changes');
    expect(text()).toContain('Build task-1');
    // Both CLIs' lists are called "Checklist" in English; the Codex views and
    // their content are what must be absent here.
    expect(text()).not.toContain('Plan document');
    expect(text()).not.toContain('Read notes');
    expect(text()).not.toContain('Ship it');
  });

  test('a Codex session shows its plan and steps, not the Claude views', async () => {
    await render(CODEX);
    expect(text()).toContain('Plan document');
    expect(text()).toContain('Ship it');
    expect(text()).toContain('Read notes');
    expect(text()).not.toContain('Review changes');
    expect(text()).not.toContain('Build task-1');
    expect(text()).not.toContain('Background tasks');
  });

  test('expanding a section shows its items and collapsing leaves the header', async () => {
    useUIStore.setState({ workStatusExpandedSections: { taskChecklist: false } });
    await render(CLAUDE);
    expect(text()).not.toContain('Review changes');
    // The header keeps the count either way, so a collapsed section still says
    // how much work is behind it.
    expect(text()).toContain('Completed: 0 / 1');
    await act(async () => useUIStore.getState().setWorkStatusSectionExpanded('taskChecklist', true));
    expect(text()).toContain('Review changes');
  });

  test('a session with nothing to show says so instead of vanishing', async () => {
    setup({
      checklist: async () => ({ ...checklist, items: [] }),
      sessionTasks: async () => ({ state: 'unknown', generation: 'query-1', revision: 0, tasks: [], omitted: 0 }),
      plan: async () => ({ state: 'empty' }),
      codexTodos: async () => ({ state: 'unknown', generation: null, revision: 0, todos: [] }),
    });
    await render(CLAUDE);
    expect(text()).toContain('has not recorded any checklist items');
    expect(text()).toContain('Waiting for CLI task information');
  });

  test('a Codex session whose process reported no steps says it observed none', async () => {
    setup({ codexTodos: async () => ({ state: 'unknown', generation: null, revision: 0, todos: [] }) });
    await render(CODEX);
    expect(text()).toContain('has not reported any steps');
    expect(text()).toContain('Plan available');
  });
});
