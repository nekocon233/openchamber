import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from "@opencode/client"
import { type ToolPart as ToolPartData } from "@/lib/opencode/model"
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useUIStore } from '@/stores/useUIStore';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-concise-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme,
  availableThemes: [theme],
  setTheme: unexpectedThemeChange,
  customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange,
  importTheme: unexpectedThemeChange,
  deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [],
  isSystemPreference: false,
  setSystemPreference: unexpectedThemeChange,
  themeMode: 'light',
  setThemeMode: unexpectedThemeChange,
  lightThemeId: theme.metadata.id,
  darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange,
  setDarkThemePreference: unexpectedThemeChange,
};

const toolPart = (id: string, tool: string, state: ToolPartData['state']): ToolPartData => ({
  id, sessionID: 'ses_concise', messageID: 'msg_concise', type: 'tool', tool, callID: `call_${id}`, state,
});

const bash = toolPart('prt_bash', 'bash', {
  status: 'completed',
  input: { command: 'ls -la' },
  output: 'total 8\nnotes.txt\nhello.txt\n',
  title: 'ls -la',
  metadata: {},
  time: { start: 1, end: 2 },
});

const edit = toolPart('prt_edit', 'edit', {
  status: 'completed',
  input: { filePath: 'hello.txt', oldString: 'hello', newString: 'hello there' },
  output: 'Edit applied.',
  title: 'hello.txt',
  metadata: { diff: '--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+hello there\n' },
  time: { start: 1, end: 2 },
});

const failed = toolPart('prt_failed', 'bash', {
  status: 'error',
  input: { command: 'ls /missing' },
  error: 'ls: /missing: No such file or directory\nexit code 1',
  time: { start: 1, end: 2 },
});

// Commands whose file changes Claude Code recorded, as the native server
// projects them: the diffs it kept, and the files it named without one.
const recordedDiff = '--- /p/src/a.cs\n+++ /p/src/a.cs\n@@ -1,1 +1,1 @@\n-old line\n+new line\n';
const commandWithDiff = toolPart('prt_command_diff', 'bash', {
  status: 'completed',
  input: { command: 'python3 edit.py', description: 'Rewrite the parser' },
  output: 'done\n',
  metadata: {
    files: [{ filePath: '/p/src/a.cs', type: 'update', diff: recordedDiff, additions: 1, deletions: 1 }],
    diff: recordedDiff,
    recordedFileChanges: { withoutDiff: [], unnamed: 0 },
  },
  time: { start: 1, end: 2 },
});
const commandNamesOnly = toolPart('prt_command_names', 'bash', {
  status: 'completed',
  input: { command: 'cat > /p/src/Big.cs' },
  output: '',
  metadata: { recordedFileChanges: { withoutDiff: ['/p/src/Big.cs'], unnamed: 0 } },
  time: { start: 1, end: 2 },
});
const commandManyNames = toolPart('prt_command_many', 'bash', {
  status: 'completed',
  input: { command: 'python3 gen.py' },
  output: 'done\n',
  metadata: { recordedFileChanges: { withoutDiff: [1, 2, 3, 4, 5, 6].map((index) => `/p/gen/${index}.txt`), unnamed: 0 } },
  time: { start: 1, end: 2 },
});

test('the concise transcript shows a call as Name(argument) over one result line, details folded', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });
  const toggled: string[] = [];
  const render = async (part: ToolPartData, isExpanded = false) => {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <ThemeSystemContext.Provider value={themeContext}>
              <ToolPart part={part} isExpanded={isExpanded} isMobile={false} onToggle={(id) => { toggled.push(id); }} />
            </ThemeSystemContext.Provider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    // Let the row's timers and deferred mounts land inside act.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  };
  const row = () => container.querySelector<HTMLElement>('[role="button"][aria-expanded]');

  try {
    useUIStore.setState({ conciseTranscript: true });

    await render(bash);
    expect(row()?.textContent).toBe('Bash(ls -la)3 lines');
    expect(row()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('notes.txt');
    await act(async () => { row()?.click(); });
    expect(toggled).toEqual(['prt_bash']);

    await render(edit);
    expect(row()?.textContent).toContain('Edit(hello.txt)');
    expect(row()?.textContent).toContain('+1-1');
    // What the edit did shows under it, line by line.
    expect(container.textContent).toContain('1-hello');
    expect(container.textContent).toContain('1+hello there');

    await render(failed);
    expect(row()?.textContent).toBe('Bash(ls /missing)ls: /missing: No such file or directory');

    // A command shows what it changed, the file named even when it is the only one.
    await render(commandWithDiff);
    expect(row()?.textContent).toBe('Bash(python3 edit.py)+1-1');
    expect(container.textContent).toContain('/p/src/a.cs');
    expect(container.textContent).toContain('1-old line');
    expect(container.textContent).toContain('1+new line');

    // A file without a diff shows by name, and the row gives no partial total.
    await render(commandNamesOnly);
    expect(row()?.textContent).toBe('Bash(cat > /p/src/Big.cs)');
    expect(container.textContent).toContain('Changed without a diff to show: binary, mode only or too large/p/src/Big.cs');

    await render(commandManyNames);
    expect(container.textContent).toContain('/p/gen/5.txt');
    expect(container.textContent).not.toContain('/p/gen/6.txt');
    expect(container.textContent).toContain('+1 more file');

    // Turning the setting off brings back the standard row.
    await act(async () => { useUIStore.setState({ conciseTranscript: false }); });
    await render(bash);
    expect(container.textContent).toContain('Shell Command');
    expect(container.textContent).not.toContain('Bash(ls -la)');
  } finally {
    await act(async () => { root.unmount(); });
    useUIStore.setState({ conciseTranscript: useUIStore.getInitialState().conciseTranscript });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
