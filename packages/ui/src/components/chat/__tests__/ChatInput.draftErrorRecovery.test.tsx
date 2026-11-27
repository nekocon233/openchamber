import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { toast } from 'sonner';
import type { NativeCompactRequest, NativePromptRequest, NativeSessionCreate, RuntimeAPIs } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { NativeAgentsRequestError } from '@/lib/native-agents/errors';
import { createTestNativeAgentsAPI } from '@/lib/native-agents/test-utils/runtime';
import { createProjectIdFromPath } from '@/lib/projectId';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!DOCTYPE html><html><body></body></html>');
Object.assign(globalThis, {
  Window,
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  ...Object.fromEntries(([
    'Node', 'Text', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLFormElement', 'Range', 'Selection', 'DocumentFragment', 'Event', 'KeyboardEvent',
    'MouseEvent', 'FocusEvent', 'InputEvent', 'CustomEvent', 'MutationObserver',
    'ResizeObserver', 'IntersectionObserver', 'HTMLDivElement', 'HTMLSpanElement',
    'SVGElement', 'ShadowRoot', 'CSSStyleSheet', 'DOMParser',
  ] satisfies (keyof Window)[]).map((name) => [name, browser[name]])),
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const DIRECTORY = '/opt/openchamber';
const PROJECTS = [{ id: createProjectIdFromPath(DIRECTORY), path: DIRECTORY }];
const SESSION_ID = 'ncv_1a3225d4-39b5-4534-9318-f82874de1d94';
const COMPACTION_SESSION_ID = 'ncv_1a3225d4-39b5-4534-9318-f82874de1d95';
const OTHER_SESSION_ID = 'ses_existing_other';

const responseFor = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
  const directory = decodeURIComponent(headers.get('x-opencode-directory') ?? url.searchParams.get('location[directory]') ?? DIRECTORY);
  const location = { directory, project: { id: 'project', directory, canonical: directory } };
  if (url.pathname === '/api/config/settings') return Response.json({ projects: PROJECTS });
  if (url.pathname.endsWith('/fs/home')) return Response.json({ home: '/home/test' });
  if (url.pathname.endsWith('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (url.pathname === '/api/config' || url.pathname === '/api/project') return Response.json([]);
  if (url.pathname.endsWith('/session/active')) return Response.json({ data: {} });
  if (url.pathname.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  if (url.pathname.endsWith('/location')) return Response.json(location);
  if (url.pathname.endsWith('/session')) return Response.json({ location, data: [], cursor: {} });
  return Response.json({ location, data: [], cursor: {} });
};
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => responseFor(input, init));

plugin({
  name: 'composer-draft-error-recovery-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { setOptimisticRefs } = await import('@/sync/session-actions');
const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useInputStore } = await import('@/sync/input-store');
const { useMessageQueueStore } = await import('@/stores/messageQueueStore');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { createChatDraftIdentity, readChatDraft } = await import('@/lib/chatDraftPersistence');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request, init) => responseFor(request, init),
});

let promptHandler: (sessionId: string, request: NativePromptRequest) => Promise<void>;
let compactHandler: (sessionId: string, request: NativeCompactRequest) => Promise<void>;
let createdRecord: Session;

const buildUnifiedSession = (input: NativeSessionCreate): Session => ({
  id: input.backend === 'claude' ? COMPACTION_SESSION_ID : SESSION_ID,
  projectID: '',
  directory: input.directory,
  title: input.title ?? 'New conversation',
  agent: input.kind === 'unified' ? input.selection.agent : 'build',
  model: input.kind === 'unified'
    ? { providerID: input.selection.model.providerID, id: input.selection.model.modelID, variant: input.selection.variant }
    : { providerID: 'antigravity-native', id: 'gemini-4-hydrogen', variant: 'xhigh' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: {
    openchamber: {
      native: {
        kind: 'unified',
        backend: input.backend,
        unifiedBackends: ['claude', 'codex', 'deepseek', 'antigravity'],
        revision: 0,
        recordRevision: 0,
        historyRevision: 0,
        sourceSessionID: null,
        switchReady: true,
        preparing: false,
        actions: { revert: true, delete: false, fork: true, compact: input.backend !== 'antigravity' },
      },
    },
  },
});

const nativeAgents = createTestNativeAgentsAPI({
  capabilities: async () => ({
    supported: true,
    unifiedSessions: true,
    unifiedBackends: ['claude', 'codex', 'deepseek', 'antigravity'],
    agentCombinations: true,
    registry: { reset: false },
    backends: {
      claude: { cli: true },
      codex: { cli: true },
      antigravity: { cli: true },
    },
  }),
  statuses: async () => ({}),
  questions: async () => ({ questions: [], unavailableSessionIds: [] }),
  commands: async () => ({ commands: [] }),
  catalog: async () => ({
    backends: {
      claude: { status: 'ok', models: [] },
      codex: { status: 'ok', models: [] },
      deepseek: { status: 'ok', models: [] },
      antigravity: {
        status: 'ok',
        models: [{
          id: 'gemini-4-hydrogen',
          name: 'Gemini 4 Hydrogen',
          contextWindow: 1_000_000,
          outputLimit: null,
          efforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'high',
          fast: false,
          input: { image: false, pdf: false },
          aliases: [],
        }],
      },
    },
  }),
  listSessions: async () => ({
    backends: {
      claude: { status: 'ok', sessions: [] },
      codex: { status: 'ok', sessions: [] },
      deepseek: { status: 'ok', sessions: [] },
      antigravity: { status: 'ok', sessions: [] },
    },
    unified: { status: 'ok', sessions: createdRecord ? [createdRecord] : [], unavailable: [] },
  }),
  createSession: async (input: NativeSessionCreate) => {
    createdRecord = buildUnifiedSession(input);
    return createdRecord;
  },
  getSession: async () => createdRecord,
  prompt: (sessionId: string, request: NativePromptRequest) => promptHandler(sessionId, request),
  compact: (sessionId: string, request: NativeCompactRequest) => compactHandler(sessionId, request),
});

// SAFETY: The composer reads only runtime, nativeAgents, and sourceControl identity in this fixture.
const runtimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  nativeAgents,
  sourceControl: {},
} as RuntimeAPIs;

const toastErrors: unknown[] = [];
spyOn(toast, 'error').mockImplementation((message) => {
  toastErrors.push(message);
  return 'toast-id';
});

const sampleAttachment = (): AttachedFile => ({
  id: 'att-1',
  file: new File(['notes'], 'notes.txt', { type: 'text/plain' }),
  dataUrl: 'data:text/plain;base64,bm90ZXM=',
  mimeType: 'text/plain',
  filename: 'notes.txt',
  size: 5,
  source: 'local',
});

const optimisticIds = new Set<string>();

beforeEach(() => {
  browser.localStorage.clear();
  toastErrors.length = 0;
  optimisticIds.clear();
  setOptimisticRefs(
    ({ message }) => { optimisticIds.add(message.id); },
    ({ messageID }) => { optimisticIds.delete(messageID); },
  );
  registerRuntimeAPIs(runtimeAPIs);
  useProjectsStore.setState({ projects: PROJECTS });
  useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
  useInlineCommentDraftStore.setState({ drafts: {} });
  useInputStore.setState({
    attachedFiles: [],
    attachmentDraftKey: null,
    attachmentDraftIdentity: null,
    attachmentDrafts: new Map(),
    pendingSyntheticParts: null,
  });
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  useConfigStore.setState({
    currentProviderId: 'antigravity-native',
    currentModelId: 'gemini-4-hydrogen',
    currentVariant: 'xhigh',
    currentAgentName: 'build',
    providersLoaded: true,
    agentsLoaded: true,
    isConnected: true,
    hasEverConnected: true,
  });
  useSessionUIStore.getState().openNewSessionDraft({ target: 'project', directoryOverride: DIRECTORY });
  compactHandler = async () => { throw new Error('Unexpected compaction request'); };
  promptHandler = async () => {
    throw new NativeAgentsRequestError(
      'invalid model selection (--model "gemini-4-hydrogen" --effort "xhigh"): --effort=xhigh is not supported for model "gemini-4-hydrogen"',
      502,
      'NATIVE_ANTIGRAVITY_ERROR',
    );
  };
});

afterAll(() => {
  browser.close();
});

const mountComposer = async (run: (ctx: { view: InstanceType<typeof EditorView>; form: HTMLFormElement }) => Promise<void>) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={DIRECTORY}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => {
      await ensureHomeDirectoryResolved();
      await updateDesktopSettings({});
      useSessionUIStore.getState().openNewSessionDraft({ target: 'project', directoryOverride: DIRECTORY });
      useConfigStore.setState({
        currentProviderId: 'antigravity-native',
        currentModelId: 'gemini-4-hydrogen',
        currentVariant: 'xhigh',
        currentAgentName: 'build',
      });
    });
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('Composer did not mount');
    await run({ view, form });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

test('restores the prompt onto the materialized session and shows an error toast when the first send fails', async () => {
  await mountComposer(async ({ view, form }) => {
    const attachment = sampleAttachment();
    await act(async () => {
      useInputStore.getState().setAttachedFiles([attachment]);
      useInlineCommentDraftStore.getState().addDraft(
        { directory: DIRECTORY, sessionKey: 'draft' },
        {
          source: 'file',
          fileLabel: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          code: 'quoted line',
          language: 'ts',
          text: 'explain this',
        },
      );
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '你好，你是什么模型' }, userEvent: 'input.type' });
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);
    expect([...optimisticIds]).toEqual([]);
    expect(view.state.doc.toString()).toBe('你好，你是什么模型');
    expect(toastErrors).toEqual([
      'invalid model selection (--model "gemini-4-hydrogen" --effort "xhigh"): --effort=xhigh is not supported for model "gemini-4-hydrogen"',
    ]);

    const runtimeKey = getRuntimeKey();
    expect(readChatDraft(createChatDraftIdentity(runtimeKey, DIRECTORY, SESSION_ID)).text).toBe('你好，你是什么模型');
    expect(readChatDraft(createChatDraftIdentity(runtimeKey, DIRECTORY, null)).text).toBe('');
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['att-1']);
    expect(
      useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: SESSION_ID }).map((draft) => draft.text),
    ).toEqual(['explain this']);
  });
});

test('submits /compact as a native session action and restores the command on refusal', async () => {
  const text = '/compact Keep the plan.\nRetain test results.';
  const model = { providerID: 'claude-native', modelID: 'sonnet' };
  const requests: Array<{ sessionId: string; request: NativeCompactRequest }> = [];
  const prompts: NativePromptRequest[] = [];
  promptHandler = async (_sessionId, request) => { prompts.push(request); };
  compactHandler = async (sessionId, request) => {
    requests.push({ sessionId, request });
    if (requests.length === 1) throw new NativeAgentsRequestError('Session is busy', 409, 'NATIVE_SESSION_BUSY');
  };

  await mountComposer(async ({ view, form }) => {
    await act(async () => {
      const session = await nativeAgents.createSession({ backend: 'claude', kind: 'unified', directory: DIRECTORY, selection: { model, agent: 'plan', variant: 'high' } });
      useSessionUIStore.getState().setCurrentSession(session.id, DIRECTORY);
      useConfigStore.setState({
        currentProviderId: model.providerID, currentModelId: model.modelID, currentAgentName: 'plan', currentVariant: 'high',
      });
    });
    await act(async () => {
      useInputStore.getState().setAttachedFiles([sampleAttachment()]);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });

    await act(async () => { form.requestSubmit(); });
    expect(requests).toEqual([{
      sessionId: COMPACTION_SESSION_ID,
      request: { directory: DIRECTORY, model, agent: 'plan', variant: 'high', instructions: 'Keep the plan.\nRetain test results.' },
    }]);
    expect(view.state.doc.toString()).toBe(text);
    expect(toastErrors).toEqual(['Session is busy']);

    await act(async () => { form.requestSubmit(); });
    expect(requests).toHaveLength(2);
    expect(prompts).toEqual([]);
    expect([...optimisticIds]).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['att-1']);
  });
});

test('stores the failed first prompt on the materialized session when the user navigates away mid-send', async () => {
  let rejectPrompt!: (error: Error) => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  promptHandler = () => new Promise<void>((_resolve, reject) => {
    rejectPrompt = reject;
    markPromptStarted();
  });

  await mountComposer(async ({ view, form }) => {
    const attachment = sampleAttachment();
    await act(async () => {
      useInputStore.getState().setAttachedFiles([attachment]);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '你好，你是什么模型' }, userEvent: 'input.type' });
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await promptStarted;
    });
    expect(useSessionUIStore.getState().currentSessionId).toBe(SESSION_ID);

    await act(async () => {
      useSessionUIStore.getState().setCurrentSession(OTHER_SESSION_ID, DIRECTORY);
    });

    await act(async () => {
      rejectPrompt(new NativeAgentsRequestError('startup refused', 502, 'NATIVE_ANTIGRAVITY_ERROR'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(view.state.doc.toString()).toBe('');
    expect(toastErrors).toEqual([]);
    expect(useInputStore.getState().attachedFiles).toEqual([]);

    await act(async () => {
      useSessionUIStore.getState().setCurrentSession(SESSION_ID, DIRECTORY);
    });

    expect(view.state.doc.toString()).toBe('你好，你是什么模型');
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['att-1']);
  });
});

test('merges typed follow-up text once without duplicating the failed prompt', async () => {
  let rejectPrompt!: (error: Error) => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  promptHandler = () => new Promise<void>((_resolve, reject) => {
    rejectPrompt = reject;
    markPromptStarted();
  });

  await mountComposer(async ({ view, form }) => {
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'first prompt' }, userEvent: 'input.type' });
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await promptStarted;
    });

    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'second thought' }, userEvent: 'input.type' });
    });

    await act(async () => {
      rejectPrompt(new NativeAgentsRequestError('startup refused', 502, 'NATIVE_ANTIGRAVITY_ERROR'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(view.state.doc.toString()).toBe('first prompt\n\nsecond thought\n\n');
    expect(toastErrors).toEqual(['startup refused']);
  });
});

test('restores onto the open managed chat draft and shows a toast when session creation fails after directory preparation', async () => {
  const createSpy = spyOn(nativeAgents, 'createSession').mockRejectedValueOnce(new Error('backend offline'));
  const prepareSpy = spyOn(useSessionUIStore.getState(), 'prepareChatDraftDirectory').mockResolvedValue('/tmp/managed-chat');
  try {
    await mountComposer(async ({ view, form }) => {
      await act(async () => {
        useSessionUIStore.getState().openNewSessionDraft({ target: 'chat' });
      });
      await act(async () => {
        useInputStore.getState().setPendingSyntheticParts([{ text: 'pinned context', synthetic: true }]);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'managed chat draft' }, userEvent: 'input.type' });
      });

      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(useSessionUIStore.getState().currentSessionId).toBeNull();
      expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
      expect(view.state.doc.toString()).toBe('managed chat draft');
      expect(useInputStore.getState().getPendingSyntheticParts()?.map((part) => part.text)).toEqual(['pinned context']);
      expect(toastErrors).toEqual(['Failed to create session']);
    });
  } finally {
    prepareSpy.mockRestore();
    createSpy.mockRestore();
  }
});

test('restores onto the materialized OpenCode session when ask permission setup fails after creation', async () => {
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { usePermissionStore } = await import('@/stores/permissionStore');
  const createdOpenCodeSession: Session = {
    id: 'ses_ask_fail',
    projectID: 'project',
    directory: DIRECTORY,
    title: 'New session',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
  const createSpy = spyOn(opencodeClient, 'createSession').mockResolvedValueOnce(createdOpenCodeSession);
  const modeSpy = spyOn(usePermissionStore.getState(), 'setSessionMode').mockRejectedValueOnce(new Error('permission write refused'));
  try {
    await mountComposer(async ({ view, form }) => {
      await act(async () => {
        useSessionUIStore.getState().openNewSessionDraft({ target: 'project', directoryOverride: DIRECTORY, permissionMode: 'ask' });
      });
      await act(async () => {
        useConfigStore.setState({
          currentProviderId: 'provider',
          currentModelId: 'model',
          currentVariant: undefined,
          currentAgentName: 'build',
        });
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'ask mode prompt' }, userEvent: 'input.type' });
      });

      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_ask_fail');
      expect(view.state.doc.toString()).toBe('ask mode prompt');
      expect(toastErrors).toEqual(['permission write refused']);
    });
  } finally {
    modeSpy.mockRestore();
    createSpy.mockRestore();
  }
});

test('magic prompt command failure merges follow-up typing once without duplicating the command', async () => {
  let rejectPrompt!: (error: Error) => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  promptHandler = () => new Promise<void>((_resolve, reject) => {
    rejectPrompt = reject;
    markPromptStarted();
  });

  await mountComposer(async ({ view, form }) => {
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '/workspace-review' }, userEvent: 'input.type' });
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await promptStarted;
    });

    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'extra note' }, userEvent: 'input.type' });
    });

    await act(async () => {
      rejectPrompt(new NativeAgentsRequestError('review startup refused', 502, 'NATIVE_ANTIGRAVITY_ERROR'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(view.state.doc.toString()).toBe('/workspace-review\n\nextra note\n\n');
    expect(toastErrors).toEqual(['review startup refused']);
  });
});
