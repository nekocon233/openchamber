import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
import { codexFileEntry, fileDiffMetadata } from '../file-diff.js';
import { codexPartId, encodeCodexSessionId, isNativeClientUserMessageId } from '../ids.js';
import { readPromptTextBlock, type PromptTextAttachment } from '../prompt-parts.js';
import { buildReasoningPart, buildTextPart, buildToolPart } from '../records.js';
import type { NativeFilePart } from '../records.js';
import { buildSkillReadPart } from '../skill-records.js';

const jsonValueSchema = z.custom<JsonValue>(() => true);

export const codexSkillId = (turnId: string, userId: string, name: string): string => (
  `skill_${createHash('sha256').update(`${turnId}:${userId}:${name}`).digest('hex').slice(0, 24)}`
);
export const codexSkillTextHash = (text: string): string => createHash('sha256').update(text).digest('hex');

const agentMessageItem = z.object({ type: z.literal('agentMessage'), id: z.string(), text: z.string().catch('') }).passthrough();
const reasoningItem = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.string()).catch([]),
  content: z.array(z.string()).catch([]),
}).passthrough();
export const codexPlanItemSchema = z.object({ type: z.literal('plan'), id: z.string(), text: z.string().catch('') }).passthrough();
const commandItem = z.object({
  type: z.literal('commandExecution'),
  id: z.string(),
  command: z.string(),
  commandActions: z.array(z.object({ command: z.string().optional(), type: z.string().optional(), path: z.string().optional() }).passthrough()).catch([]),
  cwd: z.string().nullish(),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().nullish(),
  status: z.string().catch('completed'),
}).passthrough();
const fileChangeItem = z.object({
  type: z.literal('fileChange'),
  id: z.string(),
  status: z.string().catch('completed'),
  changes: z.array(z.object({
    path: z.string(),
    kind: z.object({ type: z.enum(['add', 'update', 'delete']), move_path: z.string().nullish() }).passthrough(),
    diff: z.string().catch(''),
  }).passthrough()).catch([]),
}).passthrough();
const mcpToolCallItem = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), jsonValueSchema).catch({}),
  result: jsonValueSchema.optional(),
  error: z.object({ message: z.string() }).passthrough().nullish(),
  status: z.string().catch('completed'),
}).passthrough();
const dynamicToolCallItem = z.object({
  type: z.literal('dynamicToolCall'),
  id: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), jsonValueSchema).catch({}),
  contentItems: z.array(jsonValueSchema).nullish(),
  success: z.boolean().nullish(),
  status: z.string().catch('completed'),
}).passthrough();
const webSearchItem = z.object({ type: z.literal('webSearch'), id: z.string(), query: z.string().catch('') }).passthrough();
const imageViewItem = z.object({ type: z.literal('imageView'), id: z.string(), path: z.string() }).passthrough();
export const codexQuestionItem = z.object({
  type: z.literal('openchamberQuestion'),
  id: z.string(),
  questions: z.array(z.object({
    id: z.string().optional(),
    question: z.string(),
    header: z.string().default(''),
    options: z.array(z.object({ label: z.string(), description: z.string().default('') })).default([]),
    multiple: z.boolean().default(false),
  })),
  answers: z.array(z.array(z.string())).optional(),
  resolution: z.enum(['pending', 'answered', 'dismissed', 'interrupted']).default('pending'),
});
const skillItem = z.object({
  type: z.literal('openchamberSkill'),
  id: z.string(),
  name: z.string(),
  path: z.string().optional(),
  source: z.enum(['attached', 'read']),
});
const collabAgentItem = z.object({
  type: z.literal('collabAgentToolCall'),
  id: z.string(),
  tool: z.string().catch('spawnAgent'),
  prompt: z.string().nullish(),
  receiverThreadIds: z.array(z.string()).catch([]),
  status: z.string().catch('completed'),
}).passthrough();

const textOfContent = z.array(z.unknown()).transform((items) => items
  .map((item) => z.object({ text: z.string() }).passthrough().safeParse(item))
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data.text)
  .join('\n')).catch('');

const displayCommand = (item: z.infer<typeof commandItem>): string => {
  const actions = item.commandActions.map((action) => action.command).filter((command): command is string => Boolean(command));
  if (actions.length > 0) return actions.join(' && ');
  const wrapped = /^\S+\s+-l?c\s+'([\s\S]*)'$/.exec(item.command);
  return wrapped?.[1] ?? item.command;
};

const FINISHED_STATUSES = new Set(['completed', 'failed', 'declined']);

export type CodexQuestionItem = z.infer<typeof codexQuestionItem>;
export type CodexSkillItem = z.infer<typeof skillItem>;
export type CodexRawItem = JsonValue | CodexQuestionItem | CodexSkillItem | undefined;

export interface CodexItemContext {
  sessionId: string;
  threadId: string;
  messageId: string;
  start: number;
  end: number | null;
}

type ToolPartResult =
  | { status: 'completed'; output: string; end: number }
  | { status: 'error'; error: string; end: number }
  | null;

export type CodexTextPart = ReturnType<typeof buildTextPart>;
export type CodexReasoningPart = ReturnType<typeof buildReasoningPart>;
export type CodexToolPart = ReturnType<typeof buildToolPart>;
export type CodexItemPart = CodexTextPart | CodexReasoningPart | CodexToolPart;

const toolResult = (status: string, output: string, end: number | null): ToolPartResult => {
  if (end === null || !FINISHED_STATUSES.has(status)) return null;
  if (status === 'completed') return { status: 'completed', output, end };
  return { status: 'error', error: output || `Command ${status}`, end };
};

export const partsForCodexItem = (rawItem: CodexRawItem, { sessionId, threadId, messageId, start, end }: CodexItemContext): CodexItemPart[] => {
  const base = { sessionID: sessionId, messageID: messageId };

  const question = codexQuestionItem.safeParse(rawItem);
  if (question.success) {
    const item = question.data;
    const answered = item.resolution === 'answered';
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'question',
      input: { questions: item.questions },
      title: 'Question',
      start,
      metadata: { questionAnswers: item.answers ?? [], questionStatus: item.resolution },
      result: answered ? { status: 'completed', output: '', end: end ?? start }
        : item.resolution !== 'pending' || end !== null
          ? { status: 'error', error: item.resolution === 'dismissed' ? 'Dismissed' : 'Interrupted', end: end ?? start }
          : null,
    })];
  }
  const skill = skillItem.safeParse(rawItem);
  if (skill.success) {
    const item = skill.data;
    const metadata = item.path
      ? { source: item.source, dir: item.path.replace(/[\\/]SKILL\.md$/i, '') }
      : { source: item.source };
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'skill',
      input: { id: item.name, name: item.name },
      title: item.name,
      start,
      metadata,
      result: { status: 'completed', output: '', end: end ?? start },
    })];
  }

  const agentMessage = agentMessageItem.safeParse(rawItem);
  if (agentMessage.success) {
    return [buildTextPart({ ...base, id: codexPartId(threadId, agentMessage.data.id), text: agentMessage.data.text, start, end })];
  }
  const reasoning = reasoningItem.safeParse(rawItem);
  if (reasoning.success) {
    const text = (reasoning.data.summary.length > 0 ? reasoning.data.summary : reasoning.data.content).join('\n\n');
    return [buildReasoningPart({ ...base, id: codexPartId(threadId, reasoning.data.id), text, start, end })];
  }
  const plan = codexPlanItemSchema.safeParse(rawItem);
  if (plan.success) {
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, plan.data.id),
      callID: plan.data.id,
      tool: 'plan_exit',
      input: { plan: plan.data.text },
      title: 'Plan',
      start,
      metadata: {},
      result: toolResult('completed', '', end),
    })];
  }
  const command = commandItem.safeParse(rawItem);
  if (command.success) {
    const item = command.data;
    const output = item.aggregatedOutput ?? '';
    const metadata = item.exitCode !== null && item.exitCode !== undefined
      ? { output, exit: item.exitCode }
      : { output };
    const shown = displayCommand(item);
    const input = item.cwd ? { command: shown, workdir: item.cwd } : { command: shown };
    const part = buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'bash',
      input,
      title: shown.split('\n')[0] ?? '',
      start,
      metadata,
      result: toolResult(item.status, output, end),
    });
    const skills = item.status === 'completed' && item.exitCode === 0 && end !== null
      ? item.commandActions.flatMap((action, index) => {
        if (action.type !== 'read' || !action.path) return [];
        const readSkill = buildSkillReadPart({ ...base, id: `${part.id}_s${index}`, filePath: action.path, cwd: item.cwd ?? '', start, end });
        return readSkill ? [readSkill] : [];
      }) : [];
    return [part, ...skills];
  }
  const fileChange = fileChangeItem.safeParse(rawItem);
  if (fileChange.success) {
    const item = fileChange.data;
    const files = item.changes.map((change) => codexFileEntry({
      path: change.path,
      kind: { type: change.kind.type, move_path: change.kind.move_path ?? null },
      diff: change.diff,
    }));
    const summary = files.map((file) => `${file.type} ${file.filePath}`).join('\n');
    const firstFile = files[0];
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'apply_patch',
      input: { files: files.map((file) => file.filePath) },
      title: files.length === 1 && firstFile ? firstFile.filePath : `${files.length} files`,
      start,
      metadata: fileDiffMetadata(files),
      result: toolResult(item.status, summary, end),
    })];
  }
  const mcp = mcpToolCallItem.safeParse(rawItem);
  if (mcp.success) {
    const item = mcp.data;
    const content = z.object({ content: z.array(z.unknown()), isError: z.boolean().optional() }).passthrough().safeParse(item.result);
    const output = item.error?.message ?? (content.success ? textOfContent.parse(content.data.content) : '');
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: `${item.server}_${item.tool}`,
      input: item.arguments,
      title: item.tool,
      start,
      metadata: { openchamberToolSource: 'mcp' },
      result: toolResult(item.error || content.data?.isError ? 'failed' : item.status, output, end),
    })];
  }
  const dynamicTool = dynamicToolCallItem.safeParse(rawItem);
  if (dynamicTool.success) {
    const item = dynamicTool.data;
    const output = textOfContent.parse(item.contentItems ?? []);
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: item.tool,
      input: item.arguments,
      title: item.tool,
      start,
      metadata: {},
      result: toolResult(item.success === false ? 'failed' : item.status, output, end),
    })];
  }
  const webSearch = webSearchItem.safeParse(rawItem);
  if (webSearch.success) {
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, webSearch.data.id),
      callID: webSearch.data.id,
      tool: 'websearch',
      input: { query: webSearch.data.query },
      title: webSearch.data.query,
      start,
      metadata: {},
      result: toolResult('completed', '', end),
    })];
  }
  const imageView = imageViewItem.safeParse(rawItem);
  if (imageView.success) {
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, imageView.data.id),
      callID: imageView.data.id,
      tool: 'read',
      input: { filePath: imageView.data.path },
      title: imageView.data.path,
      start,
      metadata: {},
      result: toolResult('completed', '', end),
    })];
  }
  const collab = collabAgentItem.safeParse(rawItem);
  if (collab.success) {
    const item = collab.data;
    const input: { description: string; prompt?: string } = item.prompt ? { description: item.tool, prompt: item.prompt } : { description: item.tool };
    const receivers: Array<string | null> = item.receiverThreadIds.length > 0 ? item.receiverThreadIds : [null];
    return receivers.map((receiverThreadId, index) => buildToolPart({
      ...base,
      id: receivers.length === 1 ? codexPartId(threadId, item.id) : `${codexPartId(threadId, item.id)}_r${index}`,
      callID: receivers.length === 1 ? item.id : `${item.id}_r${index}`,
      tool: 'task',
      input,
      title: item.tool,
      start,
      metadata: receiverThreadId === null ? {} : { sessionId: encodeCodexSessionId(receiverThreadId) },
      result: toolResult(item.status, '', end),
    }));
  }
  return [];
};

const contextCompactionItem = z.object({ type: z.literal('contextCompaction'), id: z.string() }).passthrough();

export const codexCompactionItemId = (rawItem: CodexRawItem): string | null => contextCompactionItem.safeParse(rawItem).data?.id ?? null;

const userMessageItem = z.object({
  type: z.literal('userMessage'),
  id: z.string(),
  clientId: z.string().nullish(),
  content: z.array(z.unknown()).catch([]),
}).passthrough();
const textInput = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageInput = z.object({ type: z.enum(['image', 'localImage']), url: z.string().optional(), path: z.string().optional() }).passthrough();
const skillInput = z.object({ type: z.literal('skill'), name: z.string(), path: z.string() });

export interface ParsedCodexUserSkill {
  type: 'skill';
  name: string;
  path: string;
}

export interface ParsedCodexUserMessage {
  id: string;
  clientId: string | null;
  texts: string[];
  files: Array<PromptTextAttachment | Pick<NativeFilePart, 'mime' | 'url' | 'filename'>>;
  skills: ParsedCodexUserSkill[];
}

export const parseCodexUserMessageItem = (rawItem: CodexRawItem): ParsedCodexUserMessage | null => {
  const parsed = userMessageItem.safeParse(rawItem);
  if (!parsed.success) return null;
  const texts: string[] = [];
  const files: ParsedCodexUserMessage['files'] = [];
  const skills: ParsedCodexUserSkill[] = [];
  const allowLegacy = isNativeClientUserMessageId(parsed.data.clientId ?? '');
  for (const entry of parsed.data.content) {
    const skill = skillInput.safeParse(entry);
    if (skill.success) { skills.push(skill.data); continue; }
    const text = textInput.safeParse(entry);
    if (text.success) {
      const part = readPromptTextBlock(text.data.text, allowLegacy);
      if (part?.type === 'text') texts.push(part.text);
      else if (part) files.push(part);
      continue;
    }
    const image = imageInput.safeParse(entry);
    if (image.success) {
      const source = image.data.url ?? image.data.path ?? '';
      const inline = source.startsWith('data:');
      files.push({
        mime: 'image/*',
        url: inline ? source : '',
        filename: inline ? 'image' : source.split('/').at(-1) || 'image',
      });
    }
  }
  return { id: parsed.data.id, clientId: parsed.data.clientId ?? null, texts, files, skills };
};
