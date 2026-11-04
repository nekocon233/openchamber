import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Event: dom.Event, CustomEvent: dom.CustomEvent,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/auth/url-token') return new Response(null, { status: 404 });
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/chats' });
  return new Promise<Response>(() => {});
}, originalFetch);

const { useSessionUIStore } = await import('./session-ui-store');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const initialRuntime = getRuntimeKey();

afterAll(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: initialRuntime });
  globalThis.fetch = originalFetch;
  dom.happyDOM.cancelAsync();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('tool navigation return', () => {
  test('restores a prepared chat draft and its manual selections without changing the other directory', () => {
    const directory = '/chats/prepared-origin';
    const draft = { ...useSessionUIStore.getInitialState().newSessionDraft, draftId: 41, open: true,
      preparedChatDirectory: directory, title: 'original draft' };
    useProjectsStore.setState({ projects: [{ id: 'source', path: '/source', addedAt: 1 }], activeProjectId: 'source' });
    useDirectoryStore.setState({ currentDirectory: directory });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: draft });
    void useConfigStore.getState().activateDirectory(directory);
    useConfigStore.setState({ providers: [{ id: 'origin-provider', name: 'Origin', activation: 'enabled', package: 'fixture', models: [] }] });
    useConfigStore.getState().setProvider('origin-provider');
    useConfigStore.getState().setModel('origin-model');
    useConfigStore.getState().setCurrentVariantOverride('max', undefined);
    const restore = useSessionUIStore.getState().captureNavigationReturn(directory);

    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: 'source', directoryOverride: '/source' });
    useConfigStore.setState({ providers: [{ id: 'source-provider', name: 'Source', activation: 'enabled', package: 'fixture', models: [] }] });
    useConfigStore.getState().setProvider('source-provider');
    useConfigStore.getState().setModel('source-model');
    const sourceConfigKey = useConfigStore.getState().activeDirectoryKey;
    restore();

    expect(useSessionUIStore.getState().newSessionDraft).toEqual(draft);
    expect(useDirectoryStore.getState().currentDirectory).toBe(directory);
    expect(useConfigStore.getState().currentProviderId).toBe('origin-provider');
    expect(useConfigStore.getState().currentModelId).toBe('origin-model');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe('max');
    expect(useConfigStore.getState().selectionSource).toBe('manual');
    expect(useConfigStore.getState().directoryScoped[sourceConfigKey]?.currentModelId).toBe('source-model');
  });

  test('a return captured on another runtime cannot replace the current navigation', () => {
    const restore = useSessionUIStore.getState().captureNavigationReturn('/chats/prepared-origin');
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example', runtimeKey: 'other-runtime' });
    const current = useSessionUIStore.getState();
    restore();
    expect(useSessionUIStore.getState()).toBe(current);
  });
});
