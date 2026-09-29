import { describe, expect, it } from 'vitest';

import { mapClaudeToolResult, slimFileEditResult } from './tools.js';
import { recordedFileChanges } from '@openchamber/ui/lib/opencode/tools';

const hunk = (oldStart, oldLines, newStart, newLines, lines) => ({ oldStart, oldLines, newStart, newLines, lines });
const file = (name, hunks, flags = {}) => ({ filePath: `/work/project/${name}`, hunks, ...flags });
const path = (name) => `/work/project/${name}`;
const typeFix = hunk(593, 4, 593, 3, ['     {', '-        var a = b as C;', '-        if (a == null) return;', '+        if (b is not C a) return;', '     }']);
const oneLine = hunk(10, 1, 10, 1, ['-old', '+new']);

// The Bash result Claude Code writes for a command that changed files: the
// command's output plus the record of what it changed.
const commandResult = (record) => ({ stdout: 'done', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, bashEditDiff: record });
const bashMetadata = (record) => mapClaudeToolResult('bash', 'done', commandResult(record)).metadata;

describe('file changes Claude Code recorded for a Bash command', () => {
  it('shows the hunks it kept as the diffs the edit renderers read', () => {
    const metadata = bashMetadata({ files: [file('src/Service.cs', [typeFix])], moreFiles: 0, changedFiles: [path('src/Service.cs')] });
    const diff = '--- /work/project/src/Service.cs\n+++ /work/project/src/Service.cs\n@@ -593,4 +593,3 @@\n'
      + '     {\n-        var a = b as C;\n-        if (a == null) return;\n+        if (b is not C a) return;\n     }\n';
    expect(metadata).toEqual({
      files: [{ filePath: path('src/Service.cs'), type: 'update', diff, additions: 1, deletions: 2 }],
      diff,
      recordedFileChanges: { withoutDiff: [], unnamed: 0 },
    });
  });

  it('names the changed files past its five diffs in the order the CLI listed them', () => {
    const shown = ['a.md', 'b.md', 'c.cs', 'd.cs', 'e.cs'];
    const metadata = bashMetadata({
      files: shown.map((name) => file(name, [oneLine])),
      moreFiles: 4,
      changedFiles: [...shown, 'f.cs', 'g.cs', 'h.cs', 'i.cs'].map(path),
    });
    expect(metadata.files.map((entry) => entry.filePath)).toEqual(shown.map(path));
    expect(metadata.recordedFileChanges).toEqual({ withoutDiff: ['f.cs', 'g.cs', 'h.cs', 'i.cs'].map(path), unnamed: 0 });
  });

  it('names a file whose change was too large to keep, with no diff', () => {
    expect(bashMetadata({ files: [], moreFiles: 1, changedFiles: [path('src/Big.cs')] })).toEqual({
      recordedFileChanges: { withoutDiff: [path('src/Big.cs')], unnamed: 0 },
    });
  });

  it('counts the changed files the CLI did not name once its list is cut', () => {
    const named = Array.from({ length: 200 }, (_, index) => path(`gen/${index}.txt`));
    const { recordedFileChanges } = bashMetadata({ files: [], moreFiles: 305, changedFiles: named });
    expect(recordedFileChanges.withoutDiff).toHaveLength(200);
    expect(recordedFileChanges.unnamed).toBe(105);
  });

  it('keeps an unavailable diff and changes shared with another command as flags', () => {
    expect(bashMetadata({ files: [file('a.cs', [oneLine])], moreFiles: 1, changedFiles: [path('a.cs'), path('huge.bin')], unavailable: true }).recordedFileChanges)
      .toEqual({ withoutDiff: [path('huge.bin')], unnamed: 0, unavailable: true });
    expect(bashMetadata({ files: [file('a.cs', [oneLine])], moreFiles: 0, changedFiles: [path('a.cs')], shared: true }).recordedFileChanges)
      .toEqual({ withoutDiff: [], unnamed: 0, shared: true });
  });

  it('tells created and deleted files from updates, empty ones included', () => {
    const metadata = bashMetadata({
      files: [
        file('new.txt', [hunk(0, 0, 1, 2, ['+one', '+two'])], { created: true }),
        file('empty.txt', [], { created: true }),
        file('gone.txt', [], { deleted: true }),
      ],
      moreFiles: 0,
      changedFiles: ['new.txt', 'empty.txt', 'gone.txt'].map(path),
    });
    expect(metadata.files.map((entry) => [entry.type, entry.diff])).toEqual([
      ['add', '--- /dev/null\n+++ /work/project/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n'],
      ['add', '--- /dev/null\n+++ /work/project/empty.txt\n@@ -0,0 +0,0 @@\n'],
      ['delete', '--- /work/project/gone.txt\n+++ /dev/null\n@@ -0,0 +0,0 @@\n'],
    ]);
    expect(metadata.recordedFileChanges.withoutDiff).toEqual([]);
  });

  it.each([
    ['a skipped git command', { files: [], moreFiles: 0, skipped: true }],
    ['a record that names nothing', { files: [], moreFiles: 0, unavailable: true }],
    ['a malformed record', { files: 'src/a.cs', moreFiles: 1 }],
    ['a negative count', { files: [], moreFiles: -1, changedFiles: [path('a.cs')] }],
  ])('adds nothing for %s', (_name, record) => {
    expect(bashMetadata(record)).toEqual({});
  });

  it('adds nothing when the command has no record or failed', () => {
    expect(mapClaudeToolResult('bash', 'done', { stdout: 'done', stderr: '', interrupted: false, isImage: false }).metadata).toEqual({});
    expect(mapClaudeToolResult('bash', 'Exit code 1', 'Error: Exit code 1').metadata).toEqual({});
  });

  it('reads the record only on a Bash call', () => {
    const record = { files: [file('a.cs', [oneLine])], moreFiles: 0, changedFiles: [path('a.cs')] };
    expect(mapClaudeToolResult('read', 'text', commandResult(record)).metadata).toEqual({});
  });

  it('keeps the record and drops the output when history slims the result, and projects it the same way', () => {
    const record = { files: [file('a.cs', [oneLine])], moreFiles: 1, changedFiles: [path('a.cs'), path('b.cs')] };
    const slim = slimFileEditResult(commandResult(record));
    expect(slim).toEqual({ bashEditDiff: record });
    expect(mapClaudeToolResult('bash', 'done', slim)).toEqual(mapClaudeToolResult('bash', 'done', commandResult(record)));
  });

  it('gives the UI a record it reads', () => {
    const metadata = bashMetadata({ files: [file('a.cs', [oneLine])], moreFiles: 1, changedFiles: [path('a.cs'), path('b.cs')], shared: true });
    expect(recordedFileChanges('bash', metadata)).toEqual({
      hasDiffs: true, withoutDiff: [path('b.cs')], unnamed: 0, unavailable: false, shared: true, complete: false,
    });
  });

  it('keeps nothing of a command that recorded no change', () => {
    expect(slimFileEditResult(commandResult({ files: [], moreFiles: 0, skipped: true }))).toBeNull();
    expect(slimFileEditResult({ stdout: 'done', stderr: '', interrupted: false, isImage: false })).toBeNull();
  });
});
