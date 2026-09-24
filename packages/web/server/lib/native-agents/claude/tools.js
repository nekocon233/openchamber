// Maps Claude Code tool calls onto the OpenCode tool names and input keys the
// chat renderers know (packages/ui/src/components/chat/message/parts). Tool
// input is model-generated JSON, so every known tool is parsed at this
// boundary; anything else keeps its input as-is under its own name.

import { z } from 'zod';

import { claudeFileEntry, fileDiffMetadata } from '../file-diff.js';

const loose = (fields) => z.object(fields).passthrough();

const bashInput = loose({ command: z.string(), description: z.string().optional(), timeout: z.number().optional() });
const readInput = loose({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() });
const writeInput = loose({ file_path: z.string(), content: z.string() });
const editInput = loose({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
const multiEditInput = loose({ file_path: z.string(), edits: z.array(z.unknown()) });
const globInput = loose({ pattern: z.string(), path: z.string().optional() });
const grepInput = loose({ pattern: z.string(), path: z.string().optional() });
const webFetchInput = loose({ url: z.string(), prompt: z.string().optional() });
const webSearchInput = loose({ query: z.string() });
const todoWriteInput = loose({
  todos: z.array(loose({ content: z.string(), status: z.string(), priority: z.string().optional() })),
});
const taskInput = loose({
  description: z.string().optional(),
  prompt: z.string().optional(),
  subagent_type: z.string().optional(),
});
const questionInput = loose({
  questions: z.array(loose({
    question: z.string(),
    header: z.string().optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(loose({ label: z.string(), description: z.string().optional() })).optional(),
  })),
});
const exitPlanInput = loose({ plan: z.string() });
const skillInput = loose({ skill: z.string().optional(), command: z.string().optional() });
const anyInput = z.record(z.string(), z.unknown());

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

// The fields an unmapped tool's input usually leads with, in the order that
// best says what one call does. Its title is the first of them that is set.
const TITLE_FIELDS = ['subject', 'description', 'query', 'pattern', 'url', 'file_path', 'path', 'name', 'command', 'prompt', 'title'];
const TITLE_MAX_LENGTH = 120;
const titleText = z.string().trim().min(1);

const titleOf = (input) => {
  for (const field of TITLE_FIELDS) {
    const value = titleText.safeParse(input[field]);
    if (value.success) return value.data.split('\n')[0].slice(0, TITLE_MAX_LENGTH);
  }
  return '';
};

/**
 * @param {string} name Claude tool name
 * @param {Record<string, unknown>} rawInput
 * @returns {{ tool: string, input: Record<string, unknown>, title: string }}
 */
export const mapClaudeToolUse = (name, rawInput) => {
  const mapped = mapKnownTool(name, rawInput);
  if (mapped) return mapped;
  const input = anyInput.catch({}).parse(rawInput);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  // The renderers already show the tool's name; the title says what this call did.
  return { tool: mcp ? `${mcp[1]}_${mcp[2]}` : name, input, title: titleOf(input) };
};

const mapKnownTool = (name, rawInput) => {
  switch (name) {
    case 'Bash': {
      const input = bashInput.safeParse(rawInput);
      if (!input.success) return null;
      const { command, description } = input.data;
      return {
        tool: 'bash',
        input: description === undefined ? { command } : { command, description },
        title: description ?? command.split('\n')[0],
      };
    }
    case 'Read': {
      const input = readInput.safeParse(rawInput);
      if (!input.success) return null;
      const { file_path: filePath, offset, limit } = input.data;
      const mappedInput = { filePath };
      if (offset !== undefined) mappedInput.offset = offset;
      if (limit !== undefined) mappedInput.limit = limit;
      return { tool: 'read', input: mappedInput, title: filePath };
    }
    case 'Write': {
      const input = writeInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'write', input: { filePath: input.data.file_path, content: input.data.content }, title: input.data.file_path };
    }
    case 'Edit': {
      const input = editInput.safeParse(rawInput);
      if (!input.success) return null;
      const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = input.data;
      const mappedInput = { filePath, oldString, newString };
      if (replaceAll !== undefined) mappedInput.replaceAll = replaceAll;
      return { tool: 'edit', input: mappedInput, title: filePath };
    }
    case 'MultiEdit': {
      const input = multiEditInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'edit', input: { filePath: input.data.file_path, edits: input.data.edits }, title: input.data.file_path };
    }
    case 'Glob': {
      const input = globInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'glob', input: input.data, title: input.data.pattern };
    }
    case 'Grep': {
      const input = grepInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'grep', input: input.data, title: input.data.pattern };
    }
    case 'WebFetch': {
      const input = webFetchInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'webfetch', input: input.data, title: input.data.url };
    }
    case 'WebSearch': {
      const input = webSearchInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'websearch', input: input.data, title: input.data.query };
    }
    case 'TodoWrite': {
      const input = todoWriteInput.safeParse(rawInput);
      if (!input.success) return null;
      const todos = input.data.todos.map((todo) => ({
        content: todo.content,
        status: TODO_STATUSES.has(todo.status) ? todo.status : 'pending',
        priority: todo.priority ?? 'medium',
      }));
      return { tool: 'todowrite', input: { todos }, title: `${todos.length} todos` };
    }
    case 'Task':
    case 'Agent': {
      const input = taskInput.safeParse(rawInput);
      if (!input.success) return null;
      const mappedInput = {};
      if (input.data.description !== undefined) mappedInput.description = input.data.description;
      if (input.data.prompt !== undefined) mappedInput.prompt = input.data.prompt;
      if (input.data.subagent_type !== undefined) mappedInput.subagent_type = input.data.subagent_type;
      return { tool: 'task', input: mappedInput, title: input.data.description ?? 'Subagent' };
    }
    case 'AskUserQuestion': {
      const input = questionInput.safeParse(rawInput);
      if (!input.success) return null;
      const questions = input.data.questions.map((question) => ({
        question: question.question,
        header: question.header ?? '',
        options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? '' })),
        multiple: question.multiSelect === true,
      }));
      return { tool: 'question', input: { questions }, title: `Asked ${questions.length} question${questions.length === 1 ? '' : 's'}` };
    }
    case 'ExitPlanMode': {
      const input = exitPlanInput.safeParse(rawInput);
      if (!input.success) return null;
      return { tool: 'plan_exit', input: { plan: input.data.plan }, title: 'Plan' };
    }
    case 'Skill': {
      const input = skillInput.safeParse(rawInput);
      if (!input.success) return null;
      const skillName = input.data.skill ?? input.data.command ?? '';
      return { tool: 'skill', input: { name: skillName }, title: skillName };
    }
    default:
      return null;
  }
};

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const toolResultContent = z.union([
  z.string(),
  z.array(z.unknown()).transform((blocks) => blocks
    .map((block) => textBlock.safeParse(block))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data.text)
    .join('\n')),
]).catch('');

const fileResult = z.object({
  filePath: z.string(),
  type: z.string().optional(),
  content: z.string().optional(),
  structuredPatch: z.array(z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  })).optional(),
});

const ANSWERED_PREFIX = /^Your questions have been answered:/;

/**
 * The part of a Claude Edit, MultiEdit or Write result the diff needs, or
 * null for any other result. The raw result also carries whole file contents
 * (`originalFile`, and `content` after an overwrite), which history does not
 * keep.
 * @param {unknown} toolUseResult
 */
export const slimFileEditResult = (toolUseResult) => {
  const parsed = fileResult.safeParse(toolUseResult);
  if (!parsed.success) return null;
  const { filePath, type, structuredPatch, content } = parsed.data;
  const slim = { filePath };
  if (type !== undefined) slim.type = type;
  if (structuredPatch !== undefined) slim.structuredPatch = structuredPatch;
  if (type === 'create' && content !== undefined) slim.content = content;
  return slim;
};

/**
 * Output and metadata for a finished tool call.
 * @param {string} tool OpenCode tool name from mapClaudeToolUse
 * @param {unknown} content tool_result content
 * @param {unknown} toolUseResult structured result the CLI attached to the tool_result entry
 * @returns {{ output: string, metadata: Record<string, unknown> }}
 */
export const mapClaudeToolResult = (tool, content, toolUseResult) => {
  let output = toolResultContent.parse(content);
  let metadata = {};
  if (tool === 'edit' || tool === 'write') {
    const parsed = fileResult.safeParse(toolUseResult);
    const entry = parsed.success ? claudeFileEntry(parsed.data) : null;
    if (entry) metadata = fileDiffMetadata([entry]);
  }
  if (tool === 'question') {
    // The question renderer parses OpenCode's wording of the same answer.
    output = output.replace(ANSWERED_PREFIX, 'User has answered your questions:');
  }
  return { output, metadata };
};
