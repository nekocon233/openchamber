import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateSessionDisplayState, useSessionDisplayStore } from './useSessionDisplayStore';

const activitySectionsSource = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '../components/session/sidebar/recent/SidebarActivitySections.tsx',
), 'utf8');
const recentSectionSource = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '../components/session/sidebar/recent/RecentSessionSection.tsx',
), 'utf8');
const displayStoreSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'useSessionDisplayStore.ts'), 'utf8');

describe('session display store', () => {
  test('toggles pinned and recent sections independently', () => {
    expect(displayStoreSource).toContain('showPinnedSection: !state.showPinnedSection');
    expect(displayStoreSource).toContain('showRecentSection: !state.showRecentSection');
  });

  test('enables the pinned section when migrating version 2 preferences', () => {
    const migrated = migrateSessionDisplayState({ showRecentSection: false }, 2);
    expect(migrated.showPinnedSection).toBe(true);
    expect(migrated.showRecentSection).toBe(false);
  });

  test('renders managed Chats before optional Recent', () => {
    const chatsIndex = recentSectionSource.indexOf("key: 'chats' as const");
    const recentIndex = recentSectionSource.indexOf('...(showRecentSection ? recentSections.map');
    expect(chatsIndex).toBeGreaterThan(-1);
    expect(recentIndex).toBeGreaterThan(chatsIndex);
  });

  test('keeps Recent expansion separate from the custom Chats renderer', () => {
    expect(activitySectionsSource).toContain('renderContext="recent"');
    expect(activitySectionsSource).toContain("section.key === 'chats' && Boolean(props.renderChatsSection)");
    expect(activitySectionsSource).toContain('usesCustomRenderer ? props.renderChatsSection?.(section.items)');
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
