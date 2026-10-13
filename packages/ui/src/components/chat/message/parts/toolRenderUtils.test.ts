import { describe, expect, test } from 'bun:test';

import type { Metadata, ToolPart } from '@/lib/opencode/model';
import { isExpandableTool, isStandaloneTool, isStaticTool, showsWithFileChangesOnly } from './toolRenderUtils';

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

    test('keeps file changes, questions, subagents, plan mode and skills in the simplified transcript', () => {
        for (const tool of ['edit', 'write', 'multiedit', 'apply_patch', 'patch', 'create', 'file_write', 'notebookedit', 'task', 'subagent', 'question', 'plan_enter', 'plan_exit', 'skill', 'Skill', 'Edit', 'runtime.write:1']) {
            expect(showsWithFileChangesOnly(finished(tool))).toBe(true);
        }
        for (const tool of ['bash', 'shell', 'Read', 'read', 'Grep', 'grep', 'Glob', 'glob', 'todowrite', 'webfetch', 'websearch', 'linear_list_issues', 'mcp__linear__list_issues', 'unknown']) {
            expect(showsWithFileChangesOnly(finished(tool))).toBe(false);
        }
    });

    test('keeps explicitly marked MCP calls in every execution state, not unmarked namesakes', () => {
        const states: Array<Exclude<ToolPart['state'], { status: 'pending' }>> = [
            { status: 'running', input: {}, time: { start: 1 } },
            { status: 'completed', input: {}, output: 'found', time: { start: 1, end: 2 } },
            { status: 'error', input: {}, error: 'failed', time: { start: 1, end: 2 } },
        ];
        for (const state of states) {
            const tool = 'docs_search';
            expect(showsWithFileChangesOnly({ tool, state: { ...state, metadata: { openchamberToolSource: 'mcp' } } })).toBe(true);
            expect(showsWithFileChangesOnly({ tool, state })).toBe(false);
        }
    });

    test('uses explicit MCP provenance before built-in row classification', () => {
        const metadata: Metadata = { openchamberToolSource: 'mcp' };
        for (const tool of ['docs_read', 'docs_skill', 'read', 'skill', 'runtime.read:2', 'subagent']) {
            expect(isExpandableTool(tool, metadata)).toBe(true);
            expect(isStaticTool(tool, metadata)).toBe(false);
            expect(isStandaloneTool(tool, metadata)).toBe(false);
        }
        expect(isStandaloneTool('task')).toBe(true);
        expect(isStaticTool('skill', {})).toBe(true);
        expect(isExpandableTool('skill', {})).toBe(false);
    });

    test('does not infer missing or malformed provenance on cached tools', () => {
        const unmarked: Metadata[] = [{}, { openchamberToolSource: 'MCP' }, { openchamberToolSource: true }, { openchamberToolSource: { type: 'mcp' } }];
        for (const metadata of unmarked) {
            expect(showsWithFileChangesOnly(finished('docs_search', metadata))).toBe(false);
        }
        expect(showsWithFileChangesOnly({ tool: 'docs_search', state: { status: 'pending', input: {}, raw: '' } })).toBe(false);
        expect(showsWithFileChangesOnly({ tool: 'skill', state: { status: 'pending', input: {}, raw: '' } })).toBe(true);
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
