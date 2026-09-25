// Projects Codex thread turns into OpenCode-shaped records.
//
// A turn starts with the user's message and holds the agent's items in order.
// Each turn becomes a user message and an assistant message whose parts
// follow item order; a message steered into a running turn starts a new user
// message and a new assistant segment. A context compaction becomes a
// compaction message, the marker the UI shows for OpenCode's own compactions.
// Live item notifications carry start/completion times; persisted items do
// not, so history parts fall back to turn times. Message creation times stay
// non-decreasing in turn order.

import { z } from 'zod';

import {
  codexAssistantMessageId,
  codexCompactionMessageId,
  codexUserMessageIdForItem,
  isNativeClientUserMessageId,
  NATIVE_PROVIDER_CODEX,
  userFilePartId,
  userTextPartId,
} from '../ids.js';
import {
  buildAssistantMessage,
  buildCompactionPart,
  buildFilePart,
  buildTextPart,
  buildUserMessage,
  EMPTY_TOKENS,
  stoppedError,
  unknownError,
} from '../records.js';
import { codexCompactionItemId, parseCodexUserMessageItem, partsForCodexItem } from './items.js';

const DEFAULT_AGENT = 'build';
const itemIdentitySchema = z.object({ id: z.string() });

const turnSchema = z.object({
  id: z.string(),
  items: z.array(z.unknown()).catch([]),
  status: z.string().catch('completed'),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  error: z.object({ message: z.string() }).passthrough().nullish(),
}).passthrough();

const outcomeOf = (turn) => {
  if (turn.status === 'failed') return { finish: null, error: unknownError(turn.error?.message ?? 'Codex turn failed') };
  if (turn.status === 'interrupted') return { finish: null, error: stoppedError() };
  if (turn.status === 'completed') return { finish: 'stop', error: null };
  return null;
};

/**
 * Id for a user message: the id OpenChamber sent with it, else one derived
 * from the thread item for messages typed in another Codex client.
 */
const codexUserMessageId = (threadId, item) => (
  item.clientId !== null && item.clientId.startsWith('ncx_u_') && isNativeClientUserMessageId(item.clientId)
    ? item.clientId
    : codexUserMessageIdForItem(threadId, item.id)
);

/**
 * The user messages of a thread in order, each with its turn and whether it
 * started that turn rather than being steered into it.
 * @param {{ threadId: string, turns: unknown[] }} input turns oldest first
 * @returns {Array<{ messageId: string, turnId: string, startsTurn: boolean }>}
 */
export const codexUserMessages = ({ threadId, turns }) => {
  const messages = [];
  for (const rawTurn of turns) {
    const turn = turnSchema.safeParse(rawTurn);
    if (!turn.success) continue;
    let startsTurn = true;
    for (const rawItem of turn.data.items) {
      const userItem = parseCodexUserMessageItem(rawItem);
      if (!userItem) continue;
      messages.push({ messageId: codexUserMessageId(threadId, userItem), turnId: turn.data.id, startsTurn });
      startsTurn = false;
    }
  }
  return messages;
};

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.threadId
 * @param {string} input.cwd
 * @param {unknown[]} input.turns oldest first
 * @param {string} input.threadModel model the thread last ran with
 * @param {(userMessageId: string) => ({ modelID: string, variant?: string, agent: string } | null)} [input.sendRecordFor]
 * @param {Map<string, { start: number, end: number | null }>} [input.itemTimes] live item lifecycle timestamps in milliseconds
 */
export const projectCodexTurns = ({ sessionId, threadId, cwd, turns, threadModel, sendRecordFor = () => null, itemTimes }) => {
  const records = [];
  let lastCreated = 0;
  const createdAfterPrevious = (time) => {
    lastCreated = Math.max(lastCreated + 1, time);
    return lastCreated;
  };

  for (const rawTurn of turns) {
    const parsedTurn = turnSchema.safeParse(rawTurn);
    if (!parsedTurn.success) continue;
    const turn = parsedTurn.data;
    const start = (turn.startedAt ?? 0) * 1000 || lastCreated;
    const end = turn.completedAt ? turn.completedAt * 1000 : null;
    const outcome = outcomeOf(turn);
    let currentUser = null;
    let currentAssistant = null;
    let segmentKey = turn.id;
    let sent = null;

    for (const rawItem of turn.items) {
      const compactionItemId = codexCompactionItemId(rawItem);
      if (compactionItemId !== null) {
        const id = codexCompactionMessageId(threadId, compactionItemId);
        // A compaction asked for with /compact is a turn of its own; one that
        // follows the turn's prompt is Codex making room.
        const auto = currentUser !== null;
        currentUser = {
          info: buildUserMessage({ id, sessionID: sessionId, created: createdAfterPrevious(start), agent: DEFAULT_AGENT, model: { providerID: NATIVE_PROVIDER_CODEX, modelID: threadModel } }),
          parts: [buildCompactionPart({ id: userTextPartId(id, 0), sessionID: sessionId, messageID: id, auto })],
        };
        records.push(currentUser);
        currentAssistant = null;
        continue;
      }
      const userItem = parseCodexUserMessageItem(rawItem);
      if (userItem) {
        const id = codexUserMessageId(threadId, userItem);
        sent = sendRecordFor(id);
        const model = sent?.variant === undefined
          ? { providerID: NATIVE_PROVIDER_CODEX, modelID: sent?.modelID ?? threadModel }
          : { providerID: NATIVE_PROVIDER_CODEX, modelID: sent.modelID, variant: sent.variant };
        currentUser = { info: buildUserMessage({ id, sessionID: sessionId, created: createdAfterPrevious(start), agent: sent?.agent ?? DEFAULT_AGENT, model }), parts: [] };
        userItem.texts.forEach((text, index) => {
          currentUser.parts.push(buildTextPart({ id: userTextPartId(id, index), sessionID: sessionId, messageID: id, text, start, end: start }));
        });
        userItem.images.forEach((image, index) => {
          currentUser.parts.push(buildFilePart({ id: userFilePartId(id, index), sessionID: sessionId, messageID: id, mime: 'image/*', url: image.url, filename: image.filename }));
        });
        records.push(currentUser);
        if (currentAssistant) segmentKey = userItem.id;
        currentAssistant = null;
        continue;
      }

      if (!currentAssistant) {
        if (!currentUser) {
          // A turn without a user item (for example a review) still needs a
          // parent for its assistant message to render.
          const id = `${codexAssistantMessageId(threadId, segmentKey)}_u`;
          currentUser = {
            info: buildUserMessage({ id, sessionID: sessionId, created: createdAfterPrevious(start), agent: DEFAULT_AGENT, model: { providerID: NATIVE_PROVIDER_CODEX, modelID: threadModel } }),
            parts: [buildTextPart({ id: userTextPartId(id, 0), sessionID: sessionId, messageID: id, text: '', start, end: start, synthetic: true })],
          };
          records.push(currentUser);
        }
        currentAssistant = {
          info: buildAssistantMessage({
            id: codexAssistantMessageId(threadId, segmentKey),
            sessionID: sessionId,
            parentID: currentUser.info.id,
            created: createdAfterPrevious(start),
            completed: outcome === null ? null : (end ?? start),
            providerID: NATIVE_PROVIDER_CODEX,
            modelID: sent?.modelID ?? threadModel,
            agent: sent?.agent ?? DEFAULT_AGENT,
            cwd,
            tokens: EMPTY_TOKENS,
            finish: outcome?.finish ?? null,
            variant: sent?.variant ?? null,
            error: outcome?.error ?? null,
          }),
          parts: [],
        };
        records.push(currentAssistant);
      }

      const itemIdentity = itemTimes ? itemIdentitySchema.safeParse(rawItem) : null;
      const itemTime = itemIdentity?.success ? itemTimes.get(itemIdentity.data.id) : null;
      const partStart = itemTime?.start ?? start;
      const parts = partsForCodexItem(rawItem, {
        sessionId,
        threadId,
        messageId: currentAssistant.info.id,
        start: partStart,
        end: itemTime?.end ?? (outcome === null ? null : Math.max(end ?? start, partStart)),
      });
      currentAssistant.parts.push(...parts);
    }
  }
  return records;
};
