import { describe, expect, test } from 'bun:test';

import { migrateSessionDisplayState, useSessionDisplayStore } from './useSessionDisplayStore';

describe('session display store', () => {
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

  test('stores the single-project mode independently from session grouping', () => {
    useSessionDisplayStore.getState().setProjectDisplayMode('single');
    useSessionDisplayStore.getState().setSingleProjectId('project-alpha');
    useSessionDisplayStore.getState().setSessionGroupingMode('flat');

    expect(useSessionDisplayStore.getState().projectDisplayMode).toBe('single');
    expect(useSessionDisplayStore.getState().singleProjectId).toBe('project-alpha');
    expect(useSessionDisplayStore.getState().sessionGroupingMode).toBe('flat');

    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      singleProjectId: null,
      sessionGroupingMode: 'by-worktree',
    });
  });
});
