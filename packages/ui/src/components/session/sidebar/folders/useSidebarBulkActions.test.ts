import { describe, expect, spyOn, test } from 'bun:test';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { resolveBulkCompleteIds, resolveBulkDeleteConfirmation, resolveSelectionFolderScopes } from './useSidebarBulkActions';
import type { SessionRowOrderSnapshot } from '../sessions/sessionRowOrder';

describe('sidebar bulk project scopes', () => {
  test('uses every root and worktree scope owned by the selected project', () => {
    const scopes = resolveSelectionFolderScopes('project-a', (projectId) => projectId === 'project-a'
      ? [
        { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
        { scopeKey: '/workspace/project-a-worktree', directory: '/workspace/project-a-worktree' },
      ]
      : []);

    expect(scopes).toEqual(['/workspace/project-a', '/workspace/project-a-worktree']);
  });

  test('keeps a directory scope when no project scope owns it', () => {
    expect(resolveSelectionFolderScopes('/workspace/vscode', () => [])).toEqual(['/workspace/vscode']);
  });
});

describe('bulk delete confirmation authority', () => {
  test('executes only the unchanged immutable target snapshot', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true };
    const sessions = new Map([
      ['a', { time: { archived: 1 } }],
      ['b', { time: { archived: 2 } }],
    ]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({ ready: true, value });
  });

  test('requires confirmation again when targets change, keeping a requested delete a delete', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true };
    const sessions = new Map([['a', { time: { archived: 0 } }]]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({
      ready: false,
      value: { sessionIds: ['a'], sessionCount: 1, archivedBucket: true },
    });
  });

  test('turns a requested archive into a delete once every target is already archived', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: false };
    const sessions = new Map([['a', { time: { archived: 1 } }], ['b', { time: { archived: 2 } }]]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({
      ready: false,
      value: { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true },
    });
  });
});

describe('sidebar bulk completion targets', () => {
  const doneWork = { openchamber: { work: { state: 'done' } } };
  const sessions = (): Map<string, SessionRowOrderSnapshot> => new Map([
    ['open', {}],
    ['open-two', { metadata: { openchamber: { work: { state: 'open' } } } }],
    ['done', { metadata: doneWork }],
    ['child', { parentID: 'open' }],
    ['archived', { time: { archived: 1 } }],
  ]);

  test('targets nothing when work is off or the archive is selected', () => {
    const selected = new Set(['open']);
    expect(resolveBulkCompleteIds(selected, sessions(), { sessionWorkEnabled: false, archivedBucket: false })).toEqual([]);
    expect(resolveBulkCompleteIds(selected, sessions(), { sessionWorkEnabled: true, archivedBucket: true })).toEqual([]);
  });

  test('keeps top-level project sessions that are not done yet', () => {
    const selected = new Set(['open', 'open-two', 'done', 'child', 'archived', 'missing']);
    expect(resolveBulkCompleteIds(selected, sessions(), { sessionWorkEnabled: true, archivedBucket: false }))
      .toEqual(['open', 'open-two']);
  });

  test('leaves chats alone once their root is known', async () => {
    const home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://bulk-complete.test', runtimeKey: 'bulk-complete' });
    try {
      await ensureChatsRootDirectory();
      const withChat = sessions();
      withChat.set('chat', { directory: '/srv/chats/2026-10-18/session-a' });
      expect(resolveBulkCompleteIds(new Set(['open', 'chat']), withChat, { sessionWorkEnabled: true, archivedBucket: false }))
        .toEqual(['open']);
    } finally {
      home.mockRestore();
    }
  });
});
