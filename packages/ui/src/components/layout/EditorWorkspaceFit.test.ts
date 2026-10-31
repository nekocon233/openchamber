import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { followEditorWorkspaceFit, useWorkspaceOverlay } from './editorWorkspaceSizing';

const original = useUIStore.getState();
const resizeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
const browser = new Window();
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
let row: HTMLDivElement;
let width = 1500;
let resize = () => {};
let stop: (() => void) | undefined;


beforeEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
  row = document.createElement('div');
  Object.defineProperty(row, 'clientWidth', { get: () => width });
  useUIStore.setState({ ...useUIStore.getInitialState(), workspaceLayout: 'editor', isMobile: false, isSidebarOpen: true }, true);
  useWorkspaceOverlay.setState({ panel: null });
  width = 1500;
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  } });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  useUIStore.setState(original, true);
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
  else Reflect.deleteProperty(globalThis, 'document');
  if (resizeDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeDescriptor);
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

test('folds sessions before tools and restores automatically folded panels', () => {
  useUIStore.getState().openContextSurface('/repo', 'git');
  stop = followEditorWorkspaceFit(row, '/repo');
  width = 1250;
  resize();
  expect(useUIStore.getState().isSidebarOpen).toBe(false);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
  width = 750;
  resize();
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(false);
  width = 1600;
  resize();
  expect(useUIStore.getState().isSidebarOpen).toBe(true);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
});

test('a manually reopened panel floats and closes the previous overlay', () => {
  width = 750;
  useUIStore.getState().openContextSurface('/repo', 'file');
  stop = followEditorWorkspaceFit(row, '/repo');
  useUIStore.getState().openContextSurface('/repo', 'file');
  expect(useWorkspaceOverlay.getState().panel).toBe('left');
  useUIStore.getState().setSidebarOpen(true);
  expect(useWorkspaceOverlay.getState().panel).toBe('sessions');
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(false);
  useUIStore.getState().setSidebarOpen(false);
  expect(useWorkspaceOverlay.getState().panel).toBe(null);
  width = 1600;
  resize();
  expect(useUIStore.getState().isSidebarOpen).toBe(false);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(false);
});

test('the frame reserves rail and session width once and restores navigation when it fits', () => {
  const rail = document.createElement('div');
  rail.dataset.workspaceRail = '';
  Object.defineProperty(rail, 'clientWidth', { value: 44 });
  row.append(rail);
  width = 1330;
  useUIStore.getState().openContextSurface('/repo', 'diff');
  stop = followEditorWorkspaceFit(row, '/repo');
  expect(useUIStore.getState().isSidebarOpen).toBe(false);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
  width = 1380;
  resize();
  expect(useUIStore.getState().isSidebarOpen).toBe(true);
});

test('a visible overlay docks when enough space returns', () => {
  width = 750;
  stop = followEditorWorkspaceFit(row, '/repo');
  useUIStore.getState().openContextSurface('/repo', 'diff');
  expect(useWorkspaceOverlay.getState().panel).toBe('left');
  width = 1800;
  resize();
  expect(useWorkspaceOverlay.getState().panel).toBe(null);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
});

test('switching tools uses the shared width and leaves fitted columns in place', () => {
  width = 1330;
  const ui = useUIStore.getState();
  ui.setContextPanelWidth('/repo', 'diff', 900);
  ui.openContextSurface('/repo', 'file');
  stop = followEditorWorkspaceFit(row, '/repo');
  for (const mode of ['git', 'diff', 'plugin:future-panel', 'file'] as const) {
    ui.openContextSurface('/repo', mode);
    expect(useUIStore.getState().isSidebarOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
    expect(useWorkspaceOverlay.getState().panel).toBe(null);
  }
  ui.setEditorToolPanelWidth(480);
  expect(useUIStore.getState().isSidebarOpen).toBe(false);
  expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
});
