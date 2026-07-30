import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateSessionDisplayState, useSessionDisplayStore } from './useSessionDisplayStore';

const sessionSidebarSource = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '../components/session/SessionSidebar.tsx',
), 'utf8');
const activitySectionsSource = readFileSync(join(
  dirname(fileURLToPath(import.meta.url)),
  '../components/session/sidebar/SidebarActivitySections.tsx',
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

  test('renders pinned before recent with distinct interaction contexts', () => {
    const pinnedIndex = sessionSidebarSource.indexOf("key: 'pinned' as const");
    const recentIndex = sessionSidebarSource.indexOf("key: 'active-now' as const");
    expect(pinnedIndex).toBeGreaterThan(-1);
    expect(recentIndex).toBeGreaterThan(pinnedIndex);
    expect(activitySectionsSource).toContain("section.key === 'pinned' ? 'pinned' : 'recent'");
    expect(sessionSidebarSource).toContain("renderContext === 'pinned'");
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
