import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSnapshotStore } from './snapshots.js';

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  directories.push(dir);
  return dir;
};

const createRepository = () => {
  const root = tempDir('openchamber-snapshot-repo-');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
  fs.writeFileSync(path.join(root, 'kept.txt'), 'kept\n');
  fs.writeFileSync(path.join(root, 'edited.txt'), 'before\n');
  return root;
};

const read = (root, file) => (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null);

describe('native snapshots', () => {
  it('finds the repository a directory belongs to, and none outside one', async () => {
    const root = createRepository();
    fs.mkdirSync(path.join(root, 'src'));
    const store = createSnapshotStore({ dataDir: tempDir('openchamber-snapshot-data-') });
    expect(await store.repositoryRoot(path.join(root, 'src'))).toBe(root);
    expect(await store.repositoryRoot(tempDir('openchamber-snapshot-plain-'))).toBeNull();
  });

  it('restores the files a turn changed and leaves every other file alone', async () => {
    const root = createRepository();
    const dataDir = tempDir('openchamber-snapshot-data-');
    const store = createSnapshotStore({ dataDir });
    const before = await store.capture(root);

    // The turn edits one file, creates one, deletes one, and writes ignored output.
    fs.writeFileSync(path.join(root, 'edited.txt'), 'after\n');
    fs.writeFileSync(path.join(root, 'created*[x].txt'), 'new\n');
    fs.rmSync(path.join(root, 'kept.txt'));
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'out.js'), 'ignored\n');
    const after = await store.capture(root);
    const touched = await store.changedFiles(root, before, after);
    expect(touched.sort()).toEqual(['created*[x].txt', 'edited.txt', 'kept.txt']);

    // Meanwhile the user edits a file the turn never touched.
    fs.writeFileSync(path.join(root, 'notes.md'), 'mine\n');

    await store.restoreFiles(root, before, touched);
    expect(read(root, 'edited.txt')).toBe('before\n');
    expect(read(root, 'kept.txt')).toBe('kept\n');
    expect(read(root, 'created*[x].txt')).toBeNull();
    expect(read(root, 'notes.md')).toBe('mine\n');
    expect(read(root, path.join('build', 'out.js'))).toBe('ignored\n');

    // Redo puts the turn's result back.
    await store.restoreFiles(root, after, touched);
    expect(read(root, 'edited.txt')).toBe('after\n');
    expect(read(root, 'created*[x].txt')).toBe('new\n');
    expect(read(root, 'kept.txt')).toBeNull();

    // The user's own repository is left as it was: nothing staged or committed.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toContain('?? edited.txt');
    expect(fs.existsSync(path.join(dataDir, 'native-agents', 'snapshots'))).toBe(true);
  });

  it('runs one operation at a time per repository', async () => {
    const root = createRepository();
    const store = createSnapshotStore({ dataDir: tempDir('openchamber-snapshot-data-') });
    const trees = await Promise.all([store.capture(root), store.capture(root), store.capture(root)]);
    expect(new Set(trees).size).toBe(1);
  });
});
