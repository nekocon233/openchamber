import { afterEach, describe, expect, test } from 'bun:test';
import { createJSONStorage } from 'zustand/middleware';
import { sanitizeWorkStatusSectionOrder } from '@/components/chat/work-status/sections';
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
      expect(state.workStatusSectionOrder).toEqual(sanitizeWorkStatusSectionOrder(['mcp', 'session']));
      state.setWorkStatusOverlayOpen(true);
      expect(useUIStore.getState().workStatusOverlayOpen).toBe(true);
      expect(originalOptions.partialize?.(useUIStore.getState())).not.toHaveProperty('workStatusOverlayOpen');
    });
  }

  for (const version of [26, 27]) {
    test(`unifies legacy task preferences on hydration from version ${version} and round-trips them`, async () => {
      let saved = JSON.stringify({ version, state: {
        ...useUIStore.getInitialState(),
        workStatusExpandedSections: { taskTodos: false, mcp: true },
        workStatusHiddenSections: ['taskTodos', 'telemetry'], workStatusHiddenSectionsExplicit: true,
        workStatusSectionOrder: ['mcp', 'taskTodos', 'repository', 'taskChecklist'],
      } });
      useUIStore.persist.setOptions({ storage: createJSONStorage(() => ({
        getItem: () => saved,
        setItem: (_key, value) => { saved = value; },
        removeItem: () => undefined,
      })) });
      await useUIStore.persist.rehydrate();
      const state = useUIStore.getState();
      expect(state.workStatusExpandedSections).toEqual({ taskChecklist: false, mcp: true });
      expect(state.workStatusHiddenSections).toEqual(['taskChecklist', 'telemetry']);
      expect(state.workStatusSectionOrder.slice(0, 3)).toEqual(['mcp', 'taskChecklist', 'repository']);
      expect(state.workStatusSectionOrder).not.toContain('taskTodos');
      state.setWorkStatusSectionVisible('taskChecklist', true);
      state.setWorkStatusSectionExpanded('taskChecklist', true);
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(['telemetry']);
      expect(useUIStore.getState().workStatusExpandedSections).toEqual({ taskChecklist: true, mcp: true });
      expect(useUIStore.getState().workStatusSectionOrder).toEqual(state.workStatusSectionOrder);
    });
  }
});
