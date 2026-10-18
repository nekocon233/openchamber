// Projects Codex thread turns into OpenCode-shaped records.
//
// A turn starts with the user's message and holds the agent's items in order.
// Each turn becomes a user message and an assistant message whose parts
// follow item order; a message steered into a running turn starts a new user
// message and a new assistant segment. A context compaction becomes a
// compaction message, the marker the UI shows for OpenCode's own compactions.
// Its item id also starts a new assistant segment, preserving both sides of
// the boundary when the UI reconciles messages by id.
// Live item notifications carry start/completion times, and history recovers
// them from the rollout's item_completed records. Only items without a time
// fall back to turn times. Message creation times stay strictly increasing in
// turn order.

import { z } from 'zod';

import {
  codexAssistantMessageId,
  codexCompactionMessageId,
  codexUserMessageIdForItem,
  isCodexPlanApprovalMessageId,
  isNativeClientUserMessageId,
  NATIVE_PROVIDER_CODEX,
  userFilePartId,
  userTextPartId,
} from '../ids.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildFilePart,
  buildTextPart,
  buildUserMessage,
  stoppedError,
  unknownError,
} from '../records.js';
import { codexCompactionItemId, parseCodexUserMessageItem, partsForCodexItem, codexSkillId, codexSkillTextHash } from './items.js';

const DEFAULT_AGENT = 'build';
const itemIdentitySchema = z.object({ id: z.string() });
const skillIdentitySchema = z.object({ type: z.literal('openchamberSkill'), id: z.string() });

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

const partEnd = (part) => part.time?.end ?? part.state?.time?.end;

/**
 * A turn's completedAt has second precision; an item's end can land after it.
 * The assistant step covers every finished part it issued.
 */
const extendAssistantCompleted = (assistant, parts) => {
  const completed = assistant.info.time.completed;
  if (completed === undefined) return;
  let latest = completed;
  for (const part of parts) {
    const end = partEnd(part);
    if (typeof end === 'number' && Number.isFinite(end) && end > latest) latest = end;
  }
  assistant.info.time.completed = latest;
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
 * @param {Map<string, { start: number, end: number | null }>} [input.itemTimes] item lifecycle timestamps in milliseconds, live or recovered from the rollout
 */
export const projectCodexTurns = ({ sessionId, threadId, cwd, turns, threadModel, sendRecordFor = () => null, itemTimes, details = new Map(), statistics = false }) => {
  const records = [];
  let lastCreated = 0;
  const createdAfterPrevious = (time) => {
    if (statistics) return time;
    lastCreated = Math.max(lastCreated + 1, time);
    return lastCreated;
  };

  for (const rawTurn of turns) {
    const parsedTurn = turnSchema.safeParse(rawTurn);
    if (!parsedTurn.success) continue;
    const turn = parsedTurn.data;
    const detail = details?.get(turn.id);
    const modelID = detail?.model ?? threadModel;
    const agent = detail?.agent ?? DEFAULT_AGENT;
    const start = (turn.startedAt ?? 0) * 1000 || lastCreated;
    const end = turn.completedAt ? turn.completedAt * 1000 : null;
    const outcome = outcomeOf(turn);
    let currentUser = null;
    let currentAssistant = null;
    let segmentKey = turn.id;
    let sent = null;

    const userTextHashes = new Set(turn.items.flatMap((item) => parseCodexUserMessageItem(item)?.texts ?? []).map(codexSkillTextHash));
    const extraItems = (detail?.extraItems ?? []).filter((entry) => !entry.sourceTextHash || !userTextHashes.has(entry.sourceTextHash));
    const firstUser = turn.items.find((item) => parseCodexUserMessageItem(item) !== null);
    const firstUserId = itemIdentitySchema.safeParse(firstUser).data?.id ?? null;
    const extrasByAfter = new Map();
    for (const entry of extraItems) {
      const after = entry.after ?? firstUserId;
      const values = extrasByAfter.get(after) ?? [];
      if (!values.some((item) => item.id === entry.item.id)) values.push(entry.item);
      extrasByAfter.set(after, values);
    }
    const projectedItems = [
      ...(extrasByAfter.get(null) ?? []),
      ...turn.items.flatMap((item) => {
        const identity = itemIdentitySchema.safeParse(item);
        const user = parseCodexUserMessageItem(item);
        const skills = user?.skills.map((skill) => ({ ...skill, type: 'openchamberSkill', id: codexSkillId(turn.id, user.id, skill.name), source: 'attached' })) ?? [];
        return [item, ...skills, ...(identity.success ? extrasByAfter.get(identity.data.id) ?? [] : [])];
      }),
    ];
    const seenSkills = new Set();
    for (const rawItem of projectedItems) {
      const skillIdentity = skillIdentitySchema.safeParse(rawItem);
      if (skillIdentity.success) {
        if (seenSkills.has(skillIdentity.data.id)) continue;
        seenSkills.add(skillIdentity.data.id);
      }
      const compactionItemId = codexCompactionItemId(rawItem);
      if (compactionItemId !== null) {
        const id = codexCompactionMessageId(threadId, compactionItemId);
        // A compaction asked for with /compact is a turn of its own; one that
        // follows the turn's prompt is Codex making room.
        const auto = currentUser !== null;
        const completed = itemTimes?.get(compactionItemId)?.end != null
          || detail?.completedCompactions.has(compactionItemId) || turn.status === 'completed';
        currentUser = {
          info: buildCompactionMessage({
            id, sessionID: sessionId, created: createdAfterPrevious(start), auto,
            status: completed ? 'completed' : outcome?.error ? 'failed' : 'running',
            error: completed ? null : outcome?.error ?? null,
          }),
          parts: [buildCompactionPart({ id: userTextPartId(id, 0), sessionID: sessionId, messageID: id, auto })],
        };
        records.push(currentUser);
        segmentKey = compactionItemId;
        currentAssistant = null;
        continue;
      }
      const userItem = parseCodexUserMessageItem(rawItem);
      if (userItem) {
        const id = codexUserMessageId(threadId, userItem);
        sent = sendRecordFor(id);
        const model = sent?.variant === undefined
          ? { providerID: NATIVE_PROVIDER_CODEX, modelID: sent?.modelID ?? modelID }
          : { providerID: NATIVE_PROVIDER_CODEX, modelID: sent.modelID, variant: sent.variant };
        currentUser = { info: buildUserMessage({ id, sessionID: sessionId, created: createdAfterPrevious(statistics ? itemTimes?.get(userItem.id)?.start ?? start : start), agent: sent?.agent ?? agent, model: detail?.effort && model.variant === undefined ? { ...model, variant: detail.effort } : model }), parts: [] };
        userItem.texts.forEach((text, index) => {
          const part = buildTextPart({ id: userTextPartId(id, index), sessionID: sessionId, messageID: id, text, start, end: start });
          if (userItem.clientId !== null && isCodexPlanApprovalMessageId(userItem.clientId)) {
            part.metadata = { openchamberOrigin: 'codex-plan-approval' };
          }
          currentUser.parts.push(part);
        });
        userItem.images.forEach((image, index) => {
          currentUser.parts.push(buildFilePart({ id: userFilePartId(id, index), sessionID: sessionId, messageID: id, mime: 'image/*', url: image.url, filename: image.filename }));
        });
        records.push(currentUser);
        if (currentAssistant) segmentKey = userItem.id;
        currentAssistant = null;
        continue;
      }

      const itemIdentity = itemTimes ? itemIdentitySchema.safeParse(rawItem) : null;
      const itemTime = itemIdentity?.success ? itemTimes.get(itemIdentity.data.id) : null;
      const partStart = itemTime?.start ?? start;
      const parts = partsForCodexItem(rawItem, {
        sessionId, threadId,
        messageId: currentAssistant?.info.id ?? codexAssistantMessageId(threadId, segmentKey),
        start: partStart,
        end: itemTime?.end ?? (outcome === null ? null : Math.max(end ?? start, partStart)),
      });
      if (parts.length === 0) continue;
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
            created: createdAfterPrevious(statistics ? partStart : start),
            completed: outcome === null ? null : (end ?? start),
            providerID: NATIVE_PROVIDER_CODEX,
            modelID: sent?.modelID ?? modelID,
            agent: sent?.agent ?? agent,
            cwd,
            tokens: detail?.usage.segments.get(segmentKey)?.tokens,
            contextWindow: detail?.usage.segments.get(segmentKey)?.contextWindow ?? detail?.contextWindow,
            finish: outcome?.finish ?? null,
            variant: sent?.variant ?? detail?.effort ?? null,
            error: outcome?.error ?? null,
          }),
          parts: [],
        };
        records.push(currentAssistant);
      }

      currentAssistant.parts.push(...parts);
      extendAssistantCompleted(currentAssistant, parts);
    }
  }
  return records;
};
