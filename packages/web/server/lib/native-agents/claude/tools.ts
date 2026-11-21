import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../shared/json-values.js';
import { claudeBashFileEntry, claudeFileEntry, fileDiffMetadata } from '../file-diff.js';
import type { ClaudeHunk } from '../file-diff.js';

const opaqueJson = z.custom<JsonValue>(() => true);

const bashInput = z.object({ command: z.string(), description: z.string().optional(), timeout: z.number().optional() }).catchall(opaqueJson.optional());
const readInput = z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }).catchall(opaqueJson.optional());
const writeInput = z.object({ file_path: z.string(), content: z.string() }).catchall(opaqueJson.optional());
const editInput = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
}).catchall(opaqueJson.optional());
const multiEditInput = z.object({ file_path: z.string(), edits: z.array(opaqueJson) }).catchall(opaqueJson.optional());
const globInput = z.object({ pattern: z.string(), path: z.string().optional() }).catchall(opaqueJson.optional());
const grepInput = z.object({ pattern: z.string(), path: z.string().optional() }).catchall(opaqueJson.optional());
const webFetchInput = z.object({ url: z.string(), prompt: z.string().optional() }).catchall(opaqueJson.optional());
const webSearchInput = z.object({ query: z.string() }).catchall(opaqueJson.optional());
const todoWriteInput = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.string(), priority: z.string().optional() }).catchall(opaqueJson.optional())),
}).catchall(opaqueJson.optional());
const taskInput = z.object({
  description: z.string().optional(),
  prompt: z.string().optional(),
  subagent_type: z.string().optional(),
}).catchall(opaqueJson.optional());
const questionInput = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string().optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() }).catchall(opaqueJson.optional())).optional(),
  }).catchall(opaqueJson.optional())),
}).catchall(opaqueJson.optional());
const questionResult = questionInput.extend({
  answers: z.record(z.string(), z.string()),
  response: z.string().optional(),
});
const exitPlanInput = z.object({ plan: z.string().optional() }).catchall(opaqueJson.optional());
const skillInput = z.object({ skill: z.string().optional(), command: z.string().optional() }).catchall(opaqueJson.optional());
const anyInput = z.record(z.string(), opaqueJson.optional());

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

const TITLE_FIELDS = ['subject', 'description', 'query', 'pattern', 'url', 'file_path', 'path', 'name', 'command', 'prompt', 'title'] as const;
const TITLE_MAX_LENGTH = 120;
const titleText = z.string().trim().min(1);

export type MappedClaudeToolUse = {
  tool: string;
  input: JsonObject;
  title: string;
  metadata?: { openchamberToolSource: 'mcp' };
};

export type MappedClaudeToolResult = {
  output: string;
  metadata: JsonObject;
};

type RecordedFileChanges = {
  withoutDiff: string[];
  unnamed: number;
  unavailable?: true;
  shared?: true;
};

const titleOf = (input: JsonObject): string => {
  for (const field of TITLE_FIELDS) {
    const value = titleText.safeParse(input[field]);
    if (value.success) return (value.data.split('\n')[0] ?? '').slice(0, TITLE_MAX_LENGTH);
  }
  return '';
};

export const mapClaudeToolUse = (name: string, rawInput?: JsonValue): MappedClaudeToolUse => {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp?.[1] && mcp[2]) {
    const input: JsonObject = anyInput.catch({}).parse(rawInput);
    return {
      tool: `${mcp[1]}_${mcp[2]}`,
      input,
      title: titleOf(input),
      metadata: { openchamberToolSource: 'mcp' },
    };
  }
  const mapped = mapKnownTool(name, rawInput);
  if (mapped) return mapped;
  const input: JsonObject = anyInput.catch({}).parse(rawInput);
  return { tool: name, input, title: titleOf(input) };
};

const mapKnownTool = (name: string, rawInput?: JsonValue): MappedClaudeToolUse | null => {
  switch (name) {
    case 'Bash': {
      const input = bashInput.safeParse(rawInput);
      if (!input.success) return null;
      const { command, description } = input.data;
      return {
        tool: 'bash',
        input: description === undefined ? { command } : { command, description },
        title: description ?? command.split('\n')[0] ?? '',
      };
    }
    case 'Read': {
      const input = readInput.safeParse(rawInput);
      if (!input.success) return null;
      const { file_path: filePath, offset, limit } = input.data;
      const mappedInput: JsonObject = { filePath };
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
      const mappedInput: JsonObject = { filePath, oldString, newString };
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
      const mappedInput: JsonObject = {};
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
      return { tool: 'plan_exit', input: input.data.plan === undefined ? {} : { plan: input.data.plan }, title: 'Plan' };
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

const hunk = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

const fileResult = z.object({
  filePath: z.string(),
  type: z.string().optional(),
  content: z.string().optional(),
  structuredPatch: z.array(hunk).optional(),
});

const bashEditDiff = z.object({
  files: z.array(z.object({
    filePath: z.string().min(1),
    hunks: z.array(hunk),
    created: z.literal(true).optional(),
    deleted: z.literal(true).optional(),
  })),
  moreFiles: z.number().int().nonnegative(),
  changedFiles: z.array(z.string().min(1)).optional(),
  unavailable: z.literal(true).optional(),
  skipped: z.literal(true).optional(),
  shared: z.literal(true).optional(),
});

const bashResult = z.object({ bashEditDiff });

type BashEditDiffRecord = z.infer<typeof bashEditDiff>;

const recordsAChange = (record: BashEditDiffRecord): boolean => record.skipped !== true
  && (record.files.length > 0 || record.moreFiles > 0 || (record.changedFiles?.length ?? 0) > 0);

const bashFileChanges = (record: BashEditDiffRecord): JsonObject | null => {
  if (!recordsAChange(record)) return null;
  const files = record.files.map(claudeBashFileEntry).filter((entry) => entry !== null);
  const shown = new Set(files.map((file) => file.filePath));
  const named = new Set([...record.files.map((file) => file.filePath), ...(record.changedFiles ?? [])]);
  const recordedFileChanges: RecordedFileChanges = {
    withoutDiff: [...named].filter((filePath) => !shown.has(filePath)),
    unnamed: Math.max(0, record.files.length + record.moreFiles - named.size),
  };
  if (record.unavailable) recordedFileChanges.unavailable = true;
  if (record.shared) recordedFileChanges.shared = true;
  const metadata: JsonObject = files.length > 0 ? { ...fileDiffMetadata(files) } : {};
  metadata.recordedFileChanges = recordedFileChanges;
  return metadata;
};

const ANSWERED_PREFIX = /^Your questions have been answered:/;

export type SlimFileToolResult = {
  filePath: string;
  type?: string;
  structuredPatch?: ClaudeHunk[];
  content?: string;
};

export type SlimClaudeToolResult =
  | { questions: z.infer<typeof questionInput>['questions']; answers: Record<string, string>; response: string | undefined }
  | { bashEditDiff: BashEditDiffRecord }
  | SlimFileToolResult;

export const slimToolResult = (toolUseResult?: JsonValue): SlimClaudeToolResult | null => {
  const question = questionResult.safeParse(toolUseResult);
  if (question.success) return { questions: question.data.questions, answers: question.data.answers, response: question.data.response };
  const command = bashResult.safeParse(toolUseResult);
  if (command.success) return recordsAChange(command.data.bashEditDiff) ? { bashEditDiff: command.data.bashEditDiff } : null;
  const parsed = fileResult.safeParse(toolUseResult);
  if (!parsed.success) return null;
  const { filePath, type, structuredPatch, content } = parsed.data;
  const slim: SlimFileToolResult = { filePath };
  if (type !== undefined) slim.type = type;
  if (structuredPatch !== undefined) slim.structuredPatch = structuredPatch;
  if (type === 'create' && content !== undefined) slim.content = content;
  return slim;
};

export const mapClaudeToolResult = (tool: string, content?: JsonValue, toolUseResult?: JsonValue): MappedClaudeToolResult => {
  let output = toolResultContent.parse(content);
  let metadata: JsonObject = {};
  if (tool === 'edit' || tool === 'write') {
    const parsed = fileResult.safeParse(toolUseResult);
    const entry = parsed.success ? claudeFileEntry(parsed.data) : null;
    if (entry) metadata = { ...fileDiffMetadata([entry]) };
  }
  if (tool === 'bash') {
    const parsed = bashResult.safeParse(toolUseResult);
    const changes = parsed.success ? bashFileChanges(parsed.data.bashEditDiff) : null;
    if (changes) metadata = changes;
  }
  if (tool === 'question') {
    const parsed = questionResult.safeParse(toolUseResult);
    if (parsed.success) {
      metadata.questionAnswers = parsed.data.questions.map((question) => {
        const value = parsed.data.answers[question.question];
        return value === undefined ? [] : [value];
      });
      metadata.questionStatus = Object.keys(parsed.data.answers).length > 0 || parsed.data.response ? 'answered' : 'dismissed';
      if (parsed.data.response !== undefined) metadata.questionResponse = parsed.data.response;
    }
    output = output.replace(ANSWERED_PREFIX, 'User has answered your questions:');
  }
  return { output, metadata };
};
