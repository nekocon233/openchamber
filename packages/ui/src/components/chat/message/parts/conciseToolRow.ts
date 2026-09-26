// What the concise transcript shows for a tool call: a CLI-style name and a
// one-line result, the way the Claude Code terminal prints `Bash(ls)` and the
// line under it. See DOCUMENTATION.md, "Concise transcript".

// Built-in tools under the names the CLIs use. Any other tool keeps the name it
// was called by, which already reads that way (`TaskCreate`, `github_search`).
const CONCISE_TOOL_NAMES = new Map<string, string>([
    ['bash', 'Bash'],
    ['shell', 'Shell'],
    ['patch', 'Patch'],
    ['subagent', 'Task'],
    ['execute', 'Script'],
    ['read', 'Read'],
    ['write', 'Write'],
    ['edit', 'Edit'],
    ['multiedit', 'MultiEdit'],
    ['apply_patch', 'Patch'],
    ['grep', 'Grep'],
    ['glob', 'Glob'],
    ['list', 'List'],
    ['webfetch', 'WebFetch'],
    ['websearch', 'WebSearch'],
    ['codesearch', 'CodeSearch'],
    ['task', 'Task'],
    ['todowrite', 'TodoWrite'],
    ['todoread', 'TodoRead'],
    ['skill', 'Skill'],
    ['question', 'Question'],
    ['lsp', 'LSP'],
    ['plan_enter', 'EnterPlanMode'],
    ['plan_exit', 'ExitPlanMode'],
]);

// File tools report what they changed. Their output is a status sentence, so
// without diff numbers they show no result line rather than "1 line".
const FILE_CHANGE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch', 'patch']);

/** Whether a call changes files, so the concise transcript shows its diff. @param normalizedTool lowercase name without a namespace */
export const isFileChangeTool = (normalizedTool: string): boolean => FILE_CHANGE_TOOLS.has(normalizedTool);

// Tools whose own row or body already says what happened.
const TOOLS_WITHOUT_RESULT_LINE = new Set(['question', 'todowrite', 'todoread', 'plan_enter', 'plan_exit', 'skill']);

/** @param normalizedTool lowercase name without a namespace; @param calledAs the name the call used */
export const getConciseToolName = (normalizedTool: string, calledAs: string): string => (
    CONCISE_TOOL_NAMES.get(calledAs.toLowerCase()) ?? CONCISE_TOOL_NAMES.get(normalizedTool) ?? calledAs
);

/** Lines in a finished tool's output, not counting trailing blank lines. */
export const countOutputLines = (output: string): number => {
    const text = output.trimEnd();
    if (!text) return 0;
    let lines = 1;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
        lines += 1;
    }
    return lines;
};

export type ConciseToolResult =
    | { kind: 'error'; text: string }
    | { kind: 'running' }
    | { kind: 'diff'; added: number; removed: number }
    | { kind: 'added'; lines: number }
    | { kind: 'toolCalls'; count: number }
    | { kind: 'lines'; count: number }
    | { kind: 'noOutput' };

export type ConciseToolCall = {
    /** Lowercase tool name without a namespace. */
    tool: string;
    phase: 'running' | 'done' | 'failed';
    error: string | undefined;
    output: string | undefined;
    diffStats: { added: number; removed: number } | null;
    /** Lines a write puts in its file. */
    writeLines: number | null;
    /** Calls a subagent has made so far. */
    subagentToolCalls: number;
};

/** The line under a tool call, or null when the call gets none. */
export const getConciseToolResult = (call: ConciseToolCall): ConciseToolResult | null => {
    if (call.phase === 'failed') {
        const text = call.error?.split('\n').map((line) => line.trim()).find(Boolean);
        return text ? { kind: 'error', text } : null;
    }
    if ((call.tool === 'task' || call.tool === 'subagent')) {
        return call.subagentToolCalls > 0 ? { kind: 'toolCalls', count: call.subagentToolCalls } : null;
    }
    if (call.phase === 'running') {
        return (call.tool === 'bash' || call.tool === 'shell') ? { kind: 'running' } : null;
    }
    if (call.diffStats) return { kind: 'diff', ...call.diffStats };
    if (call.writeLines !== null) return { kind: 'added', lines: call.writeLines };
    if (FILE_CHANGE_TOOLS.has(call.tool) || TOOLS_WITHOUT_RESULT_LINE.has(call.tool) || call.output === undefined) return null;
    const count = countOutputLines(call.output);
    return count === 0 ? { kind: 'noOutput' } : { kind: 'lines', count };
};
