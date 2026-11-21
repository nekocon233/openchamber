import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { deriveRecentSessions, RECENT_SESSION_MAX_AGE_MS } from './activitySections';

const NOW = 200_000_000;
const RECENT = NOW - RECENT_SESSION_MAX_AGE_MS;
const OLD = NOW - (72 * 60 * 60 * 1000);

// SAFETY: this fixture supplies every Session field read by the membership helpers under test.
const session = (id: string, options: { parentID?: string; archived?: number; updated?: number; directory?: string } = {}): Session => ({
  id,
  parentID: options.parentID,
  directory: options.directory,
  time: { created: OLD, updated: options.updated ?? OLD, archived: options.archived },
} as Session);

describe('deriveRecentSessions', () => {
  test('includes an old root session while it is active', () => {
    const oldActive = session('old-active');

    expect(deriveRecentSessions([oldActive], new Set([oldActive.id]), NOW)).toEqual([oldActive]);
  });

  test('does not promote active children or archived sessions into Recent', () => {
    const child = session('child', { parentID: 'parent' });
    const archived = session('archived', { archived: NOW - 1 });

    expect(deriveRecentSessions(
      [child, archived],
      new Set([child.id, archived.id]),
      NOW,
    )).toEqual([]);
  });

  test('keeps sessions updated within the retention window', () => {
    const oldSession = session('old', { updated: RECENT - 1 });
    const recentSession = session('recent', { updated: RECENT });

    expect(deriveRecentSessions([oldSession, recentSession], new Set(), NOW)).toEqual([recentSession]);
  });
});
