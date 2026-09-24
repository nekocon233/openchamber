import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeRegistry } from './registry.js';

const directories = [];
const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-native-registry-'));
  directories.push(dir);
  return dir;
};

const SESSION = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const entry = {
  backend: 'claude',
  nativeId: 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188',
  directory: '/work/project',
  origin: 'openchamber',
  createdAt: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('native session registry', () => {
  it('treats a missing file as an empty registry', async () => {
    const registry = createNativeRegistry({ filePath: path.join(makeDir(), 'registry.json') });
    expect(await registry.listSessions()).toEqual([]);
    expect(registry.status()).toEqual({ reset: false });
  });

  it('persists sessions and send records across instances', async () => {
    const filePath = path.join(makeDir(), 'native-agents', 'registry.json');
    const first = createNativeRegistry({ filePath });
    await first.registerSession(SESSION, entry);
    await first.updateSession(SESSION, { archivedAt: 5, title: 'Renamed' });
    await first.recordSend(SESSION, { messageId: 'ncl_u_x', providerID: 'claude-native', modelID: 'haiku', variant: 'low', agent: 'build', sentAt: 2 });

    const second = createNativeRegistry({ filePath });
    expect(await second.listSessions({ backend: 'claude', directory: '/work/project' })).toEqual([
      { sessionId: SESSION, ...entry, archivedAt: 5, title: 'Renamed' },
    ]);
    expect((await second.sendRecords(SESSION)).get('ncl_u_x')).toMatchObject({ modelID: 'haiku', variant: 'low', agent: 'build' });

    await second.updateSession(SESSION, { archivedAt: null });
    expect((await second.getSession(SESSION)).archivedAt).toBeUndefined();
    await second.removeSession(SESSION);
    expect(await createNativeRegistry({ filePath }).listSessions()).toEqual([]);
  });

  it('persists turn snapshots and a pending revert, and forgets them with the session', async () => {
    const filePath = path.join(makeDir(), 'registry.json');
    const first = createNativeRegistry({ filePath });
    await first.registerSession(SESSION, entry);
    await first.recordTurnStart(SESSION, { messageId: 'ncl_u_1', root: '/work/project', before: 'tree1' });
    await first.recordTurnStart(SESSION, { messageId: 'ncl_u_2', root: '/work/project', before: 'tree2' });
    // One end snapshot closes every prompt the busy period answered.
    await first.recordTurnEnd(SESSION, 'tree3');
    await first.recordTurnStart(SESSION, { messageId: 'ncl_u_3', root: '/work/project', before: 'tree3' });
    const revert = { messageId: 'ncl_u_2', messageIds: ['ncl_u_2', 'ncl_u_3'], phase: 'pending', root: '/work/project', preRevert: 'tree4', files: ['a.txt'], resumeAt: 'entry-1' };
    await first.setPendingRevert(SESSION, revert);

    const second = createNativeRegistry({ filePath });
    expect(await second.turnSnapshots(SESSION)).toEqual([
      { messageId: 'ncl_u_1', root: '/work/project', before: 'tree1', after: 'tree3' },
      { messageId: 'ncl_u_2', root: '/work/project', before: 'tree2', after: 'tree3' },
      { messageId: 'ncl_u_3', root: '/work/project', before: 'tree3' },
    ]);
    expect(await second.pendingRevert(SESSION)).toEqual(revert);

    await second.dropTurns(SESSION, ['ncl_u_2', 'ncl_u_3']);
    expect((await second.turnSnapshots(SESSION)).map((record) => record.messageId)).toEqual(['ncl_u_1']);
    await second.setPendingRevert(SESSION, null);
    expect(await second.pendingRevert(SESSION)).toBeNull();

    await second.setPendingRevert(SESSION, revert);
    await second.removeSession(SESSION);
    const third = createNativeRegistry({ filePath });
    expect(await third.turnSnapshots(SESSION)).toEqual([]);
    expect(await third.pendingRevert(SESSION)).toBeNull();
  });

  it('drops malformed turn and revert records instead of failing the registry', async () => {
    const filePath = path.join(makeDir(), 'registry.json');
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      sessions: {},
      sends: {},
      turns: { [SESSION]: [{ messageId: 'ncl_u_1', root: '/r', before: 't' }, { messageId: 'ncl_u_2' }] },
      reverts: { [SESSION]: { messageId: 'ncl_u_1', phase: 'unknown' } },
    }));
    const registry = createNativeRegistry({ filePath });
    expect(await registry.turnSnapshots(SESSION)).toEqual([{ messageId: 'ncl_u_1', root: '/r', before: 't' }]);
    expect(await registry.pendingRevert(SESSION)).toBeNull();
    expect(registry.status()).toEqual({ reset: false });
  });

  it('drops malformed session metadata without losing the session it belongs to', async () => {
    const filePath = path.join(makeDir(), 'registry.json');
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      sessions: { [SESSION]: { ...entry, metadata: ['not', 'a', 'record'] } },
      sends: {},
      turns: {},
      reverts: {},
    }));
    const registry = createNativeRegistry({ filePath });
    const stored = await registry.getSession(SESSION);
    expect(stored).toMatchObject({ origin: 'openchamber', createdAt: 1 });
    expect(stored.metadata).toBeUndefined();
    expect(registry.status()).toEqual({ reset: false });
  });

  it('keeps the first registration of a session', async () => {
    const registry = createNativeRegistry({ filePath: path.join(makeDir(), 'registry.json') });
    await registry.registerSession(SESSION, entry);
    await registry.registerSession(SESSION, { ...entry, origin: 'adopted', createdAt: 9 });
    expect(await registry.getSession(SESSION)).toMatchObject({ origin: 'openchamber', createdAt: 1 });
  });

  it('moves an unreadable file aside and reports the reset instead of overwriting it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = makeDir();
    const filePath = path.join(dir, 'registry.json');
    fs.writeFileSync(filePath, '{not json');
    const registry = createNativeRegistry({ filePath, now: () => 42 });
    expect(await registry.listSessions()).toEqual([]);
    expect(registry.status()).toEqual({ reset: true, resetAt: 42 });
    expect(fs.readFileSync(`${filePath}.corrupt-42`, 'utf8')).toBe('{not json');
  });

  it('fails reads instead of reporting an empty registry', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'registry.json');
    fs.mkdirSync(filePath);
    const registry = createNativeRegistry({ filePath });
    await expect(registry.listSessions()).rejects.toThrow();
  });

  it('leaves memory unchanged when a write fails', async () => {
    const dir = makeDir();
    const filePath = path.join(dir, 'registry.json');
    const registry = createNativeRegistry({ filePath });
    await registry.registerSession(SESSION, entry);
    const failure = new Error('disk full');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(failure);
    await expect(registry.updateSession(SESSION, { title: 'lost' })).rejects.toBe(failure);
    expect((await registry.getSession(SESSION)).title).toBeUndefined();
    await registry.updateSession(SESSION, { title: 'kept' });
    expect((await registry.getSession(SESSION)).title).toBe('kept');
  });
});
