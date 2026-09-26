import type { JsonValue, ToolInput } from '@/lib/opencode/model';
import { OPENCODE_TOOLS, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.skill]);

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);

// What a transcript that shows only file changes keeps of the tool calls: the
// changes, and the calls that ask the user something or start work of their
// own (a subagent, plan mode).
const FILE_CHANGES_ONLY_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'write', 'apply_patch', 'patch', 'create', 'file_write', 'notebookedit',
    'task', 'subagent', 'question', 'plan_enter', 'plan_exit',
]);

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: ToolName): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

/** Whether a tool call shows in a transcript that shows only file changes. */
export const showsWithFileChangesOnly = (toolName: ToolName): boolean => {
    return FILE_CHANGES_ONLY_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getToolDescriptionFallback = (
    toolName: ToolName,
    description: JsonValue | undefined,
    input: ToolInput | undefined,
): string => {
    if (typeof description === 'string' && description.trim().length > 0) {
        return description;
    }

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};
