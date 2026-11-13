import { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from "@opencode/client"
import { type ToolPart as ToolPartData } from "@/lib/opencode/model"
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
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

const nativeEdit = toolPart('prt_native_edit', 'edit', {
  status: 'completed', input: { filePath: 'hello.txt' }, output: 'Edit applied.', title: 'hello.txt',
  metadata: { nativeBackend: 'antigravity', nativeDiffScope: 'replacement',
    diff: '--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hello\n+hello there\n' },
  time: { start: 1, end: 2 },
});

const replacementPath = '/tmp/an-isolated-worktree-with-a-long-name/packages/ui/src/example.ts';
const replacementPatch = `--- ${replacementPath}\n+++ ${replacementPath}\n@@ -1,3 +1,3 @@\n-unchanged before\n-old value\n-unchanged after\n+unchanged before\n+new value\n+unchanged after\n`;
const replacementEdit = toolPart('prt_replacement', 'edit', {
  status: 'completed', input: { filePath: replacementPath, oldString: 'unchanged before\nold value\nunchanged after\n', newString: 'unchanged before\nnew value\nunchanged after\n' },
  output: '', metadata: { nativeBackend: 'antigravity', nativeDiffScope: 'replacement',
    files: [{ filePath: replacementPath, type: 'update', diff: replacementPatch }], diff: replacementPatch },
  time: { start: 1, end: 2 },
});

const failed = toolPart('prt_failed', 'bash', {
  status: 'error',
  input: { command: 'ls /missing' },
  error: 'ls: /missing: No such file or directory\nexit code 1',
  time: { start: 1, end: 2 },
});

const checklistState: Extract<ToolPartData['state'], { status: 'completed' }> = {
  status: 'completed',
  input: { todos: [
    { id: 'research', content: 'Read the current implementation', status: 'completed' },
    { id: 'implement', content: 'Update the checklist display', status: 'in_progress' },
    { id: 'verify', content: 'Verify desktop and mobile', status: 'pending' },
  ] },
  output: '{"openchamberChecklist":1,"digest":"internal-receipt"}',
  metadata: { nativeBackend: 'antigravity', openchamberToolSource: 'mcp' },
  time: { start: 1, end: 2 },
};
const checklist = toolPart('prt_checklist', 'openchamber_checklist_update_checklist', checklistState);

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
        <SyncProvider sdk={sdk} directory="/workspace">
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

    await render(nativeEdit);
    expect(container.textContent).toContain('Replacement preview without file line numbers.');
    expect(container.textContent).toContain('-hello');
    expect(container.textContent).toContain('+hello there');
    expect(container.textContent).not.toContain('1-hello');
    expect(container.textContent).not.toContain('1+hello there');
    expect(row()?.textContent).not.toContain('+1-1');

    await render(replacementEdit);
    expect(row()?.textContent).toBe(`Edit(${replacementPath})`);
    expect([...container.querySelectorAll(`[title="${replacementPath}"]`)].some((element) => element.textContent === replacementPath)).toBe(true);
    expect(container.textContent?.split('unchanged before')).toHaveLength(2);
    expect(container.querySelectorAll('[style*="--tools-edit-removed-bg"]')).toHaveLength(1);
    expect(container.querySelectorAll('[style*="--tools-edit-added-bg"]')).toHaveLength(1);
    await render(replacementEdit, true);
    expect(container.textContent?.split('unchanged before')).toHaveLength(2);
    expect(container.querySelectorAll('[style*="--tools-edit-removed-bg"]')).toHaveLength(1);
    expect(container.querySelectorAll('[style*="--tools-edit-added-bg"]')).toHaveLength(1);

    const completeWrite = toolPart('prt_write_complete', 'write', {
      status: 'completed', input: { filePath: '/workspace/src/created.ts', content: 'export const a = 1;\nexport const b = 2;' },
      output: 'Created file.', metadata: { nativeBackend: 'antigravity' }, time: { start: 1, end: 2 },
    });
    await render(completeWrite);
    expect(row()?.textContent).toBe('Write(/workspace/src/created.ts)+2');
    expect(container.textContent).toContain('1+export const a = 1;');
    expect(container.textContent).toContain('2+export const b = 2;');

    const pathOnlyWrite = toolPart('prt_write_path_only', 'write', {
      status: 'completed', input: { Path: '/workspace/src/pending.ts', filePath: '/workspace/src/pending.ts' },
      output: 'Created file.', metadata: { nativeBackend: 'antigravity' }, time: { start: 1, end: 2 },
    });
    await render(pathOnlyWrite);
    expect(row()?.textContent).toBe('Write(/workspace/src/pending.ts)');
    expect(container.querySelectorAll('[style*="--tools-edit-added-bg"]')).toHaveLength(0);
    await render(pathOnlyWrite, true);
    expect(container.textContent).not.toContain('+Path:');
    expect(container.textContent).not.toContain('File path:');
    expect(container.textContent).toContain('Created file.');

    const truncatedWrite = toolPart('prt_write_truncated', 'write', {
      status: 'completed', input: { filePath: '/workspace/src/partial.ts', content: 'partial line' },
      output: 'Created file.', metadata: { nativeBackend: 'antigravity', nativeInputTruncated: true }, time: { start: 1, end: 2 },
    });
    await render(truncatedWrite);
    expect(row()?.textContent).toBe('Write(/workspace/src/partial.ts)');
    expect(container.textContent).not.toContain('partial line');
    await render(truncatedWrite, true);
    expect(container.textContent).not.toContain('partial line');
    expect(container.textContent).toContain('Created file.');

    const failedWrite = toolPart('prt_write_failed', 'write', {
      status: 'error', input: { filePath: '/workspace/src/exists.ts', content: 'export const blocked = true;' },
      error: 'exists.ts already exists.', metadata: { nativeBackend: 'antigravity' }, time: { start: 1, end: 2 },
    });
    await render(failedWrite);
    expect(row()?.textContent).toBe('Write(/workspace/src/exists.ts)exists.ts already exists.');
    expect(row()?.textContent).not.toContain('+1');
    await render(failedWrite, true);
    expect(container.textContent).toContain('exists.ts already exists.');
    expect(container.textContent).not.toContain('--- /dev/null');

    const nativePatchPath = '/workspace/packages/ui/src/native.ts';
    const nativePatchFiles = [
      { filePath: nativePatchPath, type: 'update', diff: '--- a/native.ts\n+++ b/native.ts\n@@ -1 +1 @@\n-before\n+after\n', additions: 1, deletions: 1 },
      { filePath: '/workspace/packages/ui/src/deleted.ts', type: 'delete', diff: '', additions: 0, deletions: 1 },
    ];
    const nativePatchState: Extract<ToolPartData['state'], { status: 'completed' }> = {
      status: 'completed', input: { files: [nativePatchPath] }, output: '',
      metadata: { files: nativePatchFiles.slice(0, 1) }, time: { start: 1, end: 2 },
    };
    await render(toolPart('prt_native_patch', 'apply_patch', nativePatchState));
    expect(row()?.textContent).toBe(`Patch(${nativePatchPath})+1-1`);
    await render(toolPart('prt_native_patch_running', 'apply_patch', {
      status: 'running', input: { files: [nativePatchPath] }, time: { start: 1 },
    }));
    expect(row()?.textContent).toBe(`Patch(${nativePatchPath})`);
    await render(toolPart('prt_native_patch_failed', 'apply_patch', {
      status: 'error', input: { files: [nativePatchPath] }, error: 'Patch rejected.', time: { start: 1, end: 2 },
    }));
    expect(row()?.textContent).toBe(`Patch(${nativePatchPath})Patch rejected.`);
    await render(toolPart('prt_native_patch_deleted', 'apply_patch', {
      ...nativePatchState, metadata: { files: nativePatchFiles.slice(1) },
    }));
    expect(row()?.textContent).toContain('Patch(/workspace/packages/ui/src/deleted.ts)');
    await render(toolPart('prt_native_patch_many', 'apply_patch', {
      ...nativePatchState, metadata: { files: nativePatchFiles },
    }));
    expect(row()?.textContent).toContain(`Patch(${nativePatchPath}, /workspace/packages/ui/src/deleted.ts)`);

    // Standard headers also keep native paths when records repeat a file or
    // include a malformed sibling, rather than switching to an empty chip row.
    await act(async () => { useUIStore.setState({ conciseTranscript: false }); });
    for (const files of [nativePatchFiles, [nativePatchFiles[0], nativePatchFiles[0]], [nativePatchFiles[0], null],
      [{ ...nativePatchFiles[0], file: '' }, nativePatchFiles[1]]]) {
      await render(toolPart('prt_native_standard', 'apply_patch', {
        ...nativePatchState, metadata: { files },
      }));
      expect(container.querySelector('[role="button"]')?.textContent).toContain(nativePatchPath);
    }
    await act(async () => { useUIStore.setState({ conciseTranscript: true }); });

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

    await render(checklist);
    expect(row()?.textContent).toBe('Update checklist(Completed: 1 / 3)');
    expect(container.textContent).not.toContain('Read the current implementation');
    await render(checklist, true);
    expect(container.querySelectorAll('[data-checklist-item-id]')).toHaveLength(3);
    expect(container.textContent).toContain('Read the current implementation');
    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('Pending');
    expect(container.textContent).not.toContain('internal-receipt');
    expect(container.textContent).not.toContain('openchamber_checklist_update_checklist');

    await act(async () => { await useI18nStore.getState().setLocale('zh-CN'); });
    expect(row()?.textContent).toBe('更新任务清单(已完成：1 / 3)');
    expect(container.textContent).toContain('进行中');
    expect(container.querySelectorAll('[data-checklist-item-id]')).toHaveLength(3);
    await act(async () => { await useI18nStore.getState().setLocale('en'); });

    await render({ ...checklist, state: { ...checklistState, input: { todos: [] } } }, true);
    expect(container.textContent).toContain('Checklist cleared.');
    expect(container.textContent).toContain('Completed: 0 / 0');
    await render({ ...checklist, state: { ...checklistState, input: { todos: [{ content: 'Partial task' }] } } }, true);
    expect(container.textContent).toContain('Partial task');
    expect(container.textContent).not.toContain('Completed: 0 / 0');
    expect(container.querySelector('[data-checklist-item-id]')).toBeNull();

    for (const input of [checklistState.input, { todos: [] }]) {
      await render({ ...checklist, state: { ...checklistState, input, metadata: { nativeInputTruncated: true } } }, true);
      expect(container.querySelector('[data-checklist-item-id]')).toBeNull();
      expect(container.textContent).not.toContain('Completed:');
      expect(container.textContent).not.toContain('Checklist cleared.');
    }

    await render(toolPart('prt_checklist_error', checklist.tool, {
      status: 'error', input: checklistState.input, error: 'Checklist update was rejected.',
      time: { start: 1, end: 2 },
    }), true);
    expect(container.textContent).toContain('Checklist update was rejected.');
    expect(container.textContent).not.toContain('Completed: 1 / 3');
    expect(container.querySelector('[data-checklist-item-id]')).toBeNull();

    // Turning the setting off brings back the standard row.
    await act(async () => { useUIStore.setState({ conciseTranscript: false }); });
    await render(checklist, true);
    expect(container.textContent).toContain('Update checklist');
    expect(container.textContent).toContain('Completed: 1 / 3');
    expect(container.querySelectorAll('[data-checklist-item-id]')).toHaveLength(3);
    expect(container.textContent).not.toContain('internal-receipt');
    await render(bash);
    expect(container.textContent).toContain('Shell Command');
    expect(container.textContent).not.toContain('Bash(ls -la)');
  } finally {
    await act(async () => { root.unmount(); });
    await useI18nStore.getState().setLocale('en');
    useUIStore.setState({ conciseTranscript: useUIStore.getInitialState().conciseTranscript });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
