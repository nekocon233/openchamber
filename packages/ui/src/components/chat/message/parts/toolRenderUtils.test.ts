import { describe, expect, test } from 'bun:test';

import type { Metadata, ToolPart } from '@/lib/opencode/model';
import { isExpandableTool, isStaticTool, showsWithFileChangesOnly } from './toolRenderUtils';

const finished = (tool: string, metadata: Metadata = {}): Pick<ToolPart, 'tool' | 'state'> => ({
    tool,
    state: { status: 'completed', input: {}, output: '', metadata, time: { start: 1, end: 2 } },
});
const recorded = (record: Metadata['recordedFileChanges'], files: Metadata['files'] = []): Metadata => ({ files, recordedFileChanges: record });
const aDiff = { filePath: '/work/project/a.cs', type: 'update', diff: '--- /work/project/a.cs\n+++ /work/project/a.cs\n@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1 };

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('bash')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });

    test('keeps file changes and the calls that ask the user or start work when only file changes show', () => {
        for (const tool of ['edit', 'write', 'multiedit', 'apply_patch', 'task', 'question', 'plan_exit', 'Edit', 'runtime.write:1']) {
            expect(showsWithFileChangesOnly(finished(tool))).toBe(true);
        }
        for (const tool of ['bash', 'read', 'grep', 'glob', 'todowrite', 'webfetch', 'skill', 'linear_list_issues']) {
            expect(showsWithFileChangesOnly(finished(tool))).toBe(false);
        }
    });

    test('keeps a command once its CLI recorded the files it changed', () => {
        expect(showsWithFileChangesOnly(finished('bash', recorded({ withoutDiff: [], unnamed: 0 }, [aDiff])))).toBe(true);
        expect(showsWithFileChangesOnly(finished('bash', recorded({ withoutDiff: ['/work/project/Big.cs'], unnamed: 0 })))).toBe(true);
        // No record, a record that names nothing, or a running command stays out.
        expect(showsWithFileChangesOnly(finished('bash', { output: 'done', exit: 0 }))).toBe(false);
        expect(showsWithFileChangesOnly(finished('bash', recorded({ withoutDiff: [], unnamed: 0 })))).toBe(false);
        expect(showsWithFileChangesOnly({ tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } } })).toBe(false);
        // Only a command's record counts.
        expect(showsWithFileChangesOnly(finished('grep', recorded({ withoutDiff: ['/work/project/Big.cs'], unnamed: 0 })))).toBe(false);
    });
});
