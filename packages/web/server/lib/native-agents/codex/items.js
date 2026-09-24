// Maps Codex thread items onto OpenCode parts. Items arrive from the
// app-server (history pages and live notifications), so each type is parsed at
// this boundary; unknown item types are left out rather than guessed.

import { z } from 'zod';

import { codexFileEntry, fileDiffMetadata } from '../file-diff.js';
import { codexPartId, encodeCodexSessionId } from '../ids.js';
import { isInstructionsBlock } from '../prompt-parts.js';
import { buildReasoningPart, buildTextPart, buildToolPart } from '../records.js';

const loose = (fields) => z.object(fields).passthrough();

const agentMessageItem = loose({ type: z.literal('agentMessage'), id: z.string(), text: z.string().catch('') });
const reasoningItem = loose({
  type: z.literal('reasoning'),
  id: z.string(),
  summary: z.array(z.string()).catch([]),
  content: z.array(z.string()).catch([]),
});
const planItem = loose({ type: z.literal('plan'), id: z.string(), text: z.string().catch('') });
const commandItem = loose({
  type: z.literal('commandExecution'),
  id: z.string(),
  command: z.string(),
  commandActions: z.array(loose({ command: z.string().optional() })).catch([]),
  cwd: z.string().nullish(),
  aggregatedOutput: z.string().nullish(),
  exitCode: z.number().nullish(),
  status: z.string().catch('completed'),
});
const fileChangeItem = loose({
  type: z.literal('fileChange'),
  id: z.string(),
  status: z.string().catch('completed'),
  changes: z.array(loose({
    path: z.string(),
    kind: loose({ type: z.enum(['add', 'update', 'delete']), move_path: z.string().nullish() }),
    diff: z.string().catch(''),
  })).catch([]),
});
const mcpToolCallItem = loose({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).catch({}),
  result: z.unknown().optional(),
  error: loose({ message: z.string() }).nullish(),
  status: z.string().catch('completed'),
});
const dynamicToolCallItem = loose({
  type: z.literal('dynamicToolCall'),
  id: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).catch({}),
  contentItems: z.array(z.unknown()).nullish(),
  success: z.boolean().nullish(),
  status: z.string().catch('completed'),
});
const webSearchItem = loose({ type: z.literal('webSearch'), id: z.string(), query: z.string().catch('') });
const imageViewItem = loose({ type: z.literal('imageView'), id: z.string(), path: z.string() });
const collabAgentItem = loose({
  type: z.literal('collabAgentToolCall'),
  id: z.string(),
  tool: z.string().catch('spawnAgent'),
  prompt: z.string().nullish(),
  receiverThreadIds: z.array(z.string()).catch([]),
  status: z.string().catch('completed'),
});

const textOfContent = z.array(z.unknown()).transform((items) => items
  .map((item) => loose({ text: z.string() }).safeParse(item))
  .filter((parsed) => parsed.success)
  .map((parsed) => parsed.data.text)
  .join('\n')).catch('');

// commandExecution wraps the command in a login shell (`/bin/zsh -lc '...'`);
// the parsed actions carry what the model asked to run.
const displayCommand = (item) => {
  const actions = item.commandActions.map((action) => action.command).filter((command) => command);
  if (actions.length > 0) return actions.join(' && ');
  const wrapped = /^\S+\s+-l?c\s+'([\s\S]*)'$/.exec(item.command);
  return wrapped ? wrapped[1] : item.command;
};

const FINISHED_STATUSES = new Set(['completed', 'failed', 'declined']);

/**
 * @typedef {object} ItemContext
 * @property {string} sessionId OpenChamber session id
 * @property {string} threadId
 * @property {string} messageId assistant message the part belongs to
 * @property {number} start
 * @property {number | null} end null while the item is still running
 */

const toolResult = (status, output, end) => {
  if (end === null || !FINISHED_STATUSES.has(status)) return null;
  if (status === 'completed') return { status: 'completed', output, end };
  return { status: 'error', error: output || `Command ${status}`, end };
};

/**
 * Parts for one Codex item: usually one, several for a multi-receiver
 * collab call, none for items the chat does not show.
 * @param {unknown} rawItem
 * @param {ItemContext} context
 */
export const partsForCodexItem = (rawItem, { sessionId, threadId, messageId, start, end }) => {
  const base = { sessionID: sessionId, messageID: messageId };

  const agentMessage = agentMessageItem.safeParse(rawItem);
  if (agentMessage.success) {
    return [buildTextPart({ ...base, id: codexPartId(threadId, agentMessage.data.id), text: agentMessage.data.text, start, end })];
  }
  const reasoning = reasoningItem.safeParse(rawItem);
  if (reasoning.success) {
    const text = (reasoning.data.summary.length > 0 ? reasoning.data.summary : reasoning.data.content).join('\n\n');
    return [buildReasoningPart({ ...base, id: codexPartId(threadId, reasoning.data.id), text, start, end })];
  }
  const plan = planItem.safeParse(rawItem);
  if (plan.success) {
    return [buildTextPart({ ...base, id: codexPartId(threadId, plan.data.id), text: plan.data.text, start, end })];
  }
  const command = commandItem.safeParse(rawItem);
  if (command.success) {
    const item = command.data;
    const output = item.aggregatedOutput ?? '';
    const metadata = { output };
    if (item.exitCode !== null && item.exitCode !== undefined) metadata.exit = item.exitCode;
    const input = item.cwd ? { command: displayCommand(item), workdir: item.cwd } : { command: displayCommand(item) };
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'bash',
      input,
      title: displayCommand(item).split('\n')[0],
      start,
      metadata,
      result: toolResult(item.status, output, end),
    })];
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
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: 'apply_patch',
      input: { files: files.map((file) => file.filePath) },
      title: files.length === 1 ? files[0].filePath : `${files.length} files`,
      start,
      metadata: fileDiffMetadata(files),
      result: toolResult(item.status, summary, end),
    })];
  }
  const mcp = mcpToolCallItem.safeParse(rawItem);
  if (mcp.success) {
    const item = mcp.data;
    const content = loose({ content: z.array(z.unknown()) }).safeParse(item.result);
    const output = item.error?.message ?? (content.success ? textOfContent.parse(content.data.content) : '');
    return [buildToolPart({
      ...base,
      id: codexPartId(threadId, item.id),
      callID: item.id,
      tool: `${item.server}_${item.tool}`,
      input: item.arguments,
      title: item.tool,
      start,
      metadata: {},
      result: toolResult(item.error ? 'failed' : item.status, output, end),
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
    const input = item.prompt ? { description: item.tool, prompt: item.prompt } : { description: item.tool };
    const receivers = item.receiverThreadIds.length > 0 ? item.receiverThreadIds : [null];
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

const contextCompactionItem = loose({ type: z.literal('contextCompaction'), id: z.string() });

/** The id of a context compaction item, or null for any other item. */
export const codexCompactionItemId = (rawItem) => contextCompactionItem.safeParse(rawItem).data?.id ?? null;

const userMessageItem = loose({
  type: z.literal('userMessage'),
  id: z.string(),
  clientId: z.string().nullish(),
  content: z.array(z.unknown()).catch([]),
});
const textInput = loose({ type: z.literal('text'), text: z.string() });
const imageInput = loose({ type: z.enum(['image', 'localImage']), url: z.string().optional(), path: z.string().optional() });

/**
 * @returns {{ id: string, clientId: string | null, texts: string[], images: Array<{ url: string, filename: string }> } | null}
 */
export const parseCodexUserMessageItem = (rawItem) => {
  const parsed = userMessageItem.safeParse(rawItem);
  if (!parsed.success) return null;
  const texts = [];
  const images = [];
  for (const entry of parsed.data.content) {
    const text = textInput.safeParse(entry);
    if (text.success) {
      // A feature's instructions reach the model, not the conversation.
      if (!isInstructionsBlock(text.data.text)) texts.push(text.data.text);
      continue;
    }
    const image = imageInput.safeParse(entry);
    if (image.success) {
      const source = image.data.url ?? image.data.path ?? '';
      images.push({
        url: source.startsWith('data:') ? source : '',
        filename: source.split('/').at(-1) || 'image',
      });
    }
  }
  return { id: parsed.data.id, clientId: parsed.data.clientId ?? null, texts, images };
};

