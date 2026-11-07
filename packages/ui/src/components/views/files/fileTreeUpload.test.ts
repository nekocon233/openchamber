import { expect, test } from 'bun:test';
import type { FilesAPI } from '@/lib/api/types';
import { FilesystemError } from '@/lib/api/files-errors';
import { droppedUploadFiles, selectedUploadFiles, uploadFileTree, type UploadDropData, type UploadEntry } from './fileTreeUpload';

// SAFETY: This browser fixture supplies the file members used by directory collection.
const fileEntry = (name: string, content = name): FileSystemFileEntry => ({
  name, isFile: true, isDirectory: false,
  file: (resolve: FileCallback) => queueMicrotask(() => resolve(new File([content], name))),
} as FileSystemFileEntry);

// SAFETY: This browser fixture supplies the directory reader used by directory collection.
const directoryEntry = (name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry => ({
  name, isFile: false, isDirectory: true,
  createReader: () => {
    let offset = 0;
    return {
      readEntries: (resolve: FileSystemEntriesCallback) => {
        const entries = children.slice(offset, offset + 100);
        offset += 100;
        queueMicrotask(() => resolve(entries));
      },
    };
  },
} as FileSystemDirectoryEntry);

const transfer = (entries: FileSystemEntry[]): UploadDropData => ({
  items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
  files: [],
});

test('a dropped directory reads every batch and retains nested and empty directories', async () => {
  const entries = Array.from({ length: 250 }, (_, index) => fileEntry(`${index}.txt`));
  const selection = await droppedUploadFiles(transfer([
    directoryEntry('素材', [...entries, directoryEntry('empty', []), directoryEntry('nested', [fileEntry('0.txt')])]),
    fileEntry('loose.txt'),
  ]));
  expect(selection.failures).toEqual([]);
  expect(selection.entries.filter((entry) => entry.kind === 'file')).toHaveLength(252);
  expect(selection.entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.relativePath))
    .toEqual(['素材', '素材/empty', '素材/nested']);
  expect(selection.entries.map((entry) => entry.relativePath)).toContain('素材/nested/0.txt');
});

test('drop entries are captured before async traversal and an unreadable file leaves siblings intact', async () => {
  let readable = true;
  const broken = fileEntry('broken.txt');
  broken.file = (_resolve, reject) => reject?.(new DOMException('No access', 'NotReadableError'));
  const dropped = transfer([directoryEntry('first', [broken, fileEntry('ok.txt')]), fileEntry('second.txt')]);
  for (const item of Array.from(dropped.items)) {
    const read = item.webkitGetAsEntry;
    item.webkitGetAsEntry = () => readable ? read?.() ?? null : null;
  }
  const pending = droppedUploadFiles(dropped);
  readable = false;
  const selection = await pending;
  expect(selection.failures).toEqual(['first/broken.txt']);
  expect(selection.entries.map((entry) => entry.relativePath)).toEqual(['first', 'first/ok.txt', 'second.txt']);
});

test('directory picker paths keep the outer folder and reject traversal without flattening', () => {
  const pick = (name: string, path: string): File => {
    const file = new File(['content'], name);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  };
  const selection = selectedUploadFiles([
    pick('a.txt', 'photos/one/a.txt'), pick('b.txt', 'photos/one/b.txt'),
    pick('escape.txt', '../escape.txt'), pick('plain.txt', ''),
  ], true);
  expect(selection.entries.map((entry) => entry.relativePath)).toEqual([
    'photos', 'photos/one', 'photos/one/a.txt', 'photos/one/b.txt',
  ]);
  expect(selection.failures).toEqual(['escape.txt', 'plain.txt']);
  expect(selectedUploadFiles([new File(['bad'], 'nested/file.txt')]).entries).toEqual([]);
});

const memoryFiles = () => {
  const contents = new Map<string, string>();
  const directories = new Set(['/repo']);
  const api: FilesAPI = {
    listDirectory: async (path) => ({ directory: path, entries: [] }),
    search: async () => [],
    createDirectory: async (path, options) => {
      expect(options?.directory).toBe('/repo');
      if (contents.has(path)) throw new Error('Not a directory');
      directories.add(path);
      return { success: true, path };
    },
    uploadFile: async (path, file, options) => {
      expect(options?.directory).toBe('/repo');
      expect(directories.has(path.slice(0, path.lastIndexOf('/')))).toBe(true);
      if (contents.has(path) && !options?.overwrite) throw new FilesystemError('Exists', { reason: 'already-exists' });
      contents.set(path, await file.text());
      return { success: true, path };
    },
  };
  return { api, contents, directories };
};

test('uploads merge directories, retain empty directories and replace only confirmed relative paths', async () => {
  const { api, contents, directories } = memoryFiles();
  directories.add('/repo/assets');
  contents.set('/repo/assets/keep.txt', 'keep');
  contents.set('/repo/assets/same.txt', 'old');
  const entries: UploadEntry[] = [
    { kind: 'directory', relativePath: 'assets' },
    { kind: 'directory', relativePath: 'assets/empty' },
    { kind: 'file', relativePath: 'assets/same.txt', file: new File(['new'], 'same.txt') },
    { kind: 'file', relativePath: 'assets/new.txt', file: new File(['added'], 'new.txt') },
  ];
  const run = (selection: UploadEntry[], overwrite = false) => uploadFileTree({
    files: api, directory: '/repo', workspaceRoot: '/repo', selection: { entries: selection, failures: [] }, overwrite, isCurrent: () => true,
  });
  const result = await run(entries);
  expect(contents.get('/repo/assets/keep.txt')).toBe('keep');
  expect(contents.get('/repo/assets/same.txt')).toBe('old');
  expect(result.conflicts.map((entry) => entry.relativePath)).toEqual(['assets/same.txt']);
  expect(result.uploadedPaths).toEqual(['/repo/assets/new.txt']);
  expect(directories.has('/repo/assets/empty')).toBe(true);
  await run(result.conflicts, true);
  expect(contents.get('/repo/assets/same.txt')).toBe('new');
  expect(contents.get('/repo/assets/keep.txt')).toBe('keep');
});

test('a blocked directory and an invalid path cannot prevent independent uploads', async () => {
  const { api, contents } = memoryFiles();
  contents.set('/repo/blocked', 'existing file');
  const result = await uploadFileTree({
    files: api, directory: '/repo', workspaceRoot: '/repo', overwrite: false, isCurrent: () => true,
    selection: { entries: [
      { kind: 'directory', relativePath: 'blocked' },
      { kind: 'directory', relativePath: 'blocked/child' },
      { kind: 'file', relativePath: 'blocked/child/a.txt', file: new File(['bad'], 'a.txt') },
      { kind: 'file', relativePath: '../escape.txt', file: new File(['bad'], 'escape.txt') },
      { kind: 'file', relativePath: 'ok.txt', file: new File(['ok'], 'ok.txt') },
    ], failures: ['unreadable'] },
  });
  expect([...contents]).toEqual([['/repo/blocked', 'existing file'], ['/repo/ok.txt', 'ok']]);
  expect(result.failures).toEqual(['unreadable', 'blocked', 'blocked/child', 'blocked/child/a.txt', '../escape.txt']);
});

test('uploads are capped at three and stop dispatching after the workspace changes', async () => {
  const { api } = memoryFiles();
  let current = true;
  const started: string[] = [];
  const releases: Array<() => void> = [];
  api.uploadFile = async (path) => {
    started.push(path);
    await new Promise<void>((resolve) => releases.push(resolve));
    return { success: true, path };
  };
  const pending = uploadFileTree({
    files: api, directory: '/repo', workspaceRoot: '/repo', overwrite: false, isCurrent: () => current,
    selection: { entries: Array.from({ length: 1000 }, (_, index) => ({
      kind: 'file', relativePath: `${index}.txt`, file: new File(['data'], `${index}.txt`),
    })), failures: [] },
  });
  expect(started).toHaveLength(3);
  current = false;
  releases.forEach((release) => release());
  const result = await pending;
  expect(started).toHaveLength(3);
  expect(result.uploadedPaths).toHaveLength(3);
});

test('uploads at the filesystem root refresh the root for files and empty directories', async () => {
  const changed: string[][] = [];
  const files: FilesAPI = {
    listDirectory: async (path) => ({ directory: path, entries: [] }),
    search: async () => [],
    createDirectory: async (path) => ({ success: true, path }),
    uploadFile: async (path) => ({ success: true, path }),
  };
  for (const entry of [
    { kind: 'file', relativePath: 'a.txt', file: new File(['data'], 'a.txt') },
    { kind: 'directory', relativePath: 'empty' },
  ] satisfies UploadEntry[]) {
    const result = await uploadFileTree({
      files, directory: '/', workspaceRoot: '/', selection: { entries: [entry], failures: [] }, overwrite: false, isCurrent: () => true,
    });
    changed.push(result.changedDirectories);
  }
  expect(changed).toEqual([['/'], ['/']]);
});
