// The lines of a file change as the concise transcript shows them under the
// call, the way the Claude Code terminal prints an edit: numbered lines on
// green for what was added and red for what was removed. See DOCUMENTATION.md,
// "Concise transcript".

import type { ToolPart } from '@/lib/opencode/model';
import { z } from 'zod';

export type ConciseDiffRow =
    /** Unchanged lines left out between two hunks. */
    | { kind: 'gap' }
    | { kind: 'context' | 'added' | 'removed'; line: number; text: string };

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * The rows of a unified diff: removed lines numbered in the old file, added and
 * unchanged lines in the new one. File headers and anything before the first
 * hunk are left out.
 */
export const parseConciseDiffRows = (patch: string): ConciseDiffRow[] => {
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
