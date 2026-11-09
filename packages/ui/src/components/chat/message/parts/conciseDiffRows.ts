// The lines of a file change as the concise transcript shows them under the
// call, the way the Claude Code terminal prints an edit: numbered lines on
// green for what was added and red for what was removed. See DOCUMENTATION.md,
// "Concise transcript".

import type { ToolPart } from '@/lib/opencode/model';
import { z } from 'zod';
import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';

export type ConciseDiffRow =
    /** Unchanged lines left out between two hunks. */
    | { kind: 'gap' }
    | { kind: 'context' | 'added' | 'removed'; line: number; text: string };

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

// Large rewritten middles keep their literal preview rather than blocking a
// synchronous transcript render. Shared edges are still shown as context.
const MAX_REPLACEMENT_ALIGNMENT_LINES = 200;
const REPLACEMENT_CONTEXT_LINES = 3;

const replacementRows = (patch: string): ConciseDiffRow[] | null => {
    try {
        // The UI normalizes away structural trailing newlines. Missing file
        // newlines are recorded by explicit patch markers, not this delimiter.
        const patches = parsePatchFiles(patch.endsWith('\n') ? patch : `${patch}\n`, undefined, true);
        const file = patches[0]?.files[0];
        if (patches.length !== 1 || patches[0].files.length !== 1 || !file || file.hunks.length !== 1) return null;
        const hunk = file.hunks[0];
        if (!hunk || hunk.deletionStart > 1 || hunk.additionStart > 1) return null;

        const before = file.deletionLines;
        const after = file.additionLines;
        let start = 0;
        while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
        let beforeEnd = before.length;
        let afterEnd = after.length;
        while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
            beforeEnd -= 1;
            afterEnd -= 1;
        }

        const rows: ConciseDiffRow[] = [];
        const append = (kind: 'context' | 'removed' | 'added', lines: string[], from: number, count: number, offset = 0) => {
            for (let index = from; index < from + count; index += 1) {
                const line = lines[index];
                if (line === undefined) throw new Error('Missing replacement line');
                rows.push({ kind, line: index + offset + 1, text: line.replace(/\r?\n$/, '') });
            }
        };
        const leading = Math.max(0, start - REPLACEMENT_CONTEXT_LINES);
        append('context', after, leading, start - leading);
        const middleLines = beforeEnd + afterEnd - start * 2;
        if (middleLines > MAX_REPLACEMENT_ALIGNMENT_LINES) {
            append('removed', before, start, beforeEnd - start);
            append('added', after, start, afterEnd - start);
        } else if (middleLines > 0) {
            const compared = parseDiffFromFile(
                { name: 'replacement', contents: before.slice(start, beforeEnd).join('') },
                { name: 'replacement', contents: after.slice(start, afterEnd).join('') },
                { context: REPLACEMENT_CONTEXT_LINES },
                true,
            );
            for (const [index, change] of compared.hunks.entries()) {
                if (index > 0) rows.push({ kind: 'gap' });
                for (const block of change.hunkContent) {
                    if (block.type === 'context') {
                        append('context', compared.additionLines, block.additionLineIndex, block.lines, start);
                    } else {
                        append('removed', compared.deletionLines, block.deletionLineIndex, block.deletions, start);
                        append('added', compared.additionLines, block.additionLineIndex, block.additions, start);
                    }
                }
            }
        }
        append('context', after, afterEnd, Math.min(REPLACEMENT_CONTEXT_LINES, after.length - afterEnd));
        return rows;
    } catch {
        // Keep the recorded patch readable when it cannot be compared safely.
        return null;
    }
};

/**
 * The rows of a unified diff: removed lines numbered in the old file, added and
 * unchanged lines in the new one. File headers and anything before the first
 * hunk are left out.
 */
export const parseConciseDiffRows = (patch: string, replacementPreview = false): ConciseDiffRow[] => {
    if (replacementPreview) {
        const compared = replacementRows(patch);
        if (compared !== null) return compared;
    }
    const rows: ConciseDiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const line of patch.split('\n')) {
        const header = HUNK_HEADER.exec(line);
        if (header) {
            if (inHunk) rows.push({ kind: 'gap' });
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;
        const sign = line.charAt(0);
        const text = line.slice(1);
        if (sign === '+') {
            rows.push({ kind: 'added', line: newLine, text });
            newLine += 1;
        } else if (sign === '-') {
            rows.push({ kind: 'removed', line: oldLine, text });
            oldLine += 1;
        } else if (sign === ' ') {
            rows.push({ kind: 'context', line: newLine, text });
            oldLine += 1;
            newLine += 1;
        }
        // `\ No newline at end of file` and blank trailing lines carry no row.
    }
    return rows;
};

const writeInputSchema = z.object({
    content: z.string(),
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    path: z.string().optional(),
});

/** What a write put in its file, or null when its input names no content. */
export const writeInputOf = (input: ToolPart['state']['input']): { filePath: string | undefined; content: string } | null => {
    const parsed = writeInputSchema.safeParse(input);
    if (!parsed.success) return null;
    return { filePath: parsed.data.filePath ?? parsed.data.file_path ?? parsed.data.path, content: parsed.data.content };
};

/** A whole file as added lines, for a write whose metadata carries no diff. */
export const addedFilePatch = (content: string): string => {
    const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
};
