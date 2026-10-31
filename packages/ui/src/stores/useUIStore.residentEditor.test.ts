import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';
import { useFilesViewTabsStore } from './useFilesViewTabsStore';
import { getZoneView, resolveZoneActiveTab } from '@/lib/workspace/zones';
import { readAutoSaveSnapshot } from '@/lib/settings/registry';
import { getEditorDiffTabState } from '@/lib/workspace/editorTabs';

const initial = useUIStore.getState();
const originalFiles = useFilesViewTabsStore.getState();
const directory = '/repo';
beforeEach(() => {
  useUIStore.setState({ ...useUIStore.getInitialState(), workspaceLayout: 'editor', isMobile: false }, true);
  useFilesViewTabsStore.setState({ byRoot: {} });
});
afterEach(() => {
  useUIStore.setState(initial, true);
  useFilesViewTabsStore.setState(originalFiles, true);
});
const selected = () => useFilesViewTabsStore.getState().byRoot[directory]?.selectedPath ?? null;
const diffState = () => {
  const state = useUIStore.getState();
  return getEditorDiffTabState(state.contextPanelByDirectory[directory], state.contextSurfaceZones, 'left');
};
const active = (zone: 'left' | 'right' | 'bottom' = 'left') => {
  const ui = useUIStore.getState();
  return resolveZoneActiveTab(ui.contextPanelByDirectory[directory], ui.contextSurfaceZones, zone, 'left');
};

test('opening files and line links keeps the current tool and selects the resident document', () => {
  const ui = useUIStore.getState();
  ui.openContextSurface(directory, 'diff');
  ui.openContextFile(directory, '/repo/a.ts');
  expect(active()?.mode).toBe('diff');
  expect(selected()).toBe('/repo/a.ts');
  ui.openContextFileAtLine(directory, '/repo/b.ts', 12, 3);
  expect(active()?.mode).toBe('diff');
  expect(selected()).toBe('/repo/b.ts');
  expect(useUIStore.getState().pendingFileNavigation).toEqual({ path: '/repo/b.ts', line: 12, column: 3 });
  ui.openContextPanelTab(directory, { mode: 'file', targetPath: '/repo/background.ts' }, { reveal: false });
  expect(selected()).toBe('/repo/b.ts');
  expect(active()?.mode).toBe('diff');
});

test('the file rail toggles only the directory panel, including a manually moved tree', () => {
  const ui = useUIStore.getState();
  ui.openContextFile(directory, '/repo/a.ts');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left').isOpen).toBe(false);
  ui.openContextSurface(directory, 'file');
  expect(active()?.mode).toBe('file');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left').isOpen).toBe(true);
  ui.moveContextSurfaceToZone('file', 'bottom');
  ui.openContextSurface(directory, 'file');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'bottom').isOpen).toBe(false);
  expect(selected()).toBe('/repo/a.ts');
  ui.openContextSurface(directory, 'file');
  expect(active('bottom')?.mode).toBe('file');
});

test('closing an inactive document keeps selection; the last document leaves the tree open', () => {
  const ui = useUIStore.getState();
  ui.openContextSurface(directory, 'file');
  ui.openContextFile(directory, '/repo/a.ts');
  ui.openContextFile(directory, '/repo/b.ts');
  ui.closeContextFile(directory, '/repo/a.ts');
  expect(selected()).toBe('/repo/b.ts');
  ui.closeContextFile(directory, '/repo/b.ts');
  expect(selected()).toBe(null);
  expect(active()?.mode).toBe('file');
  expect(active()?.targetPath).toBe(null);
  expect(useUIStore.getState().contextPanelByDirectory[directory].zones.left.isOpen).toBe(true);
});

test('preview, pin, reselect and closing the selected document keep the tool unchanged', () => {
  const ui = useUIStore.getState();
  ui.openContextSurface(directory, 'git');
  ui.openContextFile(directory, '/repo/a.ts', { preview: true });
  ui.openContextFile(directory, '/repo/b.ts', { preview: true });
  let tabs = useUIStore.getState().contextPanelByDirectory[directory].tabs;
  expect(tabs.some((tab) => tab.targetPath === '/repo/a.ts')).toBe(false);
  const b = tabs.find((tab) => tab.targetPath === '/repo/b.ts')!;
  ui.pinContextPanelTab(directory, b.id);
  ui.openContextFile(directory, '/repo/c.ts', { preview: true });
  ui.setActiveContextPanelTab(directory, b.id);
  expect(selected()).toBe('/repo/b.ts');
  expect(active()?.mode).toBe('git');
  ui.closeContextFile(directory, '/repo/b.ts');
  expect(selected()).toBe('/repo/c.ts');
  tabs = useUIStore.getState().contextPanelByDirectory[directory].tabs;
  expect(tabs.filter((tab) => tab.mode === 'file')).toHaveLength(1);
});

test('classic and mobile files keep the existing zone-opening behavior', () => {
  for (const state of [{ workspaceLayout: 'classic' as const, isMobile: false }, { workspaceLayout: 'editor' as const, isMobile: true }]) {
    useUIStore.setState({ ...state, contextPanelByDirectory: {} });
    useUIStore.getState().openContextFile(directory, '/repo/a.ts');
    const panel = useUIStore.getState().contextPanelByDirectory[directory];
    expect(getZoneView(panel, state.workspaceLayout === 'classic' ? 'right' : 'left').isOpen).toBe(true);
  }
});

test('Changes has one document and its list closes independently', () => {
  const ui = useUIStore.getState();
  ui.openContextFile(directory, '/repo/a.ts');
  ui.openContextSurface(directory, 'diff');
  expect(diffState()).toBe('active');
  expect(selected()).toBe('/repo/a.ts');
  ui.openContextDiff(directory, 'a.ts');
  ui.openContextDiff(directory, 'b.ts', true);
  expect(useUIStore.getState().contextPanelByDirectory[directory].tabs.filter((tab) => tab.mode === 'diff')).toHaveLength(1);
  expect(active()?.diffScope).toBe('staged');
  ui.setEditorDiffTabState(directory, 'closed');
  expect(active()?.mode).toBe('diff');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left').isOpen).toBe(true);
  ui.setEditorDiffTabState(directory, 'active');
  ui.openContextSurface(directory, 'diff');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left').isOpen).toBe(false);
  expect(diffState()).toBe('active');
  ui.setEditorDiffTabState(directory, 'closed');
  ui.openContextSurface(directory, 'diff');
  expect(diffState()).toBe('active');
});

test('document selection and scope updates preserve the selected tool and other projects', () => {
  const ui = useUIStore.getState();
  ui.openContextDiff(directory, 'a.ts');
  ui.openContextFile(directory, '/repo/a.ts');
  expect(diffState()).toBe('background');
  ui.openContextSurface(directory, 'git');
  const tools = getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left');
  ui.openContextDiff('/other', 'other.ts');
  const other = useUIStore.getState().contextPanelByDirectory['/other'];
  ui.setEditorDiffTabState(directory, 'active');
  ui.openContextPanelTab(directory, { mode: 'diff', diffScope: 'branch' }, { reveal: false });
  expect(diffState()).toBe('active');
  expect(getZoneView(useUIStore.getState().contextPanelByDirectory[directory], 'left')).toEqual(tools);
  expect(useUIStore.getState().contextPanelByDirectory['/other']).toBe(other);
  ui.setEditorDiffTabState(directory, 'closed');
  ui.openContextFile(directory, '/repo/background.ts', { preview: true });
  expect(diffState()).toBe('closed');
  expect(active()?.mode).toBe('git');
});

test('closing the last file returns to an open Changes document, and closing Changes retains files', () => {
  const ui = useUIStore.getState();
  ui.openContextDiff(directory, 'a.ts');
  ui.openContextFile(directory, '/repo/a.ts');
  ui.closeContextFile(directory, '/repo/a.ts');
  expect(diffState()).toBe('active');
  expect(selected()).toBe(null);
  ui.openContextFile(directory, '/repo/b.ts');
  ui.setEditorDiffTabState(directory, 'active');
  ui.setEditorDiffTabState(directory, 'closed');
  expect(selected()).toBe('/repo/b.ts');
  expect(useUIStore.getState().contextPanelByDirectory[directory].tabs.some((tab) => tab.targetPath === '/repo/b.ts')).toBe(true);
  ui.closeContextPanelTab(directory, 'diff');
  expect(diffState()).toBe('closed');
  ui.setEditorDiffTabState(directory, 'active');
  expect(diffState()).toBe('closed');
});

test('mixed document order and explicit closed state survive layout changes and hydration', async () => {
  const ui = useUIStore.getState();
  ui.openContextFile(directory, '/repo/a.ts');
  ui.openContextDiff(directory, 'a.ts');
  ui.reorderContextPanelTabs(directory, 'diff', 'file:/repo/a.ts');
  expect(useUIStore.getState().contextPanelByDirectory[directory].tabs[0].mode).toBe('diff');
  ui.setEditorDiffTabState(directory, 'closed');
  ui.setWorkspaceLayout('classic');
  ui.setWorkspaceLayout('editor');
  expect(diffState()).toBe('closed');
  const options = useUIStore.persist.getOptions();
  try {
    for (const value of ['closed', 'background', 'active'] as const) {
      ui.setEditorDiffTabState(directory, value);
      const state = options.partialize?.(useUIStore.getState());
      useUIStore.persist.setOptions({ storage: { getItem: () => ({ version: options.version, state }), setItem: () => undefined, removeItem: () => undefined } });
      await useUIStore.persist.rehydrate();
      expect(diffState()).toBe(value);
    }
    const panel = useUIStore.getState().contextPanelByDirectory[directory];
    for (const [editorDiffTab, expected] of [[undefined, 'active'], ['invalid', 'closed']] as const) {
      const state = { workspaceLayout: 'editor', contextPanelByDirectory: { [directory]: { ...panel, editorDiffTab } } };
      useUIStore.persist.setOptions({ storage: { getItem: () => ({ version: options.version, state }), setItem: () => undefined, removeItem: () => undefined } });
      await useUIStore.persist.rehydrate();
      expect(diffState()).toBe(expected);
      if (editorDiffTab === undefined) {
        ui.closeContextZone(directory, 'left');
        expect(diffState()).toBe('active');
      }
    }
  } finally { useUIStore.persist.setOptions(options); }
});

test('split ratio is local, validates writes and survives hydration without a migration', async () => {
  const options = useUIStore.persist.getOptions();
  try {
    expect(useUIStore.getState().editorChatSplitRatio).toBe(0.5);
    useUIStore.getState().setEditorChatSplitRatio(0.62);
    for (const invalid of [NaN, Infinity, -1, 0, 1]) useUIStore.getState().setEditorChatSplitRatio(invalid);
    expect(useUIStore.getState().editorChatSplitRatio).toBe(0.62);
    const persisted = options.partialize?.(useUIStore.getState());
    for (const [state, expected] of [[persisted, 0.62], [{}, 0.62], [{ editorChatSplitRatio: 'bad' }, 0.5]] as const) {
      useUIStore.persist.setOptions({ storage: {
        getItem: () => ({ version: options.version, state }), setItem: () => undefined, removeItem: () => undefined,
      } });
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().editorChatSplitRatio).toBe(expected);
    }
  } finally { useUIStore.persist.setOptions(options); }
});

test('the shared tool width preserves classic widths and is local to the device', async () => {
  const ui = useUIStore.getState();
  ui.setContextPanelWidth(directory, 'git', 650);
  ui.setContextPanelWidth(directory, 'file', 730);
  ui.setContextPanelHeight(directory, 'terminal', 350);
  ui.setContextEditorTreeWidth(240);
  const panels = useUIStore.getState().contextPanelByDirectory;
  expect(ui.editorToolPanelWidth).toBe(320);
  ui.setEditorToolPanelWidth(512.4);
  expect(useUIStore.getState().editorToolPanelWidth).toBe(512);
  expect(useUIStore.getState().contextPanelByDirectory).toBe(panels);
  expect(useUIStore.getState().contextEditorTreeWidth).toBe(240);
  for (const invalid of [NaN, Infinity, -Infinity]) ui.setEditorToolPanelWidth(invalid);
  expect(useUIStore.getState().editorToolPanelWidth).toBe(512);
  expect('editorToolPanelWidth' in readAutoSaveSnapshot()).toBe(false);
  ui.setWorkspaceLayout('classic');
  expect(useUIStore.getState().contextPanelByDirectory[directory].widthByMode).toEqual({ git: 650, file: 730 });
  ui.setWorkspaceLayout('editor');
  expect(useUIStore.getState().editorToolPanelWidth).toBe(512);

  const options = useUIStore.persist.getOptions();
  const persisted = options.partialize?.(useUIStore.getState());
  try {
    for (const [state, expected] of [[persisted, 512], [{}, 512], [{ editorToolPanelWidth: 'bad' }, 320], [{ editorToolPanelWidth: 90 }, 320]] as const) {
      useUIStore.persist.setOptions({ storage: {
        getItem: () => ({ version: options.version, state }), setItem: () => undefined, removeItem: () => undefined,
      } });
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().editorToolPanelWidth).toBe(expected);
    }
  } finally { useUIStore.persist.setOptions(options); }
});
