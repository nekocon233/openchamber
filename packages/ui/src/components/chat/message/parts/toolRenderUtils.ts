// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

// What a transcript that shows only file changes keeps of the tool calls: the
// changes, and the calls that ask the user something or start work of their
// own (a subagent, plan mode).
const FILE_CHANGES_ONLY_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'write', 'apply_patch', 'patch', 'create', 'file_write', 'notebookedit',
    'task', 'question', 'plan_enter', 'plan_exit',
]);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

/** Whether a tool call shows in a transcript that shows only file changes. */
export const showsWithFileChangesOnly = (toolName: unknown): boolean => {
    return FILE_CHANGES_ONLY_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getToolDescriptionFallback = (
    toolName: unknown,
    description: unknown,
    input: Record<string, unknown> | undefined,
): string => {
    if (typeof description === 'string' && description.trim().length > 0) {
        return description;
    }

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};
