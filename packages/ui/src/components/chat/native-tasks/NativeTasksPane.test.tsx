import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NativeAgentsAPI, SettingsAPI } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useI18nStore } from '@/lib/i18n/store';
import { createTestNativeAgentsAPI, createTestRuntimeAPIs } from '@/lib/native-agents/test-utils/runtime';
import type { NativeChecklistSnapshot, NativeExecutionTask, NativeTaskOutput, NativeTaskSnapshot } from '@/lib/native-agents/task-schemas';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { applySessionNativeChecklistEvent } from '@/sync/session-native-checklist';
import { applySessionNativeTaskDetailsEvent } from '@/sync/session-background-tasks';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useNativeTasksUIStore } from './task-ui-store';

let NativeTasksPane: typeof import('./NativeTasksPane').NativeTasksPane;
let NativeTasksBody: typeof import('./NativeTasksBody').NativeTasksBody;
let WorkStatusChecklistSection: typeof import('../work-status/WorkStatusChecklistSection').WorkStatusChecklistSection;
let WorkStatusBackgroundTasksSection: typeof import('../work-status/WorkStatusBackgroundTasksSection').WorkStatusBackgroundTasksSection;

const directory = '/fixture/tasks';
const sessionId = 'ncl_task-fixture';
const checklist = (revision = 1): Extract<NativeChecklistSnapshot, { state: 'ready' }> => ({
  state: 'ready', identity: 'fixture-list', source: 'files', revision, observedAt: 1,
  complete: true, unreadable: 0,
  items: [{ id: '1', subject: 'Review changes', description: 'Read the current diff', status: 'in_progress', owner: 'reviewer', blockedBy: ['2'], blocks: ['3'] }],
});
const task = (id = 'task-1', overrides: Partial<NativeExecutionTask> = {}): NativeExecutionTask => ({
  id, type: 'local_bash', description: `Build ${id}`, active: true, ambient: false,
  status: 'running', canStop: true, outputAvailable: true, ...overrides,
});
const snapshot = (tasks = [task()], revision = 1): Extract<NativeTaskSnapshot, { state: 'active' }> => ({ state: 'active', generation: 'query-1', revision, tasks, omitted: 0 });
const capabilities: NativeAgentsAPI['capabilities'] = async () => ({
  supported: true, backends: { claude: { cli: true, tasks: { checklist: true, background: true, output: true, stop: true } }, codex: { cli: true } }, registry: { reset: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let win: Window;
let root: Root;
let restoreGlobals: () => void;
let serial = 0;
let api: NativeAgentsAPI;
const button = (text: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute('aria-label') === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
};
const click = async (text: string) => { await act(async () => button(text).click()); };
const setup = (methods: Partial<NativeAgentsAPI> = {}) => {
  api = createTestNativeAgentsAPI({ capabilities, checklist: async () => checklist(), sessionTasks: async () => snapshot(), taskOutput: async () => ({ state: 'ready', text: '', truncated: false }), ...methods });
  registerRuntimeAPIs(runtime(api));
};
const runtime = (nativeAgents: NativeAgentsAPI) => {
  const apis = createTestRuntimeAPIs(nativeAgents, { sidebarState: { supported: false, load: async () => null, mutate: async () => null } });
  const settings: SettingsAPI = { load: async () => ({ settings: {}, source: 'web' }), save: async (changes) => changes };
  Object.defineProperty(apis, 'settings', { value: settings });
  return apis;
};
const selectSession = (session = sessionId) => {
  useSessionUIStore.setState({ currentSessionId: session, currentSessionDirectory: directory });
};
const render = async ({ session = sessionId, summaries = false, pane = true }: { session?: string; summaries?: boolean; pane?: boolean } = {}) => {
  const apis = runtime(api);
  selectSession(session);
  await act(async () => root.render(
    <RuntimeAPIContext.Provider value={apis}><I18nProvider>
      {pane ? <NativeTasksPane /> : null}
      {summaries ? <><WorkStatusChecklistSection sessionId={session} directory={directory} /><WorkStatusBackgroundTasksSection sessionId={session} directory={directory} /></> : null}
    </I18nProvider></RuntimeAPIContext.Provider>,
  ));
};
const showBackground = async () => { await click('Background tasks'); };

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
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restoreGlobals = () => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } };
  ({ NativeTasksPane } = await import('./NativeTasksPane'));
  ({ NativeTasksBody } = await import('./NativeTasksBody'));
  ({ WorkStatusChecklistSection } = await import('../work-status/WorkStatusChecklistSection'));
  ({ WorkStatusBackgroundTasksSection } = await import('../work-status/WorkStatusBackgroundTasksSection'));
  switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: `tasks-test-${++serial}` });
  useNativeTasksUIStore.setState({ tab: 'checklist', stopScope: null, stops: new Map() });
  useI18nStore.getState().setLocale('en');
  useUIStore.setState({ isMobile: false, workStatusExpandedSections: {} });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  const container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  setup();
});

afterEach(async () => {
  await act(async () => root.unmount());
  useNativeTasksUIStore.setState({ tab: 'checklist', stopScope: null, stops: new Map() });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  registerRuntimeAPIs(null);
  await win.happyDOM.close();
  restoreGlobals();
});

describe('native tasks context surface', () => {
  test('the pane shows a read-only checklist for the current session and follows locale switches', async () => {
    await render();
    expect(document.querySelector('[data-native-tasks-body]')).not.toBeNull();
    expect(document.body.textContent).toContain('Read-only Claude Code checklist');
    expect(document.body.textContent).toContain('Owner: reviewer');
    expect(document.body.textContent).toContain('Waiting on: 2');
    expect(document.body.textContent).toContain('Blocks: 3');
    expect(document.querySelector('input, textarea, [role="checkbox"]')).toBeNull();
    const chinese = (await import('@/lib/i18n/messages/zh-CN')).dict;
    await act(async () => useI18nStore.setState({ locale: 'zh-CN', dictionary: chinese, loadingLocale: null }));
    expect(document.body.textContent).toContain('只读待办清单');
    expect(document.body.textContent).toContain('负责人：reviewer');
    expect(document.querySelector('[data-native-tasks-body]')).not.toBeNull();
  });

  test('non-Claude sessions and unsupported runtimes explain the empty surface instead of loading', async () => {
    await render({ session: 'ncx_fixture' });
    expect(document.body.textContent).toContain('Tasks are available for Claude Code sessions');
    expect(document.querySelector('[data-native-tasks-body]')).toBeNull();
    setup({ supported: false });
    await render();
    expect(document.body.textContent).toContain('does not support this task view');
    expect(document.querySelector('[data-native-tasks-body]')).toBeNull();
  });

  test('both summaries open the tasks surface on their matching tab', async () => {
    setup({ sessionTasks: async () => snapshot([task(), task('ambient', { ambient: true }), task('ended', { active: false, status: 'completed', canStop: false })]) });
    await render({ summaries: true });
    expect(document.body.textContent).toContain('Active: 1 / Recorded: 3');
    await click('Open background tasks');
    expect(useNativeTasksUIStore.getState().tab).toBe('background');
    expect(document.querySelector('[data-native-tasks-body]')?.textContent).toContain('Ambient task. Not counted');
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'tasks')).toBe(true);
    await click('Open checklist');
    expect(useNativeTasksUIStore.getState().tab).toBe('checklist');
    expect(document.querySelector('[data-native-tasks-body]')?.textContent).toContain('Review changes');
  });

  test('a child-session link closes its host surface before opening the chat tab', async () => {
    let closes = 0;
    setup({ sessionTasks: async () => snapshot([task('task-1', { childSessionId: 'ncl_child-session' })]) });
    useNativeTasksUIStore.setState({ tab: 'background' });
    selectSession();
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtime(api)}><I18nProvider>
        <NativeTasksBody
          scope={{ sessionId, directory, runtimeGeneration: 1, tab: 'background' }}
          onClose={() => { closes += 1; }}
        />
      </I18nProvider></RuntimeAPIContext.Provider>,
    ));
    await click('Build task-1Running');
    await click('Open child session');
    expect(closes).toBe(1);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.some((tab) => tab.mode === 'chat')).toBe(true);
  });

  test('loading, successful empty, partial and failed refresh remain different states', async () => {
    const read = deferred<NativeChecklistSnapshot>();
    setup({ checklist: () => read.promise });
    await render();
    expect(document.body.textContent).toContain('Loading...');
    expect(document.body.textContent).not.toContain('has not recorded');
    await act(async () => read.resolve({ ...checklist(), items: [] }));
    expect(document.body.textContent).toContain('has not recorded any checklist items');
    await act(async () => applySessionNativeChecklistEvent(sessionId, directory, checklist(2), getRuntimeKey()));
    await act(async () => applySessionNativeChecklistEvent(sessionId, directory, { ...checklist(3), complete: false, unreadable: 1, items: [] }, getRuntimeKey()));
    expect(document.body.textContent).toContain('Some checklist entries could not be read');
    expect(document.body.textContent).toContain('Review changes');
    api.checklist = async () => { throw new Error('fixture read failed'); };
    await click('Refresh');
    expect(document.body.textContent).toContain('may be out of date');
    expect(document.body.textContent).toContain('Review changes');
    expect(document.body.textContent).not.toContain('has not recorded any checklist items');
  });

  test('first read failure, unsupported capability and unknown checklist location are explicit', async () => {
    setup({ checklist: async () => { throw new Error('fixture failure'); } });
    await render();
    expect(document.body.textContent).toContain('Could not load tasks');
    await act(async () => applySessionNativeChecklistEvent(sessionId, directory, { state: 'unavailable', reason: 'source_unknown' }, getRuntimeKey()));
    expect(document.body.textContent).toContain('location could not be confirmed');
    let reads = 0;
    setup({ capabilities: async () => ({ supported: true, backends: { claude: { cli: true }, codex: { cli: true } }, registry: { reset: false } }), checklist: async () => { reads += 1; return checklist(); } });
    await render({ session: 'ncl_old-server' });
    expect(document.body.textContent).toContain('does not support this task view');
    expect(reads).toBe(0);
  });

  test('unknown edge details are visible without claiming active membership; inactive is not an empty success', async () => {
    setup({ sessionTasks: async () => ({ state: 'unknown', generation: 'query-1', revision: 1, tasks: [task('edge', { active: false, status: 'unknown', canStop: false })], omitted: 0 }) });
    await render(); await showBackground();
    expect(document.body.textContent).toContain('Waiting for CLI task information');
    expect(document.body.textContent).toContain('Build edge');
    expect(document.body.textContent).not.toContain('No longer active');
    await act(async () => applySessionNativeTaskDetailsEvent(sessionId, directory, { state: 'inactive', generation: null, revision: 2, tasks: [], omitted: 0 }, getRuntimeKey()));
    expect(document.body.textContent).toContain('no longer being observed');
    expect(document.body.textContent).not.toContain('Build edge');
    await act(async () => applySessionNativeTaskDetailsEvent(sessionId, directory, snapshot([], 3), getRuntimeKey()));
    expect(document.body.textContent).toContain('CLI reports no background tasks');
    api.sessionTasks = async () => { throw new Error('fixture background read failed'); };
    await click('Refresh');
    expect(document.body.textContent).toContain('may be out of date');
    expect(document.body.textContent).not.toContain('CLI reports no background tasks');
  });

  test('output loads only for an expanded detail, reports truncation/empty/unavailable and refresh failure stays local', async () => {
    let calls = 0;
    setup({ taskOutput: async () => { calls += 1; return { state: 'ready', text: 'first output', truncated: true }; } });
    await render(); await showBackground();
    expect(calls).toBe(0);
    await click('Build task-1Running');
    expect(calls).toBe(1);
    expect(document.body.textContent).toContain('256 KiB');
    expect(document.body.textContent).toContain('first output');
    api.taskOutput = async () => { throw new Error('fixture output failure'); };
    await click('Refresh output');
    expect(document.body.textContent).toContain('Could not read output');
    expect(document.body.textContent).toContain('first output');
    api.taskOutput = async () => ({ state: 'ready', text: '', truncated: false });
    await click('Refresh output');
    expect(document.body.textContent).toContain('output file is empty');
    api.taskOutput = async () => ({ state: 'unavailable', reason: 'query_closed' });
    await click('Refresh output');
    expect(document.body.textContent).toContain('this CLI process has ended');
    api.taskOutput = async () => ({ state: 'unavailable', reason: 'unreadable' });
    await click('Refresh output');
    expect(document.body.textContent).toContain("Could not read this task's output");
    await click('Build task-1Running');
    expect(document.body.textContent).not.toContain('Refresh output');
  });

  test('one task stop is deduplicated, retained across tabs, and waits for authoritative termination', async () => {
    const stop = deferred<void>();
    const calls: string[] = [];
    let aborts = 0;
    setup({ sessionTasks: async () => snapshot([task(), task('other')]), stopTask: (_session, id) => { calls.push(id); return stop.promise; }, abort: async () => { aborts += 1; return true; } });
    await render(); await showBackground();
    await click('Stop this task');
    await act(async () => button('Stopping…').click());
    expect(calls).toEqual(['task-1']);
    await act(async () => stop.resolve());
    expect(document.body.textContent).toContain('Waiting for CLI confirmation');
    await click('Checklist'); await click('Background tasks');
    expect(button('Stopping…').disabled).toBe(true);
    expect(document.body.textContent).toContain('Build other');
    await act(async () => applySessionNativeTaskDetailsEvent(sessionId, directory, snapshot([task('task-1', { active: false, status: 'stopped', canStop: false }), task('other')], 2), getRuntimeKey()));
    expect(document.body.textContent).not.toContain('Stopping…');
    expect(document.body.textContent).toContain('Build other');
    expect(aborts).toBe(0);
  });

  test('stop failure leaves unrelated rows and permits retry', async () => {
    let attempts = 0;
    setup({ stopTask: async () => { attempts += 1; if (attempts === 1) throw new Error('fixture stop failure'); } });
    await render(); await showBackground(); await click('Stop this task');
    expect(document.body.textContent).toContain('Could not stop this task');
    expect(button('Stop this task').disabled).toBe(false);
    await click('Stop this task');
    expect(attempts).toBe(2);
    expect(document.body.textContent).toContain('Waiting for CLI confirmation');
  });

  test('session and runtime switches remount the pane, abort output and reject late results', async () => {
    const output = deferred<NativeTaskOutput>();
    let signal: AbortSignal | undefined;
    setup({ taskOutput: (_session, _task, _directory, _generation, options) => { signal = options?.signal; return output.promise; } });
    await render(); await showBackground(); await click('Build task-1Running');
    await render({ session: 'ncl_other-session' });
    expect(signal?.aborted).toBe(true);
    await act(async () => output.resolve({ state: 'ready', text: 'STALE OUTPUT', truncated: false }));
    expect(document.body.textContent).not.toContain('STALE OUTPUT');
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'tasks-next-runtime' }));
    // The endpoint change clears submitted actions; the remounted pane may
    // register its fresh scope, but no stop request survives the switch.
    expect(useNativeTasksUIStore.getState().stops.size).toBe(0);
  });

  test('late stop failure cannot leak into a different session or runtime', async () => {
    const stopped = deferred<void>();
    setup({ stopTask: () => stopped.promise });
    await render(); await showBackground(); await click('Stop this task');
    expect(useNativeTasksUIStore.getState().stops.size).toBe(1);
    await render({ session: 'ncl_next-stop-session' });
    expect(useNativeTasksUIStore.getState().stops.size).toBe(0);
    await act(async () => stopped.reject(new Error('previous session failed')));
    await showBackground();
    expect(document.body.textContent).not.toContain('Could not stop this task');
    expect(button('Stop this task').disabled).toBe(false);
    api.stopTask = async () => {};
    await click('Stop this task');
    expect(useNativeTasksUIStore.getState().stops.size).toBe(1);
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: '', runtimeKey: 'tasks-stop-runtime' }));
    expect(useNativeTasksUIStore.getState().stops.size).toBe(0);
  });

  test('generation replacement discards an open detail and its late output', async () => {
    const output = deferred<NativeTaskOutput>(); let signal: AbortSignal | undefined;
    setup({ taskOutput: (_session, _task, _directory, _generation, options) => { signal = options?.signal; return output.promise; } });
    await render(); await showBackground(); await click('Build task-1Running');
    await act(async () => applySessionNativeTaskDetailsEvent(sessionId, directory, { ...snapshot(), generation: 'query-2', revision: 2 }, getRuntimeKey()));
    expect(signal?.aborted).toBe(true);
    await act(async () => output.resolve({ state: 'ready', text: 'OLD QUERY OUTPUT', truncated: false }));
    expect(document.body.textContent).not.toContain('OLD QUERY OUTPUT');
    expect(document.body.textContent).not.toContain('Refresh output');
  });
});
