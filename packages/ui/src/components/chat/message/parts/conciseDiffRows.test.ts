import { describe, expect, test } from 'bun:test';

import { addedFilePatch, parseConciseDiffRows, writeInputOf } from './conciseDiffRows';

describe('concise diff rows', () => {
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
