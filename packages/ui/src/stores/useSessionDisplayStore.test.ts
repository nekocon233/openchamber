import { createJSONStorage } from 'zustand/middleware';
import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'window');
const testWindow = new Window();
Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
const { defaultSidebarViewMode, migrateSessionDisplayState, useSessionDisplayStore } = await import('./useSessionDisplayStore');
afterAll(() => {
  testWindow.close();
  if (previousStorage) Object.defineProperty(globalThis, 'window', previousStorage);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('useSessionDisplayStore worktree sorting', () => {
  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().worktreeSortOrder).toBe('manual');
  });

  test('v8→v9 starts existing users on manual ordering', () => {
    expect(migrateSessionDisplayState({}, 8).worktreeSortOrder).toBe('manual');
  });
});

describe('session display store', () => {
  test('preserves the downstream layout preferences during the v6 migration', () => {
    const original = { showPinnedSection: true, showChatsSection: false, showRecentSection: true, sessionGroupingMode: 'flat' };
    expect(migrateSessionDisplayState(original, 6)).toMatchObject({
      showPinnedSection: true, showChatsSection: false, showRecentSection: true, animatedActivityIndicators: true,
    });
    expect('sessionGroupingMode' in migrateSessionDisplayState(original, 6)).toBe(false);
    expect(original.sessionGroupingMode).toBe('flat');
  });
  test('toggles pinned, chats, and recent sections independently', () => {
    const previous = useSessionDisplayStore.getState();
    try {
      useSessionDisplayStore.setState({ showPinnedSection: true, showChatsSection: true, showRecentSection: true });
      previous.togglePinnedSection();
      expect(useSessionDisplayStore.getState()).toMatchObject({ showPinnedSection: false, showChatsSection: true, showRecentSection: true });
      previous.toggleChatsSection();
      expect(useSessionDisplayStore.getState()).toMatchObject({ showPinnedSection: false, showChatsSection: false, showRecentSection: true });
      previous.toggleRecentSection();
      expect(useSessionDisplayStore.getState()).toMatchObject({ showPinnedSection: false, showChatsSection: false, showRecentSection: false });
    } finally {
      useSessionDisplayStore.setState(previous, true);
    }
  });

  test('enables the pinned section when migrating version 2 preferences', () => {
    const migrated = migrateSessionDisplayState({ showRecentSection: false }, 2);
    expect(migrated.showPinnedSection).toBe(true);
    expect(migrated.showRecentSection).toBe(false);
  });

  test('enables Chats when migrating version 5 preferences', () => {
    const migrated = migrateSessionDisplayState({ showPinnedSection: false, showRecentSection: false }, 5);
    expect(migrated.showPinnedSection).toBe(false);
    expect(migrated.showChatsSection).toBe(true);
    expect(migrated.showRecentSection).toBe(false);
  });

  test('defaults to manual ordering', () => {
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
  });

  for (const version of [2, 3]) {
    test(`migrates the v${version} recent default to manual`, () => {
      const migrated = migrateSessionDisplayState({ projectSortOrder: 'recent' }, version);

      expect(migrated.projectSortOrder).toBe('manual');
    });
  }

  for (const projectSortOrder of ['manual', 'a-z', 'z-a', 'date-added'] as const) {
    test(`preserves the v2 ${projectSortOrder} sort order`, () => {
      const migrated = migrateSessionDisplayState({ projectSortOrder }, 2);

      expect(migrated.projectSortOrder).toBe(projectSortOrder);
    });
  }

  test('v3→v4 drops the removed displayMode key and keeps the rest', () => {
    const migrated = migrateSessionDisplayState(
      { displayMode: 'default', projectSortOrder: 'a-z', showRecentSection: false, showArchivedSessions: true },
      3,
    );

    expect('displayMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showRecentSection).toBe(false);
    expect(migrated.showArchivedSessions).toBe(true);
  });
});

describe('useSessionDisplayStore project display', () => {
  test('defaults to showing all projects without a selected single project', () => {
    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('all');
    expect(useSessionDisplayStore.getState().singleProjectId).toBeNull();
  });

  test('stores the single-project mode independently from the view mode', () => {
    useSessionDisplayStore.getState().setProjectDisplayMode('single');
    useSessionDisplayStore.getState().setSingleProjectId('project-alpha');
    useSessionDisplayStore.getState().setSidebarViewMode('timeline');

    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('single');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
    expect(useSessionDisplayStore.getState().sidebarViewMode).toBe('timeline');

    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      singleProjectId: null,
      sidebarViewMode: 'projects',
    });
  });
});

describe('useSessionDisplayStore view mode', () => {
  test('defaults to the grouped projects view outside the phone surface', () => {
    expect(defaultSidebarViewMode()).toBe('projects');
  });

  test('v7→v8 turns the recent section off', () => {
    const migrated = migrateSessionDisplayState({ showRecentSection: true, projectSortOrder: 'a-z' }, 7);

    expect(migrated.showRecentSection).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
  });

  test('v5→v6 drops the removed grouping key and keeps the rest', () => {
    const migrated = migrateSessionDisplayState(
      { sessionGroupingMode: 'flat', projectSortOrder: 'a-z', showRecentSection: false },
      5,
    );

    expect('sessionGroupingMode' in migrated).toBe(false);
    expect(migrated.projectSortOrder).toBe('a-z');
    expect(migrated.showRecentSection).toBe(false);
  });
});


describe('useSessionDisplayStore animated activity', () => {
  test('hydrates existing v8 data with motion off and retains saved choices', async () => {
    const initialState = useSessionDisplayStore.getState();
    const originalStorage = useSessionDisplayStore.persist.getOptions().storage;
    let stored = JSON.stringify({ version: 8, state: { sidebarViewMode: 'timeline', showRecentSection: false } });
    const storage = createJSONStorage<Partial<ReturnType<typeof useSessionDisplayStore.getState>>>(() => ({
      getItem: () => stored,
      setItem: (_name, value) => { stored = value; },
      removeItem: () => { stored = ''; },
    }));
    useSessionDisplayStore.persist.setOptions({ storage });
    try {
      await useSessionDisplayStore.persist.rehydrate();
      expect(useSessionDisplayStore.getState().animatedActivityIndicators).toBe(false);
      expect(useSessionDisplayStore.getState().sidebarViewMode).toBe('timeline');
      expect(useSessionDisplayStore.persist.getOptions().version).toBe(9);
      useSessionDisplayStore.getState().setAnimatedActivityIndicators(true);
      const enabledSnapshot = stored;
      useSessionDisplayStore.setState({ animatedActivityIndicators: false });
      stored = enabledSnapshot;
      await useSessionDisplayStore.persist.rehydrate();
      expect(useSessionDisplayStore.getState().animatedActivityIndicators).toBe(true);
      expect(useSessionDisplayStore.getState().showRecentSection).toBe(false);
    } finally {
      useSessionDisplayStore.persist.setOptions({ storage: originalStorage });
      useSessionDisplayStore.setState(initialState);
    }
  });
});
