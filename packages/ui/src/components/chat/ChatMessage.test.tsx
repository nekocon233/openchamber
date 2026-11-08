import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import { MessageSliceContext } from './message/messageSliceContext';
import { projectTurnRecords } from './lib/turns/projectTurnRecords';
import { buildTimelineRows, type MessageSlice } from './lib/turns/timelineRows';

const browser = new Window({ url: 'http://localhost/' });
const globals = {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement,
  SVGElement: browser.SVGElement, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
  customElements: browser.customElements, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'chat-message-vite-assets',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
  },
});

const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { default: ChatMessage } = await import('./ChatMessage');
const { SyncProvider } = await import('@/sync/sync-context');
const { I18nProvider, useI18nStore, formatMessage } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createTestNativeAgentsAPI, createTestRuntimeAPIs } = await import('@/lib/native-agents/test-utils/runtime');
const { useUIStore } = await import('@/stores/useUIStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useConfigStore } = await import('@/stores/useConfigStore');

const theme = getDefaultTheme(false);
const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
  setTheme: unexpectedThemeChange, reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange, deleteImportedTheme: unexpectedThemeChange,
  isSystemPreference: false, setSystemPreference: unexpectedThemeChange,
  themeMode: 'light', setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id, darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange, setDarkThemePreference: unexpectedThemeChange,
};
const apis = createTestRuntimeAPIs(createTestNativeAgentsAPI({}));
// The test supplies session metadata directly; bootstrap never replaces it.
const sdk = OpenCode.make({ baseUrl: 'http://chat.test', fetch: () => new Promise<Response>(() => undefined) });
const sessionId = 'ncv_11111111-1111-4111-8111-111111111111';
const session = (metadata?: Session['metadata'], id = sessionId): Session => ({
  id, projectID: 'project', directory: '/repo', title: 'Test conversation', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, metadata,
});
const actions = (revert: boolean, fork: boolean): Session['metadata'] => ({
  openchamber: { native: { actions: { revert, fork, delete: false } } },
});
const message: React.ComponentProps<typeof ChatMessage>['message'] = {
  info: { id: 'message-1', sessionID: sessionId, role: 'user', time: { created: 1 } },
  parts: [{ id: 'part-1', sessionID: sessionId, messageID: 'message-1', type: 'text', text: 'Visible message' }],
};

let root: Root;
let container: HTMLDivElement;
let commits = 0;
const initialGlobalSessions = useGlobalSessionsStore.getState();
const initialUI = useUIStore.getState();
const initialProviders = useConfigStore.getState().providers;

beforeEach(() => {
  commits = 0;
  useI18nStore.getState().setLocale('en');
  useUIStore.setState({ userMessageRenderingMode: 'plain', isMobile: false });
  useConfigStore.setState({ providers: [] });
  useGlobalSessionsStore.setState({ entityById: new Map([[sessionId, session()]]) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useGlobalSessionsStore.setState(initialGlobalSessions, true);
  useUIStore.setState(initialUI, true);
  useConfigStore.setState({ providers: initialProviders });
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await browser.happyDOM.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const render = (currentMessage = message, slice: MessageSlice | null = null) => act(async () => root.render(
  <RuntimeAPIContext.Provider value={apis}>
    <ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/repo">
        <I18nProvider>
          <React.Profiler id="message" onRender={() => { commits += 1; }}>
            <MessageSliceContext.Provider value={slice}>
            <ChatMessage message={currentMessage} turnGroupingContext={currentMessage.info.role === 'assistant' ? {
              turnId: 'turn-1', isFirstAssistantInTurn: true, isLastAssistantInTurn: true,
              isLatestTurn: true, hasTools: false, hasReasoning: false, isWorking: false,
            } : undefined} />
            </MessageSliceContext.Provider>
          </React.Profiler>
        </I18nProvider>
      </SyncProvider>
    </ThemeSystemContext.Provider>
  </RuntimeAPIContext.Provider>,
));
const publish = (sessions: Session[]) => act(async () => {
  useGlobalSessionsStore.setState({ entityById: new Map(sessions.map((entry) => [entry.id, entry])) });
});
const hasAction = (action: 'revert' | 'fork') => Boolean(container.querySelector(
  `button[aria-label="${formatMessage(useI18nStore.getState().dictionary, action === 'revert' ? 'chat.messageBody.actions.revertAria' : 'chat.messageBody.actions.forkAria')}"]`,
));

test('a unified conversation message settles and ignores unrelated or equivalent session updates', async () => {
  await render();
  expect(container.textContent).toContain('Visible message');
  expect(commits).toBeLessThan(10);
  const settled = commits;
  for (let i = 0; i < 20; i += 1) {
    await publish([session(), { ...session(undefined, 'other-session'), time: { created: 1, updated: i + 2 } }]);
  }
  expect(commits).toBe(settled);
  expect(hasAction('revert')).toBe(false);
  expect(hasAction('fork')).toBe(false);
});

test('message actions follow changed server capabilities and close when metadata disappears', async () => {
  await render();
  await publish([session(actions(true, false))]);
  expect(hasAction('revert')).toBe(true);
  expect(hasAction('fork')).toBe(false);

  await publish([session(actions(false, true))]);
  expect(hasAction('revert')).toBe(false);
  expect(hasAction('fork')).toBe(true);

  const settled = commits;
  await publish([session(actions(false, true))]);
  expect(commits).toBe(settled);

  await publish([]);
  expect(hasAction('revert')).toBe(false);
  expect(hasAction('fork')).toBe(false);
});

const assistantMessage = (variant: string | undefined, modelID = 'claude-opus-5-5-high', providerID = 'claude-native'): React.ComponentProps<typeof ChatMessage>['message'] => ({
  info: {
    id: 'assistant-1', sessionID: sessionId, role: 'assistant', agent: 'plan',
    providerID, modelID, variant,
    finish: 'stop', time: { created: 1, completed: 2 },
  },
  parts: [{ id: 'assistant-part', sessionID: sessionId, messageID: 'assistant-1', type: 'text', text: 'Saved response' }],
});

test('renders each part once across timeline slices and keeps the footer on the last row', async () => {
  const assistant = assistantMessage('max');
  assistant.parts = Array.from({ length: 30 }, (_, index) => ({
    id: `text-${index}`, messageID: assistant.info.id, sessionID: sessionId,
    type: 'text', text: `Unique paragraph ${index}.`, time: { start: 1, end: 2 },
  }));
  const turn = projectTurnRecords([message, assistant]).turns[0];
  const rows = buildTimelineRows([{ kind: 'turn', key: turn.turnId, turn, isLastTurn: true }], {
    collapsedActivity: false, expandedTurns: new Map(), showReasoningTraces: true,
  }, []).filter((row) => row.kind === 'turn-message');
  expect(rows.length).toBe(2);

  await render(assistant, rows[0].slice);
  expect(container.querySelectorAll('[data-message-text-export-source]').length).toBe(24);
  expect(container.querySelector('[data-fact-model]')).toBeNull();
  expect(container.querySelector('[id="message-assistant-1"]')).not.toBeNull();
  expect(container.querySelector('[data-message-continues]')).not.toBeNull();

  await render(assistant, rows[1].slice);
  expect(container.querySelectorAll('[data-message-text-export-source]').length).toBe(6);
  expect(container.querySelectorAll('[data-fact-model]').length).toBe(1);
  expect(container.querySelector('[id="message-assistant-1"]')).toBeNull();
  expect(container.querySelector('[data-message-slice]')?.getAttribute('data-message-slice')).toBe('text-24:0');
  expect(container.querySelector('[data-message-continues]')).toBeNull();
});

test('shows the reply model effort over the submitted effort without a catalog', async () => {
  await render(assistantMessage('max'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('high');
});

test('shows a Magpie response as its Claude model and fixed effort', async () => {
  await render(assistantMessage('max', 'group/auto-claude-opus-5-5:high'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('high');
});

test('reads an explicit model effort without send metadata and updates with the same message id', async () => {
  await render(assistantMessage(undefined));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('high');

  await render(assistantMessage('max', 'group/auto-claude-opus-5-5:low'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('low');
});

test('keeps other providers on their recorded effort', async () => {
  await render(assistantMessage('max', 'claude-opus-5-5-high', 'other-provider'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5 High');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('max');
});

test('keeps an unknown effort unknown and updates when the same message records one', async () => {
  await render(assistantMessage(undefined, 'group/auto-claude-opus-5-5'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')).toBeNull();

  await render(assistantMessage('max', 'group/auto-claude-opus-5-5'));
  expect(container.querySelector('[data-fact-model]')?.textContent).toBe('Claude Opus 5.5');
  expect(container.querySelector('.message-footer__facts [data-fact-priority="3"]')?.textContent).toContain('max');
});
