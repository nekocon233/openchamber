import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();
afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

describe('work-status dropdown hydration', () => {
  for (const enabled of [true, false]) {
    test(`retires the inline preference ${enabled} while preserving section preferences`, async () => {
      useUIStore.persist.setOptions({ storage: {
        getItem: () => ({ version: 25, state: {
          ...useUIStore.getInitialState(), workStatusPanelEnabled: enabled,
          workStatusPanelVisible: true, workStatusPanelFits: true, workStatusOverlayOpen: true,
          workStatusExpandedSections: { mcp: true }, workStatusScrollTop: 42,
          workStatusHiddenSections: ['telemetry'], workStatusHiddenSectionsExplicit: true,
          workStatusSectionOrder: ['mcp', 'session'],
        } }),
        setItem: () => undefined, removeItem: () => undefined,
      } });
      await useUIStore.persist.rehydrate();
      const state = useUIStore.getState();
      expect(state.workStatusOverlayOpen).toBe(false);
      expect(state).not.toHaveProperty('workStatusPanelEnabled');
      expect(state).not.toHaveProperty('workStatusPanelVisible');
      expect(state).not.toHaveProperty('workStatusPanelFits');
      expect(state.workStatusExpandedSections).toEqual({ mcp: true });
      expect(state.workStatusScrollTop).toBe(42);
      expect(state.workStatusHiddenSections).toEqual(['telemetry']);
      expect(state.workStatusSectionOrder).toEqual(['mcp', 'session']);
      state.setWorkStatusOverlayOpen(true);
      expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
      expect(originalOptions.partialize?.(useUIStore.getState())).not.toHaveProperty('workStatusOverlayOpen');
    });
  }
});
