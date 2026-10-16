import type { Metadata, ToolPart } from '@/lib/opencode/model';
import { OPENCODE_TOOLS, isNavigationTool, normalizeToolName, recordedFileChanges, type ToolName } from '@/lib/opencode/tools';

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);

// The simplified transcript keeps file changes, questions, subagents, plan
// mode, skills and explicitly marked MCP calls. A command joins them once
// its CLI recorded the files it changed.
const FILE_CHANGES_ONLY_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'write', 'apply_patch', 'patch', 'create', 'file_write', 'notebookedit',
    'task', 'subagent', 'question', 'plan_enter', 'plan_exit', 'skill',
]);

export const isExpandableTool = (toolName: ToolName, metadata?: Metadata): boolean => {
    return !isStaticTool(toolName, metadata);
};

export const isStandaloneTool = (toolName: ToolName, metadata?: Metadata): boolean => {
    return metadata?.openchamberToolSource !== 'mcp' && STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
export const isStaticTool = (toolName: ToolName, metadata?: Metadata): boolean => {
    return metadata?.openchamberToolSource !== 'mcp' && isNavigationTool(toolName);
};

/** Whether a tool call survives the simplified transcript's routine-tool filter. */
export const showsWithFileChangesOnly = (part: Pick<ToolPart, 'tool' | 'state'>): boolean => {
    const metadata = part.state.status === 'pending' ? undefined : part.state.metadata;
    if (metadata?.openchamberToolSource === 'mcp') return true;
    if (FILE_CHANGES_ONLY_TOOL_NAMES.has(normalizeToolName(part.tool))) return true;
    return part.state.status !== 'pending' && recordedFileChanges(part.tool, metadata) !== null;
};
