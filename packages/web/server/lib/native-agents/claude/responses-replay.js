// Responses state travels in the CLI transcript, never in a bridge-side cache.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NativeAgentError } from '../errors.js';

const PREFIX = 'openchamber-responses:';
const MAX_BYTES = 8 * 1024 * 1024;
const index = z.number().int().nonnegative();
const phase = z.enum(['commentary', 'final_answer']);
const scope = z.object({ accountId: z.string().min(1), model: z.string().min(1) });

export const reasoningItemSchema = z.object({
  type: z.literal('reasoning'), id: z.string(),
  encrypted_content: z.string().nullish(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })).optional(),
  content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() })).optional(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
});

const entry = z.discriminatedUnion('type', [
  reasoningItemSchema,
  z.object({
    type: z.literal('message'), id: z.string(), phase: phase.nullish(),
    parts: z.array(z.object({ blockIndex: index, type: z.enum(['output_text', 'refusal']) })).min(1),
  }),
  z.object({ type: z.literal('function_call'), blockIndex: index }),
]);
// `responseId` names the upstream response this state came from, so the next
// request can offer it to the provider's cache diagnostics. Carriers written
// before it existed simply lack it, and builds that predate it ignore it.
const envelope = z.object({ version: z.literal(1), scope, digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1), entries: z.array(entry), responseId: z.string().min(1).optional() });
const header = z.object({ version: z.number() });
const opaqueBlock = z.object({ type: z.literal('redacted_thinking'), data: z.string() });
const visibleBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.json()) }),
]);
const digests = (blocks) => blocks.map((block) => createHash('sha256').update(JSON.stringify(block)).digest('hex'));
const invalid = () => new NativeAgentError('Invalid GPT replay state in this conversation', { code: 'CHATGPT_INVALID_REPLAY_STATE', status: 400 });

const layoutTypes = (entries, count) => {
  const types = new Map();
  for (const item of entries) {
    if (item.type === 'reasoning') {
      if (!item.encrypted_content) throw invalid();
      continue;
    }
    const indexes = item.type === 'message' ? item.parts.map((part) => part.blockIndex) : [item.blockIndex];
    for (const i of indexes) {
      if (i >= count || types.has(i)) throw invalid();
      types.set(i, item.type === 'message' ? 'text' : 'tool_use');
    }
  }
  if (types.size !== count) throw invalid();
  return types;
};
const checkLayout = (entries, blocks) => {
  const types = layoutTypes(entries, blocks.length);
  for (const [i, type] of types) if (blocks[i].type !== type) throw invalid();
};

/** Detect ownership without decoding state, including versions this build cannot read. */
export const isResponsesReplayBlock = (block) => {
  const parsed = opaqueBlock.safeParse(block);
  return parsed.success && parsed.data.data.startsWith(PREFIX);
};

/** Only metadata and opaque reasoning are stored; visible content stays with the CLI. */
export const createResponsesReplayBlock = ({ accountId, model, blocks, entries, responseId = null }) => {
  if (!entries.some((item) => item.type === 'reasoning' || (item.type === 'message' && item.phase != null))) return null;
  const visible = z.array(visibleBlock).parse(blocks);
  const draft = { version: 1, scope: { accountId, model }, digests: digests(visible), entries };
  if (responseId !== null) draft.responseId = responseId;
  const state = envelope.parse(draft);
  checkLayout(state.entries, visible);
  const block = { type: 'redacted_thinking', data: PREFIX + Buffer.from(JSON.stringify(state)).toString('base64') };
  const frame = { type: 'content_block_start', index: visible.length, content_block: block };
  if (Buffer.byteLength(`event: content_block_start\ndata: ${JSON.stringify(frame)}\n\n`) > MAX_BYTES) {
    throw new NativeAgentError('GPT replay state exceeds the stream frame limit', { code: 'CHATGPT_REPLAY_STATE_TOO_LARGE', status: 413 });
  }
  return block;
};

/** The CLI groups thinking/text before tools; restore the original Responses ordering. */
export const readResponsesReplay = ({ block, blocks, accountId, model }) => {
  if (!isResponsesReplayBlock(block)) return null;
  const data = opaqueBlock.parse(block).data;
  if (Buffer.byteLength(data) > MAX_BYTES) throw invalid();
  const encoded = z.base64().safeParse(data.slice(PREFIX.length));
  if (!encoded.success) throw invalid();
  let raw;
  try { raw = JSON.parse(Buffer.from(encoded.data, 'base64').toString('utf8')); }
  catch { throw invalid(); }
  const version = header.safeParse(raw);
  if (version.success && version.data.version !== 1) {
    throw new NativeAgentError('Unsupported GPT replay state version', { code: 'CHATGPT_UNSUPPORTED_REPLAY_STATE', status: 400 });
  }
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) throw invalid();
  const state = parsed.data;
  const types = layoutTypes(state.entries, state.digests.length);
  const visible = z.array(visibleBlock).safeParse(blocks);
  if (!visible.success) return null;
  if (state.scope.accountId !== accountId || state.scope.model !== model) return null;
  const available = digests(visible.data).join(':');
  const original = state.digests.map((_digest, i) => i);
  const grouped = [...original.filter((i) => types.get(i) === 'text'), ...original.filter((i) => types.get(i) === 'tool_use')];
  const matches = new Map();
  for (const order of [original, grouped]) {
    const expected = order.map((i) => state.digests[i]).join(':');
    const start = available.indexOf(expected);
    if (start < 0) continue;
    // An ambiguous segment has no authoritative binding to this state.
    if (available.indexOf(expected, start + 1) !== -1) return null;
    matches.set(start / 65, order);
  }
  if (matches.size !== 1) return null;
  const [[offset, order]] = matches;
  const segment = [];
  for (const [position, i] of order.entries()) segment[i] = visible.data[offset + position];
  checkLayout(state.entries, segment);
  return { entries: state.entries, blocks: segment, offset, responseId: state.responseId ?? null };
};
