import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import type { NativeAgentsAPI, NativeSessionList } from '@/lib/api/types';
import { createTestNativeAgentsAPI } from '@/lib/native-agents/test-utils/runtime';
import { fetchNativePartition, fetchNativePartitions, resolveNativeSessions } from './native-session-partitions';

const session = (id: string, directory: string, parentID?: string): Session => {
  const record: Session = {
    id,
    slug: id,
    projectID: '',
    directory,
    title: id,
    version: 'claude-cli',
    time: { created: 1, updated: 1 },
  };
  if (parentID) record.parentID = parentID;
  return record;
};

const apiListing = (listSessions: (directory: string) => Promise<NativeSessionList>): NativeAgentsAPI => (
  createTestNativeAgentsAPI({ listSessions })
);

describe('resolveNativeSessions', () => {
  const claudeOld = session('ncl_old', '/p');
  const codexOld = session('ncx_old', '/p');
  const elsewhere = session('ncl_elsewhere', '/q');
  const child = session('ncl_old_t_toolu_1', '/p', 'ncl_old');
  const grandchild = session('ncl_old_t_toolu_2', '/p', 'ncl_old_t_toolu_1');
  const openCode = session('ses_x', '/p');

  test('replaces a backend that answered and keeps one that failed', () => {
    const fresh = session('ncl_new', '/p');
    const resolved = resolveNativeSessions(
      [claudeOld, codexOld, elsewhere, openCode],
      new Map([['/p', { claude: [fresh], codex: null }]]),
    );
    expect(resolved.map((entry) => entry.id).sort()).toEqual(['ncl_elsewhere', 'ncl_new', 'ncx_old']);
  });

  test('keeps subagent sessions, nested ones too, while their parent is held', () => {
    const kept = resolveNativeSessions(
      [grandchild, child, claudeOld],
      new Map([['/p', { claude: [claudeOld], codex: [] }]]),
    );
    expect(kept.map((entry) => entry.id).sort()).toEqual(['ncl_old', 'ncl_old_t_toolu_1', 'ncl_old_t_toolu_2']);

    const orphaned = resolveNativeSessions([grandchild, child, claudeOld], new Map([['/p', { claude: [], codex: [] }]]));
    expect(orphaned).toEqual([]);
  });
});

describe('fetchNativePartition', () => {
  test('maps each backend status and fails every backend when the request fails', async () => {
    const fresh = session('ncl_new', '/p');
    const ok = await fetchNativePartition(apiListing(async () => ({
      backends: { claude: { status: 'ok', sessions: [fresh] }, codex: { status: 'error', message: 'codex missing' } },
    })), '/p');
    expect(ok).toEqual({ claude: [fresh], codex: null });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = await fetchNativePartition(apiListing(async () => {
        throw new Error('offline');
      }), '/p');
      expect(failed).toEqual({ claude: null, codex: null });
    } finally {
      console.warn = originalWarn;
    }
  });

  test('reads each normalized directory once with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const api = apiListing(async (directory) => {
      seen.push(directory);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { backends: { claude: { status: 'ok', sessions: [] }, codex: { status: 'ok', sessions: [] } } };
    });
    const results = await fetchNativePartitions(api, ['/a/', '/a', '/b', '/c', '/d', '/e', '/f', '']);
    expect(seen.sort()).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
    expect([...results.keys()].sort()).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
