import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createNativeRegistry } from './registry.js';
import { createNativeReverts } from './revert.js';
import { createSnapshotStore } from './snapshots.js';

const SESSION = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const REWIND = { resumeAt: 'entry-before-first' };

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  directories.push(dir);
  return dir;
};

const write = (root, file, text) => fs.writeFileSync(path.join(root, file), text);
const read = (root, file) => (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null);

const createHarness = () => {
  const root = tempDir('openchamber-revert-repo-');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  write(root, 'a.txt', 'a0');
  write(root, 'b.txt', 'b0');
  const dataDir = tempDir('openchamber-revert-data-');
  const registry = createNativeRegistry({ filePath: path.join(dataDir, 'registry.json') });
  const reverts = createNativeReverts({ registry, snapshots: createSnapshotStore({ dataDir }) });
  return { root, registry, reverts };
};

// Two OpenChamber turns, with an edit of the user's own between them.
const runTwoTurns = async ({ root, reverts }) => {
  await reverts.beforePrompt(SESSION, root, 'ncl_u_1');
  write(root, 'a.txt', 'a1');
  await reverts.afterTurn(SESSION);
  write(root, 'notes.md', 'mine');
  await reverts.beforePrompt(SESSION, root, 'ncl_u_2');
  write(root, 'b.txt', 'b2');
  write(root, 'c.txt', 'c2');
  await reverts.afterTurn(SESSION);
};

const contents = (root) => ({ a: read(root, 'a.txt'), b: read(root, 'b.txt'), c: read(root, 'c.txt'), notes: read(root, 'notes.md') });

describe('native reverts', () => {
  it('restores what the reverted turns changed, keeps edits made between turns, and unreverts', async () => {
    const harness = createHarness();
    const { root, reverts } = harness;
    await runTwoTurns(harness);

    expect(await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_1', messageIds: ['ncl_u_1', 'ncl_u_2'], rewind: REWIND }))
      .toEqual({ filesRestored: 3, conversationOnly: false });
    expect(contents(root)).toEqual({ a: 'a0', b: 'b0', c: null, notes: 'mine' });
    expect(await reverts.pending(SESSION)).toMatchObject({ messageId: 'ncl_u_1', messageIds: ['ncl_u_1', 'ncl_u_2'], phase: 'pending', resumeAt: 'entry-before-first' });

    expect(await reverts.unrevert(SESSION)).toBe(true);
    expect(contents(root)).toEqual({ a: 'a1', b: 'b2', c: 'c2', notes: 'mine' });
    expect(await reverts.pending(SESSION)).toBeNull();
    expect(await reverts.unrevert(SESSION)).toBe(false);
  });

  it('moves a pending revert either way starting from the state before it', async () => {
    const harness = createHarness();
    const { root, reverts } = harness;
    await runTwoTurns(harness);

    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_2', messageIds: ['ncl_u_2'], rewind: REWIND });
    expect(contents(root)).toEqual({ a: 'a1', b: 'b0', c: null, notes: 'mine' });
    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_1', messageIds: ['ncl_u_1', 'ncl_u_2'], rewind: REWIND });
    expect(contents(root)).toEqual({ a: 'a0', b: 'b0', c: null, notes: 'mine' });
    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_2', messageIds: ['ncl_u_2'], rewind: REWIND });
    expect(contents(root)).toEqual({ a: 'a1', b: 'b0', c: null, notes: 'mine' });
    await reverts.unrevert(SESSION);
    expect(contents(root)).toEqual({ a: 'a1', b: 'b2', c: 'c2', notes: 'mine' });
  });

  it('rewinds only the conversation when the first reverted prompt has no snapshot', async () => {
    const harness = createHarness();
    const { root, reverts } = harness;
    await runTwoTurns(harness);

    expect(await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_terminal', messageIds: ['ncl_u_terminal', 'ncl_u_2'], rewind: REWIND }))
      .toEqual({ filesRestored: 0, conversationOnly: true });
    expect(contents(root)).toEqual({ a: 'a1', b: 'b2', c: 'c2', notes: 'mine' });
    expect(await reverts.pending(SESSION)).toMatchObject({ messageId: 'ncl_u_terminal', files: [], phase: 'pending' });
  });

  it('keeps a committed revert in effect and forgets the dropped prompts once the backend rewound', async () => {
    const harness = createHarness();
    const { root, registry, reverts } = harness;
    await runTwoTurns(harness);
    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_2', messageIds: ['ncl_u_2'], rewind: REWIND });
    await reverts.beforePrompt(SESSION, root, 'ncl_u_3');
    await reverts.beginCommit(SESSION);

    expect(await reverts.unrevert(SESSION)).toBe(false);
    expect(contents(root)).toEqual({ a: 'a1', b: 'b0', c: null, notes: 'mine' });
    expect(await reverts.pending(SESSION)).toMatchObject({ phase: 'committed' });

    await reverts.finishCommit(SESSION);
    expect(await reverts.pending(SESSION)).toBeNull();
    expect((await registry.turnSnapshots(SESSION)).map((record) => record.messageId)).toEqual(['ncl_u_1', 'ncl_u_3']);
  });

  it('replaces a committed revert the backend has not confirmed, keeping its dropped prompts', async () => {
    const harness = createHarness();
    const { root, reverts } = harness;
    await runTwoTurns(harness);
    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_2', messageIds: ['ncl_u_2'], rewind: { resumeAt: 'late' } });
    await reverts.beginCommit(SESSION);

    await reverts.revert({ sessionId: SESSION, messageId: 'ncl_u_1', messageIds: ['ncl_u_1'], rewind: REWIND });
    expect(contents(root)).toEqual({ a: 'a0', b: 'b0', c: null, notes: 'mine' });
    expect(await reverts.pending(SESSION)).toMatchObject({
      messageId: 'ncl_u_1',
      messageIds: ['ncl_u_1', 'ncl_u_2'],
      phase: 'pending',
      resumeAt: 'entry-before-first',
    });
  });

  it('records the end of a turn before a revert requested right after it', async () => {
    const harness = createHarness();
    const { root, reverts } = harness;
    await reverts.beforePrompt(SESSION, root, 'ncl_u_1');
    write(root, 'a.txt', 'a1');
    void reverts.afterTurn(SESSION);
    const target = { sessionId: SESSION, messageId: 'ncl_u_1', messageIds: ['ncl_u_1'], rewind: REWIND };
    await reverts.revert(target);
    expect(read(root, 'a.txt')).toBe('a0');

    // Had the end snapshot been taken after the restore, the turn would look
    // like it changed nothing and this second revert would restore nothing.
    await reverts.unrevert(SESSION);
    expect(await reverts.revert(target)).toEqual({ filesRestored: 1, conversationOnly: false });
    expect(read(root, 'a.txt')).toBe('a0');
  });

  it('takes no snapshots outside a git repository', async () => {
    const { registry, reverts } = createHarness();
    await reverts.beforePrompt(SESSION, tempDir('openchamber-revert-plain-'), 'ncl_u_1');
    expect(await registry.turnSnapshots(SESSION)).toEqual([]);
  });
});
