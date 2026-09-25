// Projects a Claude Code conversation into OpenCode-shaped records.
//
// The same projection consumes history entries (getSessionMessages /
// getSubagentMessages) and the complete `assistant` / `user` frames of a live
// query: both carry one content block per assistant entry, keyed by the API
// message id, with the same uuid and timestamp. Records produced either way
// therefore have the same ids.
//
// Live mode adds what only a running query knows. Stream events open the
// assistant message and its text and reasoning parts before their blocks are
// complete, and hand back text deltas. The message completes on
// `message_stop`, not on its first block, because tools start running while
// later blocks of the same message still stream in.
//
// Mapping:
// - a human user entry becomes a user message (ncl_u_<entry uuid>);
// - assistant entries sharing an API message id become one assistant message
//   whose parts follow content-block order (reasoning, text, tool);
// - tool_result blocks finish the tool part of the matching tool_use;
// - a compact boundary becomes a compaction user message, and the compact
//   summary an assistant `summary` message answering it;
// - a slash command shows as typed; `/compact` shows as its compaction;
// - the output of local commands and other meta entries is not shown.
//
// Message times are clamped to be non-decreasing in chain order: the UI orders
// messages by time.created, and a compaction keeps preserved messages whose
// timestamps predate the boundary.

import { z } from 'zod';

import {
  blockPartId,
  claudeAssistantMessageId,
  claudeUserMessageId,
  NATIVE_PROVIDER_CLAUDE,
  toolPartId,
  userFilePartId,
  userTextPartId,
} from '../ids.js';
import {
  buildAssistantMessage,
  buildCompactionPart,
  buildFilePart,
  buildReasoningPart,
  buildTextPart,
  buildToolPart,
  buildUserMessage,
  EMPTY_TOKENS,
  stoppedError,
  unknownError,
} from '../records.js';
import { mapClaudeToolResult, mapClaudeToolUse } from './tools.js';
import { isInstructionsBlock } from '../prompt-parts.js';

const DEFAULT_AGENT = 'build';
// Inline image data beyond this is replaced by a note; the transcript keeps it.
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

const entrySchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  timestamp: z.string().optional(),
  message: z.unknown().optional(),
  isCompactSummary: z.boolean().optional(),
  // The CLI's own notes to the model, such as its nudge to go on after a
  // reply hit the output limit. The SDK's history read marks them `is_meta`,
  // raw transcript lines `isMeta`, and live frames `isSynthetic`.
  is_meta: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isSynthetic: z.boolean().optional(),
  isCompletedLocalCommand: z.boolean().optional(),
  tool_use_result: z.unknown().optional(),
  origin: z.object({ kind: z.string() }).passthrough().optional().catch(undefined),
  // The kind of a system entry. Live frames and raw transcript lines carry
  // it; the SDK's history read keeps only `type`.
  subtype: z.string().optional(),
  // What started a compaction: `manual` for /compact, `auto` when the context
  // filled. Transcripts name it in camel case, live frames in snake case; the
  // SDK's history read drops it.
  compactMetadata: z.object({ trigger: z.string() }).passthrough().optional().catch(undefined),
  compact_metadata: z.object({ trigger: z.string() }).passthrough().optional().catch(undefined),
}).passthrough();

const usageSchema = z.object({
  input_tokens: z.number().catch(0),
  output_tokens: z.number().catch(0),
  cache_read_input_tokens: z.number().nullish().transform((value) => value ?? 0),
  cache_creation_input_tokens: z.number().nullish().transform((value) => value ?? 0),
}).passthrough();

const assistantMessageSchema = z.object({
  id: z.string(),
  model: z.string().catch(''),
  content: z.array(z.unknown()),
  stop_reason: z.string().nullish(),
  usage: usageSchema.nullish(),
}).passthrough();

// User content is either plain text or a list of content blocks.
const userMessageSchema = z.object({
  content: z.union([
    z.string().transform((text) => ({ kind: 'text', text })),
    z.array(z.unknown()).transform((blocks) => ({ kind: 'blocks', blocks })),
  ]),
}).passthrough();

const thinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough();
const redactedThinkingBlock = z.object({ type: z.literal('redacted_thinking') }).passthrough();
const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).catch({}),
}).passthrough();
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
}).passthrough();
const imageBlock = z.object({
  type: z.literal('image'),
  source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }).passthrough(),
}).passthrough();
const documentBlock = z.object({
  type: z.literal('document'),
  source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }).passthrough(),
  title: z.string().optional(),
}).passthrough();

const streamFrameSchema = z.object({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullish(),
  event: z.object({ type: z.string() }).passthrough(),
}).passthrough();
const contentBlockStartSchema = z.object({
  index: z.number(),
  content_block: z.object({ type: z.string() }).passthrough(),
}).passthrough();
const contentBlockDeltaSchema = z.object({
  index: z.number(),
  delta: z.union([
    z.object({ type: z.literal('text_delta'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('thinking_delta'), thinking: z.string() }).passthrough(),
    z.object({ type: z.string() }).passthrough(),
  ]),
}).passthrough();
const messageDeltaSchema = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }).passthrough(),
  usage: z.object({ output_tokens: z.number() }).passthrough().nullish(),
}).passthrough();

// Claude Code records a stop as a user entry holding one of these fixed texts.
// The stop already shows on the assistant message it cut short.
const INTERRUPT_MARKERS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

// How Claude Code records a slash command it ran: the name and arguments in
// tags, under the uuid of the prompt that sent it and marked as a completed
// local command. The CLI writes the same tags unmarked for commands it runs
// itself, such as the `/model` a model switch between turns records.
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMPACT_COMMAND = '/compact';
// What a local command printed. Its effect shows elsewhere, marked or not.
const LOCAL_COMMAND_OUTPUT = /^\s*<local-command-std(?:out|err)>/;

/** The command as the user typed it, or null when the text records no command. */
const typedCommandOf = (text) => {
  if (!text.trimStart().startsWith('<command-')) return null;
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
  return args ? `${name} ${args}` : name;
};

const FINISH_BY_STOP_REASON = new Map([
  ['end_turn', 'stop'],
  ['stop_sequence', 'stop'],
  ['tool_use', 'tool-calls'],
  ['max_tokens', 'length'],
  ['refusal', 'content-filter'],
]);

/** API model ids carry a release date suffix the catalog does not. */
const normalizeClaudeModelId = (model) => model.replace(/-\d{8}$/, '');

const tokensFromUsage = (usage) => {
  if (!usage) return EMPTY_TOKENS;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  return { total: input + output + read + write, input, output, reasoning: 0, cache: { read, write } };
};

const byteLengthOfBase64 = (data) => Math.floor((data.length * 3) / 4);

/**
 * @param {object} options
 * @param {string} options.sessionId OpenChamber id of the projected session
 * @param {string} options.cwd
 * @param {(userMessageId: string) => ({ modelID: string, variant?: string, agent: string } | null)} [options.sendRecordFor]
 *   What OpenChamber sent for a user message it created.
 * @param {(toolUseId: string) => (string | null)} [options.childSessionIdForToolUse]
 *   Child session id for an Agent/Task tool call, when its subagent is known.
 * @param {boolean} [options.live] projecting a running query rather than history
 * @param {() => number} [options.now] clock for stream events, which carry no timestamp
 */
export const createClaudeProjection = ({
  sessionId,
  cwd,
  sendRecordFor = () => null,
  childSessionIdForToolUse = () => null,
  live = false,
  now = Date.now,
}) => {
  const records = [];
  const recordById = new Map();
  const toolParts = new Map();
  let currentUser = null;
  let currentAssistant = null;
  let lastCreated = 0;
  let lastEntryTime = 0;
  // A history system entry that is a compaction boundary only if the compact
  // summary comes right after it.
  /** @type {{ uuid: string, timestamp: string | undefined, trigger: string | null } | null} */
  let pendingBoundary = null;

  const monotonicTime = (timestamp) => {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    const value = Number.isFinite(parsed) ? parsed : lastEntryTime;
    lastEntryTime = Math.max(lastEntryTime, value);
    return value;
  };

  const liveTime = () => {
    lastEntryTime = Math.max(lastEntryTime, now());
    return lastEntryTime;
  };

  const createdAfterPrevious = (time) => {
    lastCreated = Math.max(lastCreated, time);
    return lastCreated;
  };

  const addRecord = (info) => {
    const record = { info, parts: [] };
    records.push(record);
    recordById.set(info.id, record);
    return record;
  };

  const upsertPart = (record, part) => {
    const index = record.parts.findIndex((existing) => existing.id === part.id);
    if (index === -1) record.parts.push(part);
    else record.parts[index] = part;
    return part;
  };

  const startUserMessage = (messageId, time) => {
    const sent = sendRecordFor(messageId);
    const info = buildUserMessage({
      id: messageId,
      sessionID: sessionId,
      created: createdAfterPrevious(time),
      agent: sent?.agent ?? DEFAULT_AGENT,
      model: sent?.variant === undefined
        ? { providerID: NATIVE_PROVIDER_CLAUDE, modelID: sent?.modelID ?? '' }
        : { providerID: NATIVE_PROVIDER_CLAUDE, modelID: sent.modelID, variant: sent.variant },
    });
    const record = addRecord(info);
    currentUser = record;
    currentAssistant = null;
    return record;
  };

  // An assistant message needs a parent user message to be rendered.
  const ensureUserParent = (time, anchorId) => {
    if (currentUser) return currentUser;
    const record = startUserMessage(`${anchorId}_u`, time);
    upsertPart(record, buildTextPart({
      id: userTextPartId(record.info.id, 0),
      sessionID: sessionId,
      messageID: record.info.id,
      text: '',
      start: time,
      end: time,
      synthetic: true,
    }));
    return record;
  };

  const applyUserContent = (record, content, time) => {
    if (content.kind === 'text') {
      upsertPart(record, buildTextPart({
        id: userTextPartId(record.info.id, 0),
        sessionID: sessionId,
        messageID: record.info.id,
        text: content.text,
        start: time,
        end: time,
      }));
      return;
    }
    let textIndex = 0;
    let fileIndex = 0;
    for (const block of content.blocks) {
      const text = textBlock.safeParse(block);
      if (text.success && isInstructionsBlock(text.data.text)) continue;
      if (text.success) {
        upsertPart(record, buildTextPart({
          id: userTextPartId(record.info.id, textIndex),
          sessionID: sessionId,
          messageID: record.info.id,
          text: text.data.text,
          start: time,
          end: time,
        }));
        textIndex += 1;
        continue;
      }
      const media = imageBlock.safeParse(block).data ?? documentBlock.safeParse(block).data;
      if (!media) continue;
      const tooLarge = byteLengthOfBase64(media.source.data) > MAX_INLINE_IMAGE_BYTES;
      upsertPart(record, buildFilePart({
        id: userFilePartId(record.info.id, fileIndex),
        sessionID: sessionId,
        messageID: record.info.id,
        mime: media.source.media_type,
        url: tooLarge ? '' : `data:${media.source.media_type};base64,${media.source.data}`,
        filename: media.type === 'document' ? (media.title ?? 'document') : `image-${fileIndex + 1}`,
      }));
      fileIndex += 1;
    }
  };

  const finishToolPart = (block, toolUseResult, time) => {
    const entry = toolParts.get(block.tool_use_id);
    if (!entry) return null;
    const { record, part } = entry;
    const { output, metadata } = mapClaudeToolResult(part.tool, block.content, toolUseResult);
    const state = part.state;
    const finished = buildToolPart({
      id: part.id,
      sessionID: sessionId,
      messageID: part.messageID,
      callID: part.callID,
      tool: part.tool,
      input: state.input,
      title: state.title ?? part.tool,
      start: state.time.start,
      metadata: { ...state.metadata, ...metadata },
      result: block.is_error === true
        ? { status: 'error', error: output || 'Tool failed', end: time }
        : { status: 'completed', output, end: time },
    });
    toolParts.delete(block.tool_use_id);
    return { record, part: upsertPart(record, finished) };
  };

  const applyUserEntry = (entry, changed) => {
    const time = monotonicTime(entry.timestamp);
    const message = userMessageSchema.safeParse(entry.message);
    if (!message.success) return;
    const content = message.data.content;

    if (entry.isCompactSummary === true) {
      const boundary = currentUser;
      if (!boundary) return;
      const summary = addRecord(buildAssistantMessage({
        id: `${boundary.info.id}_summary`,
        sessionID: sessionId,
        parentID: boundary.info.id,
        created: createdAfterPrevious(time),
        completed: time,
        providerID: NATIVE_PROVIDER_CLAUDE,
        modelID: '',
        agent: DEFAULT_AGENT,
        cwd,
        tokens: EMPTY_TOKENS,
        finish: 'stop',
        summary: true,
      }));
      const text = content.kind === 'text'
        ? content.text
        : content.blocks.map((block) => textBlock.safeParse(block).data?.text ?? '').join('\n');
      upsertPart(summary, buildTextPart({
        id: blockPartId(summary.info.id, 0),
        sessionID: sessionId,
        messageID: summary.info.id,
        text,
        start: time,
        end: time,
      }));
      changed.push(summary.info.id);
      return;
    }

    if (content.kind === 'blocks') {
      const results = content.blocks.map((block) => toolResultBlock.safeParse(block)).filter((parsed) => parsed.success);
      if (results.length > 0) {
        for (const result of results) {
          const finished = finishToolPart(result.data, entry.tool_use_result, time);
          if (finished) changed.push(finished.record.info.id);
        }
        return;
      }
    }

    if (entry.is_meta === true || entry.isMeta === true || entry.isSynthetic === true) return;
    // The CLI tells the model a background subagent finished with a user entry
    // of XML. The subagent's row and the reply that follows already show it.
    if (entry.origin?.kind === 'task-notification') return;
    const soleText = content.kind === 'text'
      ? content.text
      : content.blocks.length === 1 ? textBlock.safeParse(content.blocks[0]).data?.text : undefined;
    const command = soleText === undefined ? null : typedCommandOf(soleText);
    if (command !== null) {
      if (entry.isCompletedLocalCommand !== true) return;
      if (command.split(' ')[0] === COMPACT_COMMAND) return;
      const record = startUserMessage(claudeUserMessageId(entry.uuid), time);
      applyUserContent(record, { kind: 'text', text: command }, time);
      changed.push(record.info.id);
      return;
    }
    if (entry.isCompletedLocalCommand === true) return;
    if (soleText !== undefined && (INTERRUPT_MARKERS.has(soleText.trim()) || LOCAL_COMMAND_OUTPUT.test(soleText))) return;

    const record = startUserMessage(claudeUserMessageId(entry.uuid), time);
    applyUserContent(record, content, time);
    changed.push(record.info.id);
  };

  // The assistant message of an API message id, created on first sight.
  const ensureAssistant = (message, time) => {
    if (currentAssistant?.apiMessageId === message.id) return currentAssistant;
    const messageId = claudeAssistantMessageId(sessionId, message.id);
    const parent = ensureUserParent(time, messageId);
    const sent = sendRecordFor(parent.info.id);
    const record = recordById.get(messageId) ?? addRecord(buildAssistantMessage({
      id: messageId,
      sessionID: sessionId,
      parentID: parent.info.id,
      created: createdAfterPrevious(time),
      completed: null,
      providerID: NATIVE_PROVIDER_CLAUDE,
      modelID: normalizeClaudeModelId(message.model),
      agent: sent?.agent ?? DEFAULT_AGENT,
      cwd,
      tokens: EMPTY_TOKENS,
      variant: sent?.variant ?? null,
    }));
    currentAssistant = { record, apiMessageId: message.id, nextBlockIndex: 0 };
    return currentAssistant;
  };

  // A block that streamed keeps the time its stream started.
  const startOf = (record, partId, time) => record.parts.find((part) => part.id === partId)?.time?.start ?? time;

  const applyAssistantEntry = (entry, changed) => {
    const time = monotonicTime(entry.timestamp);
    const parsed = assistantMessageSchema.safeParse(entry.message);
    if (!parsed.success) return;
    const message = parsed.data;
    const assistant = ensureAssistant(message, time);

    const { record } = assistant;
    for (const block of message.content) {
      const index = assistant.nextBlockIndex;
      assistant.nextBlockIndex += 1;
      const partId = blockPartId(record.info.id, index);
      const thinking = thinkingBlock.safeParse(block);
      if (thinking.success) {
        upsertPart(record, buildReasoningPart({
          id: partId,
          sessionID: sessionId,
          messageID: record.info.id,
          text: thinking.data.thinking,
          start: startOf(record, partId, time),
          end: time,
        }));
        continue;
      }
      if (redactedThinkingBlock.safeParse(block).success) continue;
      const text = textBlock.safeParse(block);
      if (text.success) {
        upsertPart(record, buildTextPart({
          id: partId,
          sessionID: sessionId,
          messageID: record.info.id,
          text: text.data.text,
          start: startOf(record, partId, time),
          end: time,
        }));
        continue;
      }
      const toolUse = toolUseBlock.safeParse(block);
      if (toolUse.success) {
        const mapped = mapClaudeToolUse(toolUse.data.name, toolUse.data.input);
        const childSessionId = mapped.tool === 'task' ? childSessionIdForToolUse(toolUse.data.id) : null;
        const part = buildToolPart({
          id: toolPartId(record.info.id, toolUse.data.id),
          sessionID: sessionId,
          messageID: record.info.id,
          callID: toolUse.data.id,
          tool: mapped.tool,
          input: mapped.input,
          title: mapped.title,
          start: time,
          metadata: childSessionId === null ? {} : { sessionId: childSessionId },
          result: null,
        });
        upsertPart(record, part);
        toolParts.set(toolUse.data.id, { record, part });
      }
    }

    const info = record.info;
    info.tokens = tokensFromUsage(message.usage);
    if (message.model) info.modelID = normalizeClaudeModelId(message.model);
    if (!live) {
      info.time = { created: info.time.created, completed: time };
      const finish = message.stop_reason ? FINISH_BY_STOP_REASON.get(message.stop_reason) ?? 'other' : null;
      if (finish !== null) info.finish = finish;
    }
    changed.push(info.id);
  };

  const streamedPart = (index) => (currentAssistant
    ? currentAssistant.record.parts.find((part) => part.id === blockPartId(currentAssistant.record.info.id, index)) ?? null
    : null);

  const applyStreamEvent = (event, time) => {
    const none = { changed: [], delta: null };
    if (event.type === 'message_start') {
      const message = assistantMessageSchema.safeParse(event.message);
      if (!message.success) return none;
      const { record } = ensureAssistant(message.data, time);
      return { changed: [record.info.id], delta: null };
    }
    if (!currentAssistant) return none;
    const { record } = currentAssistant;
    const messageID = record.info.id;
    if (event.type === 'content_block_start') {
      const start = contentBlockStartSchema.safeParse(event);
      if (!start.success) return none;
      const id = blockPartId(messageID, start.data.index);
      const type = start.data.content_block.type;
      if (type === 'text') {
        upsertPart(record, buildTextPart({ id, sessionID: sessionId, messageID, text: '', start: time, end: null }));
      } else if (type === 'thinking') {
        upsertPart(record, buildReasoningPart({ id, sessionID: sessionId, messageID, text: '', start: time, end: null }));
      } else {
        return none;
      }
      return { changed: [messageID], delta: null };
    }
    if (event.type === 'content_block_delta') {
      const parsed = contentBlockDeltaSchema.safeParse(event);
      if (!parsed.success) return none;
      const { delta } = parsed.data;
      const text = delta.type === 'text_delta' ? delta.text : delta.type === 'thinking_delta' ? delta.thinking : null;
      const part = streamedPart(parsed.data.index);
      if (text === null || !part) return none;
      part.text += text;
      return { changed: [], delta: { sessionID: sessionId, messageID, partID: part.id, field: 'text', delta: text } };
    }
    if (event.type === 'message_delta') {
      const parsed = messageDeltaSchema.safeParse(event);
      if (!parsed.success) return none;
      const stopReason = parsed.data.delta.stop_reason;
      if (stopReason) record.info.finish = FINISH_BY_STOP_REASON.get(stopReason) ?? 'other';
      if (parsed.data.usage) {
        const tokens = record.info.tokens;
        const output = parsed.data.usage.output_tokens;
        record.info.tokens = { ...tokens, output, total: tokens.total - tokens.output + output };
      }
      return { changed: [messageID], delta: null };
    }
    if (event.type === 'message_stop') {
      record.info.time = { created: record.info.time.created, completed: time };
      return { changed: [messageID], delta: null };
    }
    return none;
  };

  const openCompaction = ({ uuid, timestamp, trigger }, changed) => {
    const record = startUserMessage(`ncl_k_${uuid}`, monotonicTime(timestamp));
    upsertPart(record, buildCompactionPart({
      id: userTextPartId(record.info.id, 0),
      sessionID: sessionId,
      messageID: record.info.id,
      // Only a trigger the CLI named says who compacted; without one the
      // marker makes no claim.
      auto: trigger === 'auto',
    }));
    changed.push(record.info.id);
  };

  // A live frame names its kind. The SDK's history read keeps only the type of
  // a system entry, so there a compaction boundary is known by the compact
  // summary right after it (see applyEntry). Every other system entry, such as
  // turn durations, away summaries, local commands and notices, shows nothing.
  const applySystemEntry = (entry, changed) => {
    if (entry.message !== undefined && entry.message !== null) return;
    if (entry.subtype === undefined) {
      pendingBoundary = { uuid: entry.uuid, timestamp: entry.timestamp, trigger: null };
      return;
    }
    if (entry.subtype !== 'compact_boundary') return;
    const trigger = (entry.compactMetadata ?? entry.compact_metadata)?.trigger ?? null;
    openCompaction({ uuid: entry.uuid, timestamp: entry.timestamp, trigger }, changed);
  };

  const settleTools = (reason) => {
    const changed = [];
    for (const [toolUseId, { record, part }] of toolParts) {
      upsertPart(record, buildToolPart({
        id: part.id,
        sessionID: sessionId,
        messageID: part.messageID,
        callID: part.callID,
        tool: part.tool,
        input: part.state.input,
        title: part.state.title ?? part.tool,
        start: part.state.time.start,
        metadata: part.state.metadata ?? {},
        result: { status: 'error', error: reason, end: lastEntryTime },
      }));
      toolParts.delete(toolUseId);
      changed.push(record.info.id);
    }
    return changed;
  };

  return {
    /**
     * Applies one history entry or complete live frame.
     * @returns {string[]} ids of messages whose record changed
     */
    applyEntry(rawEntry) {
      const parsed = entrySchema.safeParse(rawEntry);
      if (!parsed.success) return [];
      const entry = parsed.data;
      const changed = [];
      const boundary = pendingBoundary;
      pendingBoundary = null;
      if (boundary && entry.type === 'user' && entry.isCompactSummary === true) openCompaction(boundary, changed);
      if (entry.type === 'user') applyUserEntry(entry, changed);
      else if (entry.type === 'assistant') applyAssistantEntry(entry, changed);
      else applySystemEntry(entry, changed);
      return changed;
    },

    /**
     * Settles tool calls that never received a result. History that is not
     * backed by a running turn cannot finish them any more.
     * @param {string} reason
     */
    settleOpenTools(reason) {
      return settleTools(reason);
    },

    /**
     * Applies one stream event of a live query. Subagent events are left to
     * the subagent's own history.
     * @returns {{ changed: string[], delta: { sessionID: string, messageID: string, partID: string, field: 'text', delta: string } | null }}
     */
    applyStreamEvent(rawFrame) {
      const parsed = streamFrameSchema.safeParse(rawFrame);
      if (!parsed.success || parsed.data.parent_tool_use_id) return { changed: [], delta: null };
      return applyStreamEvent(parsed.data.event, liveTime());
    },

    /**
     * Opens the user message of a prompt OpenChamber sends, with the id the
     * CLI will record for it.
     * @param {string} messageId
     * @param {{ kind: 'text', text: string } | { kind: 'blocks', blocks: unknown[] }} content
     */
    startUserPrompt(messageId, content) {
      const time = liveTime();
      // A prompt sent while a message streams joins the turn; that message
      // keeps its blocks, and the next one answers the new prompt.
      const streaming = currentAssistant;
      const record = startUserMessage(messageId, time);
      currentAssistant = streaming;
      applyUserContent(record, content, time);
      return [record.info.id];
    },

    /**
     * Ends the running turn: completes its open assistant message, settles
     * tools that will not finish, and records why the turn failed. A failure
     * before any reply gets an assistant message of its own to show on.
     * @param {{ error: { name: string, data: { message: string } } | null }} outcome
     */
    finishTurn({ error }) {
      const time = liveTime();
      const changed = error === null ? [] : settleTools(error.name === 'MessageAbortedError' ? 'Interrupted' : error.data.message);
      if (currentAssistant) {
        const info = currentAssistant.record.info;
        if (info.time.completed === undefined) info.time = { created: info.time.created, completed: time };
        if (error !== null && info.error === undefined) info.error = error;
        changed.push(info.id);
      } else if (error !== null && currentUser) {
        const record = recordById.get(`${currentUser.info.id}_error`) ?? addRecord(buildAssistantMessage({
          id: `${currentUser.info.id}_error`,
          sessionID: sessionId,
          parentID: currentUser.info.id,
          created: createdAfterPrevious(time),
          completed: time,
          providerID: NATIVE_PROVIDER_CLAUDE,
          modelID: currentUser.info.model.modelID,
          agent: currentUser.info.agent,
          cwd,
          tokens: EMPTY_TOKENS,
          error,
        }));
        changed.push(record.info.id);
      }
      currentAssistant = null;
      return changed;
    },


    record(messageId) {
      return recordById.get(messageId) ?? null;
    },

    /** Id of the assistant message a running turn is writing, if any. */
    openAssistantId() {
      return currentAssistant?.record.info.id ?? null;
    },

    records() {
      return records;
    },
  };
};

export const claudeAbortedError = () => stoppedError();
export const claudeTurnError = (message) => unknownError(message);
