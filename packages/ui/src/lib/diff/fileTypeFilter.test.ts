import { describe, expect, test } from 'bun:test';
import { filterDiffFileTypes, normalizeExcludedFileTypes } from './fileTypeFilter';

describe('Changes file type filtering', () => {
  const files = ['src/index.TS', 'package.json', 'nested/config.JSON', 'archive.tar.gz', '.gitignore', 'Makefile', 'dir.with.dots/readme', 'C:\\project\\index.ts']
    .map((path) => ({ path }));

  test('excludes extensions case insensitively without changing its source', () => {
    const filtered = filterDiffFileTypes(files, ['json', 'ts']);
    expect(filtered.files.map((file) => file.path)).toEqual(['archive.tar.gz', '.gitignore', 'Makefile', 'dir.with.dots/readme']);
    expect(filtered.hiddenCount).toBe(4);
    expect(files.length).toBe(8);
    expect(filtered.options.find((option) => option.type === 'json')?.count).toBe(2);
  });

  test('groups extensionless names and uses the last extension', () => {
    const filtered = filterDiffFileTypes(files, ['', 'gz']);
    expect(filtered.hiddenCount).toBe(4);
    expect(filtered.options.find((option) => option.type === '')?.count).toBe(3);
    expect(filtered.options.some((option) => option.type === 'tar.gz')).toBe(false);
  });

  test('keeps absent excluded types recoverable and new types visible', () => {
    const filtered = filterDiffFileTypes([{ path: 'new.css' }], ['json']);
    expect(filtered.options).toEqual([{ type: 'css', count: 1 }, { type: 'json', count: 0 }]);
    expect(filtered.files).toEqual([{ path: 'new.css' }]);
  });

  test('restoring all keeps the source reference; excluding every type is empty', () => {
    expect(filterDiffFileTypes(files, []).files).toBe(files);
    expect(filterDiffFileTypes(files, ['', 'gz', 'json', 'ts']).files).toEqual([]);
  });

  test('normalizes persisted types while rejecting malformed entries', () => {
    expect(normalizeExcludedFileTypes(['TS', 'ts', '', null, 3, '.json', 'a/b', ' a', 'x\\y'])).toEqual(['', 'ts']);
    expect(normalizeExcludedFileTypes({ ts: true })).toEqual([]);
  });
});
