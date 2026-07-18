import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrateSessionDisplayStore } from './useSessionDisplayStore';

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
    const migrated = migrateSessionDisplayStore({ showRecentSection: false }, 2);
    expect(migrated.showPinnedSection).toBe(true);
    expect(migrated.showRecentSection).toBe(false);
  });

  test('renders pinned before recent with distinct interaction contexts', () => {
    const pinnedIndex = sessionSidebarSource.indexOf("key: 'pinned' as const");
    const recentIndex = sessionSidebarSource.indexOf("key: 'active-now' as const");
    expect(pinnedIndex).toBeGreaterThan(-1);
    expect(recentIndex).toBeGreaterThan(pinnedIndex);
    expect(activitySectionsSource).toContain("section.key === 'pinned' ? 'pinned' : 'recent'");
    expect(sessionSidebarSource).toContain('`pinned:active:${parentID}`');
  });
});
