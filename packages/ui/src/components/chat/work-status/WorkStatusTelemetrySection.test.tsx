import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { AssistantMessage, Session, UserMessage } from '@/lib/opencode/model';
import { opencodeClient, type MessagePage } from '@/lib/opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider, useSessionMessageLoader } from '@/sync/sync-context';
import type { SessionMessageLoader } from '@/sync/session-message-loader';
import { getSyncChildStores } from '@/sync/sync-refs';
import { getSyncPerformanceDiagnostics, resetSyncPerformanceDiagnostics, setSyncPerformanceDiagnosticsEnabled } from '@/sync/performance-diagnostics';
let WorkStatusTelemetrySection: typeof import('./WorkStatusTelemetrySection').WorkStatusTelemetrySection;

const directory = '/repo';
const sessionId = 'session-1';
const user: UserMessage = { id: 'user-1', sessionID: sessionId, role: 'user', time: { created: 1000 } };
const session: Session = {
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
};
let tokenReads = 0;
const assistant: AssistantMessage = {
  id: 'assistant-final', sessionID: sessionId, role: 'assistant',
  agent: 'build', providerID: 'test', modelID: 'test',
  time: { created: 2000, completed: 7000 }, cost: 0.01,
  get tokens() { tokenReads += 1; return { input: 100, output: 20, reasoning: 10, cache: { read: 40, write: 0 } }; },
};
const nextUser: UserMessage = { ...user, id: 'user-2', time: { created: 8000 } };
const nextAssistant: AssistantMessage = {
  id: 'assistant-2', sessionID: sessionId, role: 'assistant',
  agent: 'build', providerID: 'test', modelID: 'test',
  time: { created: 9000, completed: 11000 }, cost: 0.02,
  tokens: { input: 900, output: 120, reasoning: 0, cache: { read: 100, write: 0 } },
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

describe('mounted turn telemetry with live sync stores', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let messageRequests = 0;
  let messageLoader: SessionMessageLoader;
  const LoaderProbe = () => {
    const loader = useSessionMessageLoader();
    React.useEffect(() => { messageLoader = loader; }, [loader]);
    return null;
  };
  // Keep bootstrap pending so each test controls real store publications. No
  // hook/module replacements: subscription and materialization paths are real.
  const sdk = OpenCode.make({ baseUrl: 'http://telemetry.test', fetch: (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (/\/session\/[^/]+\/message$/.test(url.pathname)) messageRequests += 1;
    return new Promise<Response>(() => undefined);
  } });
  const render = async (visible = true, selectedDirectory = directory, selectedSession = sessionId) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={selectedDirectory}>
        <LoaderProbe />
        <I18nProvider>{visible ? <WorkStatusTelemetrySection sessionId={selectedSession} directory={selectedDirectory} /> : null}</I18nProvider>
      </SyncProvider>,
    ));
  };
  const store = (dir = directory) => {
    const result = getSyncChildStores().getChild(dir);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  beforeEach(async () => {
    dom = installDom();
    ({ WorkStatusTelemetrySection } = await import('./WorkStatusTelemetrySection'));
    root = createRoot(dom.container);
    tokenReads = 0;
    messageRequests = 0;
    setSyncPerformanceDiagnosticsEnabled(true);
    useUIStore.setState({ workStatusExpandedSections: {}, workStatusHiddenSections: ['telemetry'], workStatusHiddenSectionsExplicit: false });
    await render();
    await act(async () => store().setState({ session: [session], message: { [sessionId]: [user, assistant] }, part: { [assistant.id]: [] }, session_status: {} }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    setSyncPerformanceDiagnosticsEnabled(false);
    dom.restore();
  });

  test('waits for authority, then shows actual token values even when idle is omitted from the snapshot', async () => {
    expect(dom.container.textContent).toContain('Turn stats');
    expect(dom.container.textContent).not.toContain('Avg speed');
    await act(async () => store().setState({ sessionStatusReady: true }));
    expect(dom.container.textContent).toContain('~5 tok/s');
    expect(dom.container.textContent).toContain('Elapsed6.0s');
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    const heading = dom.container.querySelector('button');
    if (!heading) throw new Error('Expected section heading');
    expect(heading.textContent).toBe('Turn stats~5 tok/s');
    expect(heading.querySelectorAll('svg').length).toBe(2);
    expect(dom.container.querySelectorAll('svg').length).toBe(2);
    expect(tokenReads > 0).toBe(true);
    expect(messageRequests).toBe(0);
  });

  test('a pre-archive snapshot cannot enable turn stats after status invalidation', async () => {
    await act(async () => store().setState({ sessionStatusReady: true }));
    expect(dom.container.textContent).toContain('~5 tok/s');
    await act(async () => store().setState({ sessionStatusInvalidated: { [sessionId]: true } }));
    expect(dom.container.textContent).not.toContain('~5 tok/s');
    tokenReads = 0;
    await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    expect(tokenReads).toBe(0);
    await act(async () => store().setState({ sessionStatusInvalidated: {} }));
    expect(dom.container.textContent).toContain('~5 tok/s');
  });

  test('collapsed remount keeps a usable header and reopening reads fresh data', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    const button = dom.container.querySelector('button');
    if (!button) throw new Error('Expected collapse button');
    await act(async () => button.click());
    await render(false);
    await render();
    expect(dom.container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(dom.container.textContent).toContain('Turn stats');
    expect(dom.container.textContent).not.toContain('Avg speed');
    const reopen = dom.container.querySelector('button');
    if (!reopen) throw new Error('Expected reopen button');
    await act(async () => reopen.click());
    expect(dom.container.textContent).toContain('~5 tok/s');
  });

  test('busy, retry and collapsed updates do not notify records subscribers or aggregate tokens', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    // Positive control: on idle, part replacement reaches the subscriber and calculator.
    tokenReads = 0;
    resetSyncPerformanceDiagnostics();
    await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    expect(tokenReads > 0).toBe(true);
    expect((getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks ?? 0) > 0).toBe(true);

    for (const mode of ['busy', 'retry', 'collapsed'] as const) {
      await act(async () => {
        store().setState({ session_status: { [sessionId]: mode === 'retry'
          ? { type: 'retry', attempt: 1, message: 'retry', next: 0 }
          : { type: mode === 'busy' ? 'busy' : 'idle' } } });
        useUIStore.getState().setWorkStatusSectionExpanded('telemetry', mode !== 'collapsed');
      });
      resetSyncPerformanceDiagnostics();
      tokenReads = 0;
      for (let i = 0; i < 100; i += 1) {
        await act(async () => store().setState({ part: { [assistant.id]: [{ id: 'text', sessionID: sessionId,
          messageID: assistant.id, type: 'text', text: String(i), time: { start: 2500 } }] } }));
      }
      expect(tokenReads).toBe(0);
      expect(getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks).toBe(0);
      if (mode === 'collapsed') expect(dom.container.textContent).toBe('Turn stats~5 tok/s');
      else expect(dom.container.textContent).toContain('~5 tok/s');
    }
  });

  test('busy and retry explain when no completed turn is available, and never replace retained stats', async () => {
    expect(dom.container.textContent).not.toContain('Stats appear when the turn finishes.');
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).toContain('Stats appear when the turn finishes.');
    expect(dom.container.textContent).not.toContain('Avg speed');
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'retry', attempt: 1, message: 'retry', next: 0 } } }));
    expect(dom.container.textContent).toContain('Stats appear when the turn finishes.');
    tokenReads = 0;
    resetSyncPerformanceDiagnostics();
    for (let i = 0; i < 100; i += 1) {
      await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    }
    expect(tokenReads).toBe(0);
    expect(getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks).toBe(0);
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    expect(dom.container.textContent).not.toContain('Stats appear when the turn finishes.');
    expect(dom.container.textContent).toContain('Avg speed');
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).toContain('Avg speed');
    expect(dom.container.textContent).not.toContain('Stats appear when the turn finishes.');
  });

  for (const mode of ['busy', 'retry'] as const) {
    test(`${mode} remount recovers the previous turn without following streamed records`, async () => {
      await render(false);
      await act(async () => store().setState({
        session_status: { [sessionId]: mode === 'busy' ? { type: 'busy' } : { type: 'retry', attempt: 1, message: 'retry', next: 0 } },
        message: { [sessionId]: [user, assistant, nextUser, nextAssistant] },
      }));
      await render();
      expect(dom.container.textContent).toContain('Avg speed~5 tok/s');
      expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
      expect(dom.container.textContent).toContain('Avg cache hit29%');
      expect(dom.container.textContent).not.toContain('900 ↑ · 120 ↓');
      expect(dom.container.textContent).not.toContain('Stats appear when the turn finishes.');

      tokenReads = 0;
      resetSyncPerformanceDiagnostics();
      for (let i = 0; i < 100; i += 1) {
        await act(async () => store().setState({
          message: { [sessionId]: [user, assistant, nextUser, { ...nextAssistant, time: { created: 9000 } }] },
          part: { [nextAssistant.id]: [{ id: 'stream', sessionID: sessionId, messageID: nextAssistant.id,
            type: 'text', text: String(i), time: { start: 9500 } }] },
        }));
      }
      expect(tokenReads).toBe(0);
      expect(getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks).toBe(0);
      expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
      expect(messageRequests).toBe(0);
    });
  }

  test('reopening a collapsed running section reads the previous turn after remount', async () => {
    await render(false);
    await act(async () => {
      useUIStore.getState().setWorkStatusSectionExpanded('telemetry', false);
      store().setState({ session_status: { [sessionId]: { type: 'busy' } },
        message: { [sessionId]: [user, assistant, nextUser] } });
    });
    tokenReads = 0;
    await render();
    expect(dom.container.textContent).toBe('Turn stats');
    expect(tokenReads).toBe(0);
    const button = dom.container.querySelector('button');
    if (!button) throw new Error('Expected reopen button');
    await act(async () => button.click());
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    expect(messageRequests).toBe(0);
  });

  for (const order of ['idle-first', 'completion-first'] as const) {
    test(`${order} arrival replaces all telemetry only after completion and idle`, async () => {
      await act(async () => store().setState({ sessionStatusReady: true }));
      const pending: AssistantMessage = { ...nextAssistant, time: { created: 9000 } };
      await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } },
        message: { [sessionId]: [user, assistant, nextUser, pending] } }));
      await act(async () => store().setState(order === 'idle-first'
        ? { session_status: { [sessionId]: { type: 'idle' } } }
        : { message: { [sessionId]: [user, assistant, nextUser, nextAssistant] } }));
      expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
      expect(dom.container.textContent).toContain('Elapsed6.0s');
      expect(dom.container.textContent).toContain('Avg cache hit29%');
      await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } },
        message: { [sessionId]: [user, assistant, nextUser, nextAssistant] } }));
      expect(dom.container.textContent).toContain('900 ↑ · 120 ↓');
      expect(dom.container.textContent).toContain('Elapsed3.0s');
      expect(dom.container.textContent).toContain('Avg speed~17 tok/s');
      expect(dom.container.textContent).toContain('Avg cache hit12%');
      expect(dom.container.textContent).toContain('Cost$0.02');
      expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
    });
  }

  test('a delayed history publication supplies previous stats while the session stays busy', async () => {
    await render(false);
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } },
      message: { [sessionId]: [nextUser] }, part: {} }));
    await render();
    expect(dom.container.textContent).toContain('Stats appear when the turn finishes.');
    let resolveHistory: (page: MessagePage) => void;
    const response = new Promise<MessagePage>((resolve) => { resolveHistory = resolve; });
    const read = spyOn(opencodeClient, 'getSessionMessages').mockImplementation(() => {
      messageRequests += 1;
      return response;
    });
    try {
      let loading = Promise.resolve();
      await act(async () => { loading = messageLoader.ensure({ directory, sessionID: sessionId }); });
      await act(async () => {
        resolveHistory({ items: [{ info: user, parts: [] }, { info: assistant, parts: [] },
          { info: nextUser, parts: [] }], cursor: {} });
        await loading;
      });
      expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
      expect(dom.container.textContent).not.toContain('Stats appear when the turn finishes.');
      expect(messageRequests).toBe(1);
    } finally {
      read.mockRestore();
    }
  });

  test('running snapshots clear on revert and empty records, and wait for renewed status authority', async () => {
    await render(false);
    await act(async () => store().setState({ sessionStatusReady: true,
      session_status: { [sessionId]: { type: 'busy' } }, message: { [sessionId]: [user, assistant, nextUser] } }));
    await render();
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    await act(async () => store().setState({ session: [{ ...session, revert: { messageID: user.id } }] }));
    expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
    await act(async () => store().setState({ session: [session] }));
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    await act(async () => store().setState({ session_status: {}, sessionStatusInvalidated: { [sessionId]: true } }));
    expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    await act(async () => store().setState({ message: {} }));
    expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
  });

  test('shows a token-weighted average across loaded completed turns, not the latest turn alone', async () => {
    const user2: UserMessage = { id: 'user-2', sessionID: sessionId, role: 'user', time: { created: 8000 } };
    const assistant2: AssistantMessage = {
      id: 'assistant-2', sessionID: sessionId, role: 'assistant',
      agent: 'build', providerID: 'test', modelID: 'test',
      time: { created: 9000, completed: 10000 }, cost: 0,
      tokens: { input: 900, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
    };
    await act(async () => store().setState({
      sessionStatusReady: true,
      message: { [sessionId]: [user, assistant, user2, assistant2] },
      part: { [assistant.id]: [], [assistant2.id]: [] },
    }));
    expect(dom.container.textContent).toContain('Avg speed~5 tok/s');
    expect(dom.container.textContent).toContain('Avg cache hit12%');
    expect(dom.container.textContent).not.toContain('~10 tok/s');
  });

  test('session and directory changes cannot retain another scope, including equal IDs', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    expect(dom.container.textContent).toContain('~5 tok/s');
    await render(true, directory, 'another-session');
    expect(dom.container.textContent).not.toContain('~5 tok/s');
    await render(true, '/another-repo');
    await act(async () => store('/another-repo').setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).not.toContain('~5 tok/s');
    const otherAssistant: AssistantMessage = { ...assistant, tokens: nextAssistant.tokens };
    await act(async () => store('/another-repo').setState({ message: { [sessionId]: [user, otherAssistant, nextUser] } }));
    expect(dom.container.textContent).toContain('900 ↑ · 120 ↓');
    expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
    await render(true, directory);
    expect(dom.container.textContent).toContain('~5 tok/s');
  });

  test('same-ID corrections, partial history and reverts replace rather than cache stale stats', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } }, message: { [sessionId]: [assistant] } }));
    expect(dom.container.textContent).not.toContain('Avg speed');
    await act(async () => store().setState({ message: { [sessionId]: [user, assistant] } }));
    expect(dom.container.textContent).toContain('~5 tok/s');
    const corrected: AssistantMessage = { ...assistant, tokens: { input: 100, output: 90, reasoning: 10, cache: { read: 40, write: 0 } } };
    await act(async () => store().setState({ message: { [sessionId]: [user, corrected] } }));
    expect(dom.container.textContent).toContain('~17 tok/s');
    await act(async () => store().setState({ session: [{ ...session, revert: { messageID: user.id } }] }));
    expect(dom.container.textContent).not.toContain('~17 tok/s');
    await act(async () => store().setState({ session: [session] }));
    expect(dom.container.textContent).toContain('~17 tok/s');
    await act(async () => store().setState({ message: {} }));
    expect(dom.container.textContent).not.toContain('~17 tok/s');
  });

  test('runtime identity changes discard retained results even with equal directory and session IDs', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } },
      message: { [sessionId]: [user, assistant, nextUser] } }));
    expect(dom.container.textContent).toContain('~5 tok/s');
    Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://second-runtime.test', configurable: true });
    await render();
    expect(dom.container.textContent).not.toContain('~5 tok/s');
    Reflect.deleteProperty(window, '__OPENCHAMBER_API_BASE_URL__');
    await render();
    expect(dom.container.textContent).not.toContain('~5 tok/s');
    await act(async () => store().setState({ message: {}, part: {} }));
    const otherAssistant: AssistantMessage = { ...assistant, tokens: nextAssistant.tokens };
    const read = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({
      items: [{ info: user, parts: [] }, { info: otherAssistant, parts: [] }, { info: nextUser, parts: [] }], cursor: {},
    });
    try {
      await act(async () => { await messageLoader.ensure({ directory, sessionID: sessionId }); });
      expect(dom.container.textContent).toContain('900 ↑ · 120 ↓');
      expect(dom.container.textContent).not.toContain('100 ↑ · 30 ↓');
    } finally {
      read.mockRestore();
    }
  });

  test('the heading falls back to whole-turn speed when response speed is unavailable', async () => {
    await act(async () => store().setState({ sessionStatusReady: true, part: { [assistant.id]: [
      { id: 'text', type: 'text', sessionID: sessionId, messageID: assistant.id, text: 'Final reply', time: { start: 3000, end: 5000 } },
    ] } }));
    expect(dom.container.querySelector('button')?.textContent).toBe('Turn stats~10 tok/s');
    expect(dom.container.textContent).toContain('Response~10 tok/s');
    expect(dom.container.textContent).toContain('Avg speed~5 tok/s');
    await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    expect(dom.container.querySelector('button')?.textContent).toBe('Turn stats~5 tok/s');
    expect(dom.container.textContent).not.toContain('Response');
    expect(dom.container.textContent).toContain('Avg speed~5 tok/s');
  });

  test('every metric has a full-row focus target and hover waits 750ms', async () => {
    const earlier = { ...assistant, id: 'earlier', time: { created: 1100, completed: 1900 } };
    await act(async () => store().setState({ sessionStatusReady: true,
      message: { [sessionId]: [user, earlier, assistant] }, part: {
        earlier: [{ id: 'earlier-text', type: 'text', sessionID: sessionId, messageID: earlier.id, text: 'Earlier', time: { start: 1200, end: 1800 } }],
        [assistant.id]: [{ id: 'text', type: 'text', sessionID: sessionId, messageID: assistant.id, text: 'Final reply', time: { start: 3000, end: 5000 } }],
      },
    }));
    const triggers = dom.container.querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(triggers.length).toBe(10);
    for (const trigger of triggers) expect(trigger.tabIndex).toBe(0);
    expect(dom.container.querySelectorAll('[title]').length).toBe(0);
    const response = triggers[0];
    await act(async () => {
      response.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      response.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      response.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
      response.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    expect(response.hasAttribute('data-popup-open')).toBe(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(response.hasAttribute('data-popup-open')).toBe(true);
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('How fast the final text arrived');
    expect(dom.container.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  test('keyboard focus exposes the cost explanation without adding an icon or native title', async () => {
    await act(async () => store().setState({ sessionStatusReady: true }));
    const triggers = dom.container.querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    const cost = triggers[triggers.length - 1];
    await act(async () => cost.focus());
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Cost reported by the provider');
    expect(cost.querySelector('svg')).toBeNull();
    expect(cost.hasAttribute('title')).toBe(false);
  });
});
