import { describe, expect, test } from 'bun:test';

import { addedFilePatch, parseConciseDiffRows, writeInputOf } from './conciseDiffRows';
import { getRenderablePatchInfo } from './toolDiffUtils';

describe('concise diff rows', () => {
    test('compares replacement excerpts so shared lines stay neutral', () => {
        const patch = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1,3 +1,3 @@\n-first\n-old value\n-last\n+first\n+new value\n+last\n';
        expect(parseConciseDiffRows(patch, true)).toEqual([
            { kind: 'context', line: 1, text: 'first' },
            { kind: 'removed', line: 2, text: 'old value' },
            { kind: 'added', line: 2, text: 'new value' },
            { kind: 'context', line: 3, text: 'last' },
        ]);
        expect(parseConciseDiffRows(patch).filter((row) => row.kind === 'removed')).toHaveLength(3);
    });

    test('preserves missing final newlines while comparing recorded excerpts', () => {
        const patch = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1,2 +1,2 @@\n-same\n-old\n\\ No newline at end of file\n+same\n+new\n\\ No newline at end of file\n';
        expect(parseConciseDiffRows(patch, true).map((row) => row.kind)).toEqual(['context', 'removed', 'added']);
        const newlineOnly = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n';
        expect(parseConciseDiffRows(newlineOnly, true).map((row) => row.kind)).toEqual(['removed', 'added']);
    });

    test('preserves trailing content whitespace through patch normalization', () => {
        const patch = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1 +1 @@\n-same\n+same  \n';
        const normalized = getRenderablePatchInfo(patch)?.patch;
        expect(normalized).toBeDefined();
        expect(parseConciseDiffRows(normalized ?? '', true)).toEqual([
            { kind: 'removed', line: 1, text: 'same' },
            { kind: 'added', line: 1, text: 'same  ' },
        ]);
    });

    test('does not color identical replacement text as a change', () => {
        const patch = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1 +1 @@\n-same\n+same\n';
        expect(parseConciseDiffRows(patch, true)).toEqual([{ kind: 'context', line: 1, text: 'same' }]);
    });

    test('retains noncontiguous hunk boundaries instead of inventing missing context', () => {
        const patch = '--- excerpt.ts\n+++ excerpt.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -40 +40 @@\n-c\n+d\n';
        expect(parseConciseDiffRows(patch, true)).toEqual(parseConciseDiffRows(patch));
    });

    test('keeps context around small changes in long excerpts', () => {
        const before = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
        const after = [...before];
        after[500] = 'changed';
        const patch = `--- excerpt.ts\n+++ excerpt.ts\n@@ -1,1000 +1,1000 @@\n${before.map((line) => `-${line}`).join('\n')}\n${after.map((line) => `+${line}`).join('\n')}\n`;
        const rows = parseConciseDiffRows(patch, true);
        expect(rows.filter((row) => row.kind === 'context')).toHaveLength(6);
        expect(rows.filter((row) => row.kind === 'removed')).toHaveLength(1);
        expect(rows.filter((row) => row.kind === 'added')).toHaveLength(1);
    });

    test('preserves large rewritten middles without unbounded line alignment', () => {
        const before = Array.from({ length: 300 }, (_, index) => `old ${index}`);
        const after = Array.from({ length: 300 }, (_, index) => `new ${index}`);
        const patch = `--- excerpt.ts\n+++ excerpt.ts\n@@ -1,300 +1,300 @@\n${before.map((line) => `-${line}`).join('\n')}\n${after.map((line) => `+${line}`).join('\n')}\n`;
        expect(parseConciseDiffRows(patch, true)).toEqual(parseConciseDiffRows(patch));
    });
    test('numbers removed lines in the old file and the rest in the new one, leaving headers out', () => {
        const patch = [
            'diff --git a/src/parse.ts b/src/parse.ts',
            '--- a/src/parse.ts',
            '+++ b/src/parse.ts',
            '@@ -10,3 +10,4 @@ export function parse() {',
            '   const a = 1;',
            '-  return a;',
            '+  const b = 2;',
            '+  return b;',
            ' }',
            '\\ No newline at end of file',
            '',
        ].join('\n');
        expect(parseConciseDiffRows(patch)).toEqual([
            { kind: 'context', line: 10, text: '  const a = 1;' },
            { kind: 'removed', line: 11, text: '  return a;' },
            { kind: 'added', line: 11, text: '  const b = 2;' },
            { kind: 'added', line: 12, text: '  return b;' },
            { kind: 'context', line: 13, text: '}' },
        ]);
    });

    test('marks the unchanged lines left out between hunks', () => {
        const patch = '@@ -1 +1 @@\n-a\n+b\n@@ -40 +40 @@\n-c\n+d\n';
        expect(parseConciseDiffRows(patch).map((row) => row.kind)).toEqual(['removed', 'added', 'gap', 'removed', 'added']);
        expect(parseConciseDiffRows(patch).at(-1)).toEqual({ kind: 'added', line: 40, text: 'd' });
    });

    test('shows a written file as added lines from the first', () => {
        expect(parseConciseDiffRows(addedFilePatch('# Title\r\n\nbody\n'))).toEqual([
            { kind: 'added', line: 1, text: '# Title' },
            { kind: 'added', line: 2, text: '' },
            { kind: 'added', line: 3, text: 'body' },
        ]);
    });

    test('reads what a write put in its file, under any of the path names tools use', () => {
        expect(writeInputOf({ file_path: '/work/a.md', content: 'x' })).toEqual({ filePath: '/work/a.md', content: 'x' });
        expect(writeInputOf({ filePath: 'b.md', content: '' })).toEqual({ filePath: 'b.md', content: '' });
        expect(writeInputOf({ filePath: 'c.md' })).toBeNull();
    });
});
