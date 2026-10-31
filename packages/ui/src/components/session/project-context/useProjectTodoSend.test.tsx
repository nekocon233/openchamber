import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { NativePromptRequest } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://todo-send.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  CustomEvent: browser.CustomEvent, Event: browser.Event,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const originalFetch = globalThis.fetch;
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const fixtureResponse = (input: RequestInfo | URL) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://todo-send.test').pathname;
  if (pathname.endsWith('/event')) return new Response(new ReadableStream({ start(controller) { streams.add(controller); } }), { headers: { 'content-type': 'text/event-stream' } });
  if (pathname.endsWith('/location')) return Response.json({ directory: '/fixture/todo-project', project: { id: 'todo-project', directory: '/fixture/todo-project', canonical: '/fixture/todo-project' } });
  if (pathname.endsWith('/session/active')) return Response.json({});
  if (pathname.endsWith('/session')) return Response.json({ data: [], cursor: {} });
  if (pathname.endsWith('/form') || pathname.endsWith('/permission/request')) return Response.json({ data: [] });
  if (pathname.endsWith('/shell')) return Response.json({ data: [], location: { directory: '/fixture/todo-project' } });
  if (pathname.endsWith('/vcs')) return Response.json({ branch: { current: 'main', default: 'main' } });
  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/config')) return Response.json({
    trust: { hash: null, trusted: false }, setupWorktree: [], setupWorktreeWait: false, projectActions: [], projectActionsPrimaryId: null, draftStarters: [],
    shared: { status: 'missing', path: '/fixture/todo-project/.openchamber/config.json', setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null },
    personal: { setupWorktree: [], setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: [], projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
  });
  return Response.json([]);
};
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => fixtureResponse(input), originalFetch);

const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { opencodeClient } = await import('@/lib/opencode/client');
const { I18nProvider } = await import('@/lib/i18n');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { NativeAgentsRequestError } = await import('@/lib/native-agents/errors');
const { buildNativeProvider } = await import('@/lib/native-agents/providers');
const { initializeRuntimeEndpoint, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { SyncProvider, useChildStoreManager } = await import('@/sync/sync-context');
const { setOptimisticRefs } = await import('@/sync/session-actions');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useGlobalSessionStatusStore } = await import('@/sync/global-session-status');
const { useSessionGoalArmStore } = await import('@/stores/useSessionGoalArmStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { ChatColumnActionsContext, ChatColumnSessionContext } = await import('@/components/chat/chatColumnSession');
const { useProjectTodoSend } = await import('./useProjectTodoSend');
const originalReads = { getConfig: opencodeClient.getConfig, getVcs: opencodeClient.getVcs, getActiveSessionStatuses: opencodeClient.getActiveSessionStatuses };
opencodeClient.getConfig = async () => ({});
opencodeClient.getVcs = async () => ({ branch: 'main' });
opencodeClient.getActiveSessionStatuses = async () => ({});

const DIRECTORY = '/fixture/todo-project';
const OTHER_DIRECTORY = '/fixture/another-project';
const CURRENT = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const CREATED = 'ncl_aa979243-d4d5-433e-bc44-03a2732e2308';
const PINNED = 'ncl_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3';
const project = { id: 'todo-project', path: DIRECTORY };
const session = (id: string, directory = DIRECTORY): Session => ({
  id, projectID: '', directory, title: 'Todo send fixture', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
const closedDraft = useSessionUIStore.getState().newSessionDraft;
let creates: Array<{ directory: string; backend: string }> = [];
let prompts: Array<{ sessionId: string; request: NativePromptRequest }> = [];
let submissions: Promise<void>[] = [];
let promptGate: Promise<void> | null = null;
let rejectGate: Promise<void> | null = null;
let promptFailures = 0;
let actionCompletions = 0;
let root: ReturnType<typeof createRoot> | null = null;
let manager: ReturnType<typeof useChildStoreManager> | null = null;
const host = document.createElement('div');
document.body.append(host);
const sdk = OpenCode.make({ baseUrl: 'http://todo-send.test', fetch: async input => fixtureResponse(input) });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function Harness() {
  manager = useChildStoreManager();
  const send = useProjectTodoSend({ projectRef: project, canCreateWorktree: false, onActionComplete: () => { actionCompletions++; } });
  return <button disabled={send.sendingTodoId === 'todo'} onClick={() => {
    submissions.push(send.sendToCurrentSession('todo', 'Inspect the parser'));
  }}>Send todo</button>;
}

const mount = async (column: { sessionId: string | null; directory: string | null } | null = null, pinned = false) => {
  root = createRoot(host);
  await act(async () => root?.render(
    <I18nProvider><SyncProvider sdk={sdk} directory="">
      <ChatColumnActionsContext.Provider value={{ pinned, openSession: () => {}, openTimelineDialog: () => {}, focusInput: () => {} }}>
        <ChatColumnSessionContext.Provider value={column}><Harness /></ChatColumnSessionContext.Provider>
      </ChatColumnActionsContext.Provider>
    </SyncProvider></I18nProvider>,
  ));
  manager?.ensureChild(DIRECTORY, { bootstrap: false }).setState({ session: [session(CURRENT), session(CREATED)] });
  manager?.ensureChild(OTHER_DIRECTORY, { bootstrap: false }).setState({ session: [session(PINNED, OTHER_DIRECTORY)] });
  setOptimisticRefs(input => {
    manager?.ensureChild(input.directory || DIRECTORY, { bootstrap: false }).setState(state => ({
      message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
      part: { ...state.part, [input.message.id]: input.parts },
    }));
  }, input => {
    manager?.getChild(input.directory || DIRECTORY)?.setState(state => ({
      message: { ...state.message, [input.sessionID]: (state.message[input.sessionID] ?? []).filter(message => message.id !== input.messageID) },
    }));
  });
  await settle();
};
const button = () => {
  const value = host.querySelector<HTMLButtonElement>('button');
  if (!value) throw new Error('Todo send button is missing');
  return value;
};
const sendTodo = async () => {
  await act(async () => { button().click(); await submissions.at(-1); });
  await settle();
};
const openDraft = () => useSessionUIStore.setState({
  currentSessionId: null, currentSessionDirectory: null,
  newSessionDraft: { ...closedDraft, draftId: 71, open: true, target: 'project', selectedProjectId: project.id,
    directoryOverride: DIRECTORY, preserveDirectoryOverride: true, parentID: null },
});
const saveCurrentSelection = (sessionId = CURRENT) => {
  const selection = useSelectionStore.getState();
  selection.saveSessionModelSelection(sessionId, 'claude-native', 'session-model');
  selection.saveSessionAgentSelection(sessionId, 'plan');
  selection.saveAgentModelVariantForSession(sessionId, 'plan', 'claude-native', 'session-model', 'low');
};

beforeEach(() => {
  creates = []; prompts = []; submissions = []; promptGate = null; rejectGate = null; promptFailures = 0; actionCompletions = 0;
  initializeRuntimeEndpoint({ apiBaseUrl: 'http://todo-send.test', runtimeKey: 'todo-runtime-a' });
  const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({
    capabilities: async () => ({ supported: true, backends: { claude: { cli: true }, codex: { cli: false } }, registry: { reset: false } }),
    createSession: async input => { creates.push({ directory: input.directory, backend: input.backend }); return session(CREATED, input.directory); },
    getSession: async id => session(id, id === PINNED ? OTHER_DIRECTORY : DIRECTORY),
    loadMessages: async () => ({ records: [], cursor: null, complete: true, childSessions: [] }),
    statuses: async () => ({}), questions: async () => [], backgroundTasks: async () => ({}),
    listSessions: async directory => ({ backends: {
      claude: { status: 'ok', sessions: directory === DIRECTORY ? [session(CURRENT), session(CREATED)] : [session(PINNED, OTHER_DIRECTORY)] },
      codex: { status: 'ok', sessions: [] },
    } }),
    catalog: async () => ({ backends: { claude: { status: 'ok', models: [] }, codex: { status: 'ok', models: [] } } }),
    prompt: async (sessionId, request) => {
      prompts.push({ sessionId, request });
      if (promptGate) await promptGate;
      if (promptFailures > 0) { promptFailures--; throw new NativeAgentsRequestError('Fixture delivery failed', 503, 'NATIVE_CLI_MISSING'); }
    },
    rejectQuestion: async () => { if (rejectGate) await rejectGate; },
  }));
  Object.defineProperty(apis, 'settings', { value: { load: async () => ({ settings: {}, source: 'web' }), save: async () => ({}) } });
  registerRuntimeAPIs(apis);
  useSelectionStore.setState({ sessionModelSelections: new Map(), sessionAgentSelections: new Map(), sessionAgentModelSelections: new Map(), agentModelVariantSelections: new Map() });
  useSessionUIStore.setState({ currentSessionId: CURRENT, currentSessionDirectory: DIRECTORY,
    newSessionDraft: { ...closedDraft, open: false }, materializedDraftSessionId: null, worktreeMetadata: new Map() });
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  useProjectsStore.setState({ projects: [project], activeProjectId: project.id });
  useConfigStore.setState({ isConnected: true, isInitialized: true, providersLoaded: true, agentsLoaded: true,
    settingsDefaultsLoaded: true, activeDirectoryKey: DIRECTORY,
    providers: [buildNativeProvider('claude', [
      { id: 'picker-model', name: 'Picker', contextWindow: null, outputLimit: null, efforts: ['low', 'high'], defaultEffort: null, fast: false, input: { image: false, pdf: false } },
      { id: 'session-model', name: 'Session', contextWindow: null, outputLimit: null, efforts: ['low', 'high'], defaultEffort: null, fast: false, input: { image: false, pdf: false } },
    ])],
    currentProviderId: 'claude-native', currentModelId: 'picker-model', currentAgentName: 'plan', currentVariant: 'high',
    currentVariantSelection: { override: 'high', inherited: undefined }, selectionSource: 'manual',
    settingsDefaultModel: 'claude-native/session-model', settingsDefaultVariant: 'low',
  });
  useUIStore.setState({ isSessionSwitcherOpen: false, isMobile: false });
  useSessionGoalArmStore.setState({ armed: false, objectiveOverride: null });
  useGlobalSessionStatusStore.setState(useGlobalSessionStatusStore.getInitialState());
});

afterEach(async () => {
  await act(async () => root?.unmount()); root = null; manager = null;
  for (const stream of streams) { try { stream.close(); } catch { /* The transport may already have canceled it. */ } }
  streams.clear();
  registerRuntimeAPIs(null);
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: { ...closedDraft, open: false } });
});
afterAll(async () => {
  Object.assign(opencodeClient, originalReads);
  globalThis.fetch = originalFetch;
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('sends directly into the selected session with its saved model, agent and effort', async () => {
  saveCurrentSelection();
  await mount(); await sendTodo();
  expect(creates).toEqual([]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ sessionId: CURRENT, request: {
    directory: DIRECTORY, parts: [{ type: 'text', text: 'Inspect the parser' }],
    model: { providerID: 'claude-native', modelID: 'session-model' }, agent: 'plan', variant: 'low',
  } });
  expect(actionCompletions).toBe(1);
});

test('materializes an empty main draft through sendMessage using the current picker instead of settings defaults', async () => {
  openDraft(); await mount(); await sendTodo();
  expect(creates).toEqual([{ backend: 'claude', directory: DIRECTORY }]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ sessionId: CREATED, request: {
    model: { providerID: 'claude-native', modelID: 'picker-model' }, agent: 'plan', variant: 'high', directory: DIRECTORY,
  } });
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
});

test('a pinned chat column sends to its own session while the main view has an empty draft', async () => {
  openDraft(); saveCurrentSelection(PINNED);
  await mount({ sessionId: PINNED, directory: OTHER_DIRECTORY }, true); await sendTodo();
  expect(creates).toEqual([]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ sessionId: PINNED, request: { directory: OTHER_DIRECTORY, model: { modelID: 'session-model' } } });
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
});

test('an empty pinned column leaves the main draft available without sending', async () => {
  openDraft();
  await mount({ sessionId: null, directory: OTHER_DIRECTORY }, true); await sendTodo();
  expect(creates).toEqual([]);
  expect(prompts).toEqual([]);
  expect(actionCompletions).toBe(0);
  expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
});

test('two clicks in one render dispatch the todo only once', async () => {
  let release = () => {};
  promptGate = new Promise(resolve => { release = resolve; });
  await mount();
  await act(async () => { button().click(); button().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  release();
  await act(async () => { await Promise.all(submissions); });
  expect(prompts).toHaveLength(1);
});

test('a failed first draft prompt can be retried without creating another session', async () => {
  promptFailures = 1; openDraft(); await mount(); await sendTodo();
  expect(creates).toHaveLength(1);
  expect(prompts).toHaveLength(1);
  expect(actionCompletions).toBe(0);
  await sendTodo();
  expect(creates).toHaveLength(1);
  expect(prompts).toHaveLength(2);
  expect(prompts.map(prompt => prompt.sessionId)).toEqual([CREATED, CREATED]);
  expect(actionCompletions).toBe(1);
});

test('a directory and selection switch during dismissal cannot reroute the clicked todo', async () => {
  let release = () => {};
  rejectGate = new Promise(resolve => { release = resolve; });
  saveCurrentSelection(); await mount();
  await act(async () => manager?.getChild(DIRECTORY)?.setState({ form: { [CURRENT]: [{
    id: 'ncq_todo_blocking', sessionID: CURRENT, title: 'Choose', fields: [{ key: 'answer', type: 'string' }],
  }] } }));
  await act(async () => { button().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => {
    useSessionUIStore.setState({ currentSessionId: PINNED, currentSessionDirectory: OTHER_DIRECTORY });
    useDirectoryStore.setState({ currentDirectory: OTHER_DIRECTORY });
    useConfigStore.setState({ currentModelId: 'picker-model', currentVariant: 'high', currentAgentName: 'build' });
    release(); await Promise.all(submissions);
  });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ sessionId: CURRENT, request: {
    directory: DIRECTORY, model: { modelID: 'session-model' }, agent: 'plan', variant: 'low',
  } });
});

test('a runtime switch during dismissal blocks dispatch into the replacement runtime', async () => {
  let release = () => {};
  rejectGate = new Promise(resolve => { release = resolve; });
  await mount();
  await act(async () => manager?.getChild(DIRECTORY)?.setState({ form: { [CURRENT]: [{
    id: 'ncq_todo_runtime', sessionID: CURRENT, title: 'Choose', fields: [{ key: 'answer', type: 'string' }],
  }] } }));
  await act(async () => { button().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://another-todo-runtime.test', runtimeKey: 'todo-runtime-b' });
    release(); await Promise.all(submissions);
  });
  expect(prompts).toEqual([]);
  expect(creates).toEqual([]);
  expect(actionCompletions).toBe(0);
});
