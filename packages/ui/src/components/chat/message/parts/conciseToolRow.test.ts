import { describe, expect, test } from 'bun:test';

import { countOutputLines, getConciseToolName, getConciseToolResult, type ConciseToolCall } from './conciseToolRow';

const call = (overrides: Partial<ConciseToolCall>): ConciseToolCall => ({
    tool: 'bash',
    phase: 'done',
    error: undefined,
    output: undefined,
    diffStats: null,
    writeLines: null,
    subagentToolCalls: 0,
    ...overrides,
});

describe('concise tool rows', () => {
    test('name built-in tools the way the CLIs do and keep any other name as called', () => {
        expect(getConciseToolName('bash', 'bash')).toBe('Bash');
        expect(getConciseToolName('apply_patch', 'apply_patch')).toBe('Patch');
        expect(getConciseToolName('taskcreate', 'TaskCreate')).toBe('TaskCreate');
        expect(getConciseToolName('github_create_issue', 'github_create_issue')).toBe('github_create_issue');
    });

    test('count output lines without the trailing blank ones', () => {
        expect(countOutputLines('')).toBe(0);
        expect(countOutputLines('  \n\n')).toBe(0);
        expect(countOutputLines('one')).toBe(1);
        expect(countOutputLines('one\ntwo\n\n')).toBe(2);
        expect(countOutputLines(Array.from({ length: 40 }, (_, index) => String(index + 1)).join('\n'))).toBe(40);
    });

    test('show what a finished call produced', () => {
        expect(getConciseToolResult(call({ output: 'a\nb\nc' }))).toEqual({ kind: 'lines', count: 3 });
        expect(getConciseToolResult(call({ output: '' }))).toEqual({ kind: 'noOutput' });
        expect(getConciseToolResult(call({ tool: 'edit', output: 'Edited.', diffStats: { added: 1, removed: 1 } }))).toEqual({ kind: 'diff', added: 1, removed: 1 });
        expect(getConciseToolResult(call({ tool: 'write', output: 'Wrote file.', writeLines: 4 }))).toEqual({ kind: 'added', lines: 4 });
    });

    test('leave the line out where a count would only restate a status sentence', () => {
        expect(getConciseToolResult(call({ tool: 'edit', output: 'The file has been updated.' }))).toBeNull();
        expect(getConciseToolResult(call({ tool: 'todowrite', output: '[{"content":"a"}]' }))).toBeNull();
        expect(getConciseToolResult(call({ tool: 'mystery' }))).toBeNull();
    });

    test('show the first line of a failure', () => {
        expect(getConciseToolResult(call({ phase: 'failed', error: '\n  Command exited with code 1\nstack…' }))).toEqual({ kind: 'error', text: 'Command exited with code 1' });
        expect(getConciseToolResult(call({ phase: 'failed', error: '   ' }))).toBeNull();
    });

    test('while running, show a timer for commands and progress for subagents', () => {
        expect(getConciseToolResult(call({ phase: 'running' }))).toEqual({ kind: 'running' });
        expect(getConciseToolResult(call({ tool: 'grep', phase: 'running' }))).toBeNull();
        expect(getConciseToolResult(call({ tool: 'task', phase: 'running', subagentToolCalls: 3 }))).toEqual({ kind: 'toolCalls', count: 3 });
        expect(getConciseToolResult(call({ tool: 'task', phase: 'done', output: 'Report' }))).toBeNull();
    });
});
