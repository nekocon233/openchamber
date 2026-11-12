import { describe, expect, test } from 'bun:test';
import { changeRequestFileStatsSchema, summarizeFileStats } from './fileStats';

const stats = {
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: [
    { path: 'src/new.ts', additions: 10, deletions: 2 },
    { path: 'docs/readme.md', additions: 20, deletions: 3 },
    { path: 'image.png', additions: 0, deletions: 0 },
    { path: 'Makefile', additions: 4, deletions: 1 },
  ],
};

describe('filtered PR file statistics', () => {
  test('uses the same extension filter as Changes and counts binary files', () => {
    expect(summarizeFileStats(stats, ['md', ''])).toEqual({ files: 2, additions: 10, deletions: 2 });
    expect(summarizeFileStats(stats, [])).toEqual({ files: 4, additions: 34, deletions: 6 });
  });
  test('a fully filtered changeset is a measured zero', () => {
    expect(summarizeFileStats(stats, ['ts', 'md', 'png', ''])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
  test('unknown line counts never masquerade as zero or a partial total', () => {
    const unknown = { ...stats, files: [...stats.files, { path: 'large.ts', additions: null, deletions: 1 }] };
    expect(summarizeFileStats(unknown, [])).toEqual({ files: 5, additions: null, deletions: 7 });
    expect(summarizeFileStats(unknown, ['ts'])).toEqual({ files: 3, additions: 24, deletions: 4 });
  });
  test('rejects malformed counts, revisions and duplicate paths at the API boundary', () => {
    expect(changeRequestFileStatsSchema.safeParse(stats).success).toBe(true);
    for (const value of [
      { ...stats, headSha: '' }, { ...stats, files: [{ path: 'a', additions: -1, deletions: 0 }] },
      { ...stats, files: [{ path: 'a', additions: 1 }] }, { ...stats, files: [stats.files[0], stats.files[0]] },
    ]) expect(changeRequestFileStatsSchema.safeParse(value).success).toBe(false);
  });
});
