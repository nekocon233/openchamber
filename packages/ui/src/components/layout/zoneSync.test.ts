import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, { window: dom, StorageEvent: dom.StorageEvent });

const { useUIStore } = await import('@/stores/useUIStore');
const { followZonePlacementOfOtherWindows, readPersistedZonePlacement } = await import('./zoneSync');

const saved = (state: { contextSurfaceZones?: Record<string, string>; theme?: string }) => JSON.stringify({ version: 24, state });

beforeEach(() => {
  useUIStore.setState({ workspaceLayout: 'classic', contextPanelByDirectory: {}, contextSurfaceZones: {} });
});

describe('zone placement across windows', () => {
  test('editor windows keep an explicit right placement and treat empty as default left', () => {
    useUIStore.getState().setWorkspaceLayout('editor');
    useUIStore.getState().openContextSurface('/repo', 'diff');
    const stop = followZonePlacementOfOtherWindows();
    try {
      const move = saved({ contextSurfaceZones: { diff: 'right', terminal: 'bottom' } });
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: move }));
      const state = useUIStore.getState();
      expect(state.contextSurfaceZones.diff).toBe('right');
      expect(state.contextPanelByDirectory['/repo'].isOpen).toBe(true);
      expect(state.contextPanelByDirectory['/repo'].zones.bottom.isOpen).toBe(false);
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: move }));
      expect(useUIStore.getState()).toBe(state);
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: saved({ contextSurfaceZones: {} }) }));
      expect(useUIStore.getState().contextSurfaceZones).toEqual({});
      expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
      expect(useUIStore.getState().contextPanelByDirectory['/repo'].zones.left.isOpen).toBe(true);
    } finally { stop(); }
  });

  test('reads only a placement that is there and well formed', () => {
    expect(readPersistedZonePlacement(saved({ contextSurfaceZones: { terminal: 'bottom', git: 'nowhere' } })))
      .toEqual({ terminal: 'bottom' });
    expect(readPersistedZonePlacement(saved({ theme: 'dark' }))).toBeNull();
    expect(readPersistedZonePlacement('{not json')).toBeNull();
    expect(readPersistedZonePlacement(null)).toBeNull();
  });

  test('a move saved by another window is adopted, and the surface on screen goes along', () => {
    useUIStore.getState().openContextSurface('/repo', 'git');
    const stop = followZonePlacementOfOtherWindows();
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: saved({ contextSurfaceZones: { git: 'left' } }) }));
      expect(useUIStore.getState().contextSurfaceZones).toEqual({ git: 'left' });
      expect(useUIStore.getState().contextPanelByDirectory['/repo']?.zones.left.isOpen).toBe(true);

      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: saved({ contextSurfaceZones: {} }) }));
      expect(useUIStore.getState().contextSurfaceZones).toEqual({});
    } finally {
      stop();
    }
  });

  test('other keys and unreadable values leave the placement alone', () => {
    useUIStore.setState({ contextSurfaceZones: { terminal: 'bottom' } });
    const stop = followZonePlacementOfOtherWindows();
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: saved({ contextSurfaceZones: {} }) }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'ui-store', newValue: 'garbage' }));
      expect(useUIStore.getState().contextSurfaceZones).toEqual({ terminal: 'bottom' });
    } finally {
      stop();
    }
  });
});
