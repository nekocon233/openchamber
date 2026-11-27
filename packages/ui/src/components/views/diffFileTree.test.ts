import { describe, expect, test } from 'bun:test';
import { buildDiffTreeRows } from './diffFileTree';

const files = [
  { path: 'packages/ui/src/a.ts' },
  { path: 'packages/ui/src/lib/b.ts' },
  { path: 'packages/web/c.js' },
  { path: 'README.md' },
];

const describeRows = (collapsed: string[]) =>
  buildDiffTreeRows(files, new Set(collapsed)).map((row) =>
    row.kind === 'directory' ? `${row.depth}:${row.label}/ (${row.fileCount})` : `${row.depth}:${row.name}`,
  );

describe('buildDiffTreeRows', () => {
  test('merges single-child directory chains and lists directories before files', () => {
    expect(describeRows([])).toEqual([
      '0:packages/ (3)',
      '1:ui/src/ (2)',
      '2:lib/ (1)',
      '3:b.ts',
      '2:a.ts',
      '1:web/ (1)',
      '2:c.js',
      '0:README.md',
    ]);
  });

  test('names a directory entry such as a nested repository by its folder', () => {
    const rows = buildDiffTreeRows([{ path: 'services/' }, { path: 'projects/api/' }], new Set());
    expect(rows.map((row) => (row.kind === 'directory' ? `${row.depth}:${row.label}/` : `${row.depth}:${row.name}`))).toEqual([
      '0:projects/',
      '1:api/',
      '0:services/',
    ]);
  });

  test('hides the contents of a collapsed directory by its merged path', () => {
    expect(describeRows(['packages/ui/src'])).toEqual([
      '0:packages/ (3)',
      '1:ui/src/ (2)',
      '1:web/ (1)',
      '2:c.js',
      '0:README.md',
    ]);
  });

  test('shows a review mark on a renamed file and its collapsed ancestors', () => {
    const changes = [
      ...files,
      { path: 'packages/ui/src/widget.ts', previousPath: 'packages/ui/src/old-widget.ts' },
    ];
    const commentedPaths = new Set(['packages/ui/src/old-widget.ts', 'packages/excluded.ts']);
    const markedRows = (collapsed: string[]) => buildDiffTreeRows(changes, new Set(collapsed), commentedPaths)
      .filter((row) => row.viewerCommented).map((row) => row.key);
    expect(markedRows(['packages/ui/src'])).toEqual(['dir:packages', 'dir:packages/ui/src']);
    expect(markedRows([])).toEqual(['dir:packages', 'dir:packages/ui/src', 'file:packages/ui/src/widget.ts']);
  });
});
