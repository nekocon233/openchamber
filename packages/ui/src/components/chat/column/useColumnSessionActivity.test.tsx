import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { OpenCodeClient } from '@/lib/opencode/client';
import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from '@/lib/opencode/model';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { SyncProvider } from '@/sync/sync-context';
import type { useSync } from '@/sync/use-sync';
import { useColumnSessionActivity } from './useColumnSessionActivity';

const DIRECTORY = '/repo';
const SESSION_A = 'ncv_e4b756f7-72d3-43ef-9c8a-1aafdaaaf3ac';
const SESSION_B = 'ncv_11111111-2222-4333-8444-555555555555';

const runningPlanExit = (sessionID: string): Array<{ info: Message; parts: Part[] }> => {
  const user: UserMessage = {
    id: 'msg_u',
    sessionID,
    role: 'user',
    time: { created: 1 },
    agent: 'plan',
    model: { providerID: 'claude-native', modelID: 'fable' },
  };
  const assistant: AssistantMessage = {
    id: 'msg_a',
    sessionID,
    role: 'assistant',
    parentID: 'msg_u',
    time: { created: 2 },
    providerID: 'claude-native',
    modelID: 'fable',
    agent: 'plan',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const planPart: ToolPart = {
    id: 'part_plan',
    sessionID,
    messageID: 'msg_a',
    callID: 'call_plan',
    type: 'tool',
    tool: 'plan_exit',
    state: { status: 'running', input: { plan: '# Plan' }, time: { start: 2 } },
  };
  return [
    { info: user, parts: [] },
    { info: assistant, parts: [planPart] },
  ];
};

const makeSync = (recoverPendingQuestions: ReturnType<typeof useSync>['recoverPendingQuestions']): ReturnType<typeof useSync> => ({
  ensureSessionRenderable: async () => undefined,
  syncSession: async () => undefined,
  prefetchSession: async () => undefined,
  loadMore: async () => undefined,
  hasMore: () => false,
  isLoading: () => false,
  isComplete: () => true,
  recoverPendingQuestions,
  optimistic: {
    add: () => undefined,
    remove: () => undefined,
    confirm: () => undefined,
  },
});

const stoppedSpaceEntry = (id: string): SpaceEntry => ({
  id,
  name: 'Stopped space',
  placeId: 'local',
  machine: null,
  projectDirectory: DIRECTORY,
  directory: `/spaces/${id}`,
  projectFolder: { path: DIRECTORY, found: true },
  state: 'exited',
  stoppedIdle: false,
  step: null,
  failure: null,
  network: null,
  grants: [],
  access: null,
  needsAccess: [],
  accessFailures: [],
  damage: null,
  setup: null,
  taskTitle: null,
});

const idleEvents = ({ signal }: { signal?: AbortSignal } = {}) => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<never>>((resolve) => {
      const done = () => resolve({ value: undefined, done: true });
      if (signal?.aborted) done();
      else signal?.addEventListener('abort', done, { once: true });
    }),
  }),
});

// SAFETY: SyncProvider only invokes sdk.event.subscribe on the event pipeline during these tests.
const stubSdk = { event: { subscribe: idleEvents } } as OpenCodeClient;

let dom: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useSpacesStore.setState({ journey: null });
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

const Harness = ({
  active = true,
  currentSessionId,
  effectiveSessionDirectory = DIRECTORY,
  sessionMessages = [],
  sync,
}: {
  active?: boolean;
  currentSessionId: string | null;
  effectiveSessionDirectory?: string;
  sessionMessages?: Array<{ info: Message; parts: Part[] }>;
  sync: ReturnType<typeof useSync>;
}) => {
  useColumnSessionActivity({
    active,
    currentSessionId,
    effectiveSessionDirectory,
    sessionMessages,
    sync,
  });
  return null;
};

describe('useColumnSessionActivity form reconciliation', () => {
  test('reconciles pending forms once on each cached session visit and skips duplicate calls for active plan_exit tools', async () => {
    const calls: Array<{ sessionId: string; directory?: string }> = [];
    const sync = makeSync(async (sessionId, directory) => {
      calls.push({ sessionId, directory });
      return true;
    });

    const renderWith = async (props: React.ComponentProps<typeof Harness>) => {
      await act(async () => {
        root.render(
          <SyncProvider directory={DIRECTORY} sdk={stubSdk}>
            <Harness {...props} />
          </SyncProvider>,
        );
      });
    };

    // Cached session with no active tool parts still reconciles forms once on visit.
    await renderWith({ currentSessionId: SESSION_A, sessionMessages: [], sync });
    expect(calls).toEqual([{ sessionId: SESSION_A, directory: DIRECTORY }]);

    // Re-rendering the same session with unchanged identity does not re-fetch.
    await renderWith({ currentSessionId: SESSION_A, sessionMessages: [], sync });
    expect(calls).toHaveLength(1);

    // Switching to another session with a running plan_exit tool reconciles once via the retry path, not twice.
    await renderWith({ currentSessionId: SESSION_B, sessionMessages: runningPlanExit(SESSION_B), sync });
    expect(calls).toEqual([
      { sessionId: SESSION_A, directory: DIRECTORY },
      { sessionId: SESSION_B, directory: DIRECTORY },
    ]);

    // Revisiting the first cached session reconciles again once.
    await renderWith({ currentSessionId: SESSION_A, sessionMessages: [], sync });
    expect(calls).toEqual([
      { sessionId: SESSION_A, directory: DIRECTORY },
      { sessionId: SESSION_B, directory: DIRECTORY },
      { sessionId: SESSION_A, directory: DIRECTORY },
    ]);
  });

  test('skips form reconciliation while inactive or for a stopped space directory', async () => {
    const calls: string[] = [];
    const sync = makeSync(async (sessionId) => {
      calls.push(sessionId);
      return false;
    });

    const renderWith = async (props: React.ComponentProps<typeof Harness>) => {
      await act(async () => {
        root.render(
          <SyncProvider directory={DIRECTORY} sdk={stubSdk}>
            <Harness {...props} />
          </SyncProvider>,
        );
      });
    };

    await renderWith({ active: false, currentSessionId: SESSION_A, sync });
    expect(calls).toEqual([]);

    const stoppedId = '0123456789ab';
    useSpacesStore.setState({
      journey: new Map([[stoppedId, stoppedSpaceEntry(stoppedId)]]),
    });
    await renderWith({ active: true, currentSessionId: SESSION_A, effectiveSessionDirectory: `/spaces/${stoppedId}`, sync });
    expect(calls).toEqual([]);
  });
});
