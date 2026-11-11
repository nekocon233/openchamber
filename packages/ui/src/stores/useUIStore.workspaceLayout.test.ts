import { afterEach, beforeEach, expect, test } from 'bun:test';
import { applySettingsToStores, parseSettingsDocument, readAutoSaveSnapshot } from '@/lib/settings/registry';
import { getZoneView, resolveZoneActiveTab } from '@/lib/workspace/zones';
import { useUIStore } from './useUIStore';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';

const options = useUIStore.persist.getOptions();
const original = useUIStore.getState();

beforeEach(() => {
  useUIStore.setState(useUIStore.getInitialState(), true);
});
afterEach(() => {
  useUIStore.persist.setOptions(options);
  useUIStore.setState(original, true);
});

test('editor layout moves visible files across projects without dropping tabs or widths', () => {
  const ui = useUIStore.getState();
  expect(ui.workspaceLayout).toBe('classic');
  for (const directory of ['/first', '/second']) {
    ui.openContextFile(directory, `${directory}/notes.md`);
    ui.setContextPanelWidth(directory, 'file', 680);
  }
  const before = useUIStore.getState().contextPanelByDirectory;
  ui.setWorkspaceLayout('editor');
  const next = useUIStore.getState();
  expect(next.fileTreeSide).toBe('right');
  expect(next.contextSurfaceZones.file).toBeUndefined();
  for (const [directory, panel] of Object.entries(next.contextPanelByDirectory)) {
    expect(panel.tabs).toBe(before[directory].tabs);
    expect(panel.widthByMode.file).toBe(680);
    expect(getZoneView(panel, 'right').isOpen).toBe(false);
    expect(getZoneView(panel, 'left').isOpen).toBe(true);
    expect(resolveZoneActiveTab(panel, next.contextSurfaceZones, 'left', 'left')?.targetPath).toBe(`${directory}/notes.md`);
  }
});

test('repeated settings applies preserve manual placement, and classic keeps it too', () => {
  const ui = useUIStore.getState();
  applySettingsToStores({ workspaceLayout: 'editor' });
  ui.moveContextSurfaceToZone('file', 'bottom');
  ui.setFileTreeSide('right');
  const manual = useUIStore.getState();
  applySettingsToStores({ workspaceLayout: 'editor' });
  expect(useUIStore.getState()).toBe(manual);
  applySettingsToStores({});
  expect(useUIStore.getState()).toBe(manual);
  ui.setWorkspaceLayout('classic');
  expect(useUIStore.getState().contextSurfaceZones.file).toBe('bottom');
  expect(useUIStore.getState().fileTreeSide).toBe('right');
  ui.setWorkspaceLayout('editor');
  expect(useUIStore.getState().contextSurfaceZones.file).toBe('bottom');
  expect(useUIStore.getState().fileTreeSide).toBe('right');
});

test('the layout round-trips through profile settings and local hydration', async () => {
  let saved: Parameters<NonNullable<typeof options.storage>['setItem']>[1] = { state: original, version: options.version };
  useUIStore.persist.setOptions({ storage: {
    getItem: () => saved,
    setItem: (_name, value) => { saved = value; },
    removeItem: () => undefined,
  } });
  for (const layout of ['editor', 'classic'] as const) {
    const parsed = parseSettingsDocument(JSON.parse(JSON.stringify({ workspaceLayout: layout })));
    expect(parsed).toEqual({ workspaceLayout: layout });
    if (!parsed) throw new Error('Expected parsed settings');
    applySettingsToStores(parsed);
    expect(readAutoSaveSnapshot().workspaceLayout).toBe(layout);
    useUIStore.getState().moveContextSurfaceToZone('file', 'bottom');
    useUIStore.getState().setFileTreeSide('right');
    const persisted = saved;
    useUIStore.setState(useUIStore.getInitialState(), true);
    saved = persisted;
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().workspaceLayout).toBe(layout);
    expect(useUIStore.getState().contextSurfaceZones.file).toBe('bottom');
    expect(useUIStore.getState().fileTreeSide).toBe('right');
  }
  expect(parseSettingsDocument({ workspaceLayout: 'invalid' })).toEqual({});
});

test('old and malformed local settings load the classic layout', async () => {
  for (const state of [{}, { workspaceLayout: 'invalid' }, { workspaceLayout: null }]) {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({ version: options.version, state }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().workspaceLayout).toBe('classic');
  }
});

test('a local snapshot without a layout preserves an already applied profile choice', async () => {
  applySettingsToStores({ workspaceLayout: 'editor' });
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version: options.version, state: { sidebarWidth: 320 } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().workspaceLayout).toBe('editor');
  expect(useUIStore.getState().sidebarWidth).toBe(320);
});

test('every rail mode defaults left, toggles there, and leaves its placement implicit', () => {
  const ui = useUIStore.getState();
  ui.setWorkspaceLayout('editor');
  const modes = [...CONTEXT_SURFACES.map((surface) => surface.mode), 'plugin:future-panel'] as const;
  for (const mode of modes) {
    if (mode === 'chat') ui.openContextPanelTab('/repo', { mode, dedupeKey: 'session:test' });
    else ui.openContextSurface('/repo', mode);
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory['/repo'];
    expect(resolveZoneActiveTab(panel, state.contextSurfaceZones, 'left', 'left')?.mode).toBe(mode);
    expect(panel.zones.left.isOpen).toBe(true);
    expect(panel.isOpen).toBe(false);
    ui.openContextSurface('/repo', mode);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(false);
  }
  expect(useUIStore.getState().contextSurfaceZones).toEqual({});
});

test('a manual right placement survives reopen, project and layout changes', () => {
  const ui = useUIStore.getState();
  ui.setWorkspaceLayout('editor');
  ui.openContextSurface('/first', 'diff');
  ui.moveContextSurfaceToZone('diff', 'right');
  ui.closeContextZone('/first', 'right');
  ui.openContextSurface('/first', 'diff');
  ui.openContextSurface('/second', 'diff');
  ui.setWorkspaceLayout('classic');
  ui.setWorkspaceLayout('editor');
  expect(useUIStore.getState().contextSurfaceZones.diff).toBe('right');
  for (const panel of Object.values(useUIStore.getState().contextPanelByDirectory)) {
    expect(panel.isOpen).toBe(true);
    expect(panel.zones.left.isOpen).toBe(false);
  }
});

test('a layout transition publishes the new layout and visible zones together', () => {
  useUIStore.getState().openContextSurface('/repo', 'diff');
  let updates = 0;
  const stop = useUIStore.subscribe((state) => {
    updates++;
    expect(state.workspaceLayout).toBe('editor');
    expect(state.contextPanelByDirectory['/repo'].isOpen).toBe(false);
    expect(state.contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
  });
  try { useUIStore.getState().setWorkspaceLayout('editor'); } finally { stop(); }
  expect(updates).toBe(1);
});

test('v24 editor hydration relocates the saved active panel and retains every surface size', async () => {
  useUIStore.getState().openContextSurface('/repo', 'diff');
  useUIStore.getState().setContextPanelWidth('/repo', 'plugin:notes-x', 751);
  useUIStore.getState().setContextPanelHeight('/repo', 'plugin:notes-x', 427);
  useUIStore.getState().setContextPanelWidth('/repo', 'notes', 580);
  const panels = useUIStore.getState().contextPanelByDirectory;
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version: 24, state: { workspaceLayout: 'editor', contextSurfaceZones: { file: 'left' }, contextPanelByDirectory: panels } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  const current = useUIStore.getState().contextPanelByDirectory['/repo'];
  expect(current.isOpen).toBe(false);
  expect(current.zones.left.isOpen).toBe(true);
  expect(current.zones.left.activeTabId).toBe('diff');
  expect(current.widthByMode['plugin:notes-x']).toBe(751);
  expect(current.heightByMode['plugin:notes-x']).toBe(427);
  expect(current.widthByMode.notes).toBe(580);
});

test('retired task windows are dropped on hydration while other windows and sizes survive', async () => {
  const ui = useUIStore.getState();
  ui.openContextSurface('/mixed', 'git');
  ui.setContextPanelWidth('/mixed', 'git', 620);
  const mixed = useUIStore.getState().contextPanelByDirectory['/mixed'];
  const retired = { mode: 'tasks', touchedAt: 1 };
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version: options.version, state: {
      contextSurfaceZones: { tasks: 'right' },
      contextPanelByDirectory: {
        '/only-tasks': { isOpen: true, expanded: true, tabs: [retired], activeTabId: 'tasks', widthByMode: { tasks: 580 }, heightByMode: { tasks: 300 } },
        '/mixed': { ...mixed, tabs: [...mixed.tabs, retired], activeTabId: 'tasks', widthByMode: { ...mixed.widthByMode, tasks: 580 } },
      },
    } }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  const restored = useUIStore.getState();
  const onlyTasks = restored.contextPanelByDirectory['/only-tasks'];
  expect(onlyTasks.tabs).toEqual([]);
  expect(onlyTasks.activeTabId).toBeNull();
  expect(onlyTasks.isOpen).toBe(false);
  expect(onlyTasks.expanded).toBe(false);
  expect(onlyTasks.widthByMode).toEqual({});
  expect(onlyTasks.heightByMode).toEqual({});
  expect(Object.hasOwn(restored.contextSurfaceZones, 'tasks')).toBe(false);
  expect(restored.contextPanelByDirectory['/mixed'].tabs.map(tab => tab.mode)).toEqual(['git']);
  expect(restored.contextPanelByDirectory['/mixed'].activeTabId).toBe('git');
  expect(restored.contextPanelByDirectory['/mixed'].isOpen).toBe(true);
  expect(restored.contextPanelByDirectory['/mixed'].widthByMode).toEqual({ git: 620 });
});

test('explicit right round-trips and an empty snapshot restores the layout default', async () => {
  const ui = useUIStore.getState();
  ui.setWorkspaceLayout('editor');
  ui.openContextSurface('/repo', 'git');
  ui.moveContextSurfaceToZone('git', 'right');
  const persisted = options.partialize?.(useUIStore.getState());
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version: options.version, state: persisted }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().contextSurfaceZones.git).toBe('right');
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(true);
  ui.setContextSurfaceZones({});
  expect(useUIStore.getState().contextSurfaceZones).toEqual({});
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
});
