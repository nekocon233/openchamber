import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
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
import { promptTextAttachmentFile } from '../prompt-parts.js';
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
import {
  codexCompactionItemId,
  parseCodexUserMessageItem,
  partsForCodexItem,
  codexSkillId,
  codexSkillTextHash,
  type CodexItemPart,
  type CodexQuestionItem,
  type CodexRawItem,
  type CodexSkillItem,
  type CodexTextPart,
  type CodexToolPart,
  type ParsedCodexUserMessage,
} from './items.js';
import { codexToolWaitDuration, type CodexItemTime, type CodexTurnDetails } from './history-details.js';

const DEFAULT_AGENT = 'build';
const jsonValueSchema = z.custom<JsonValue>(() => true);
const itemIdentitySchema = z.object({ id: z.string() });
const skillIdentitySchema = z.object({ type: z.literal('openchamberSkill'), id: z.string() });

const turnSchema = z.object({
  id: z.string(),
  items: z.array(jsonValueSchema).catch([]),
  status: z.string().catch('completed'),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  error: z.object({ message: z.string() }).passthrough().nullish(),
}).passthrough();

export interface CodexSendRecord {
  modelID: string;
  variant?: string | undefined;
  agent: string;
}

export interface CodexUserMessageRef {
  messageId: string;
  turnId: string;
  startsTurn: boolean;
}

export type CodexUserTextPart = CodexTextPart;
export type CodexFilePart = ReturnType<typeof buildFilePart>;
export type CodexCompactionPart = ReturnType<typeof buildCompactionPart>;
export type CodexProjectedPart = CodexItemPart | CodexUserTextPart | CodexFilePart | CodexCompactionPart;

export interface CodexUserRecord {
  info: ReturnType<typeof buildUserMessage>;
  parts: Array<CodexUserTextPart | CodexFilePart>;
}

export interface CodexCompactionRecord {
  info: ReturnType<typeof buildCompactionMessage>;
  parts: CodexCompactionPart[];
}

export type CodexAssistantMessageInfo = ReturnType<typeof buildAssistantMessage> & {
  metadata: {
    openchamber: {
      telemetry: {
        toolWaitDurationMs: number | null;
      };
    };
  };
};

export interface CodexAssistantRecord {
  info: CodexAssistantMessageInfo;
  parts: CodexItemPart[];
}

export type CodexProjectedRecord = CodexUserRecord | CodexCompactionRecord | CodexAssistantRecord;

export interface ProjectCodexTurnsInput {
  sessionId: string;
  threadId: string;
  cwd: string;
  turns: readonly JsonValue[];
  threadModel: string;
  sendRecordFor?: ((userMessageId: string) => CodexSendRecord | null) | undefined;
  itemTimes?: ReadonlyMap<string, CodexItemTime> | undefined;
  details?: ReadonlyMap<string, CodexTurnDetails> | null | undefined;
  statistics?: boolean | undefined;
}

export const isCodexToolPart = (part: CodexProjectedPart): part is CodexToolPart => part.type === 'tool';
export const isCodexAssistantRecord = (record: CodexProjectedRecord): record is CodexAssistantRecord => record.info.role === 'assistant';

const outcomeOf = (turn: z.infer<typeof turnSchema>) => {
  if (turn.status === 'failed') return { finish: null, error: unknownError(turn.error?.message ?? 'Codex turn failed') };
  if (turn.status === 'interrupted') return { finish: null, error: stoppedError() };
  if (turn.status === 'completed') return { finish: 'stop', error: null };
  return null;
};

const partEnd = (part: CodexProjectedPart): number | undefined => {
  if (isCodexToolPart(part)) return 'end' in part.state.time ? part.state.time.end : undefined;
  if ('time' in part) return 'end' in part.time ? part.time.end : undefined;
  return undefined;
};

const extendAssistantCompleted = (assistant: CodexAssistantRecord, parts: readonly CodexProjectedPart[]) => {
  const time = assistant.info.time;
  if (!('completed' in time) || time.completed === undefined) return;
  let latest = time.completed;
  for (const part of parts) {
    const end = partEnd(part);
    if (end !== undefined && Number.isFinite(end) && end > latest) latest = end;
  }
  time.completed = latest;
};

const codexUserMessageId = (threadId: string, item: ParsedCodexUserMessage): string => (
  item.clientId !== null && item.clientId.startsWith('ncx_u_') && isNativeClientUserMessageId(item.clientId)
    ? item.clientId
    : codexUserMessageIdForItem(threadId, item.id)
);

export const codexUserMessages = ({ threadId, turns }: { threadId: string; turns: readonly JsonValue[] }): CodexUserMessageRef[] => {
  const messages: CodexUserMessageRef[] = [];
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

export const projectCodexTurns = ({
  sessionId,
  threadId,
  cwd,
  turns,
  threadModel,
  sendRecordFor = () => null,
  itemTimes,
  details = new Map(),
  statistics = false,
}: ProjectCodexTurnsInput): CodexProjectedRecord[] => {
  const records: CodexProjectedRecord[] = [];
  let lastCreated = 0;
  const createdAfterPrevious = (time: number): number => {
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
    let currentUser: CodexUserRecord | CodexCompactionRecord | null = null;
    let currentAssistant: CodexAssistantRecord | null = null;
    let segmentKey = turn.id;
    let sent: CodexSendRecord | null = null;

    const userTextHashes = new Set(turn.items.flatMap((item) => parseCodexUserMessageItem(item)?.texts ?? []).map(codexSkillTextHash));
    const extraItems = (detail?.extraItems ?? []).filter((entry) => !entry.sourceTextHash || !userTextHashes.has(entry.sourceTextHash));
    const firstUser = turn.items.find((item) => parseCodexUserMessageItem(item) !== null);
    const firstUserId = itemIdentitySchema.safeParse(firstUser).data?.id ?? null;
    const extrasByAfter = new Map<string | null, Array<CodexQuestionItem | CodexSkillItem>>();
    for (const entry of extraItems) {
      const after = entry.after ?? firstUserId;
      const values = extrasByAfter.get(after) ?? [];
      if (!values.some((item) => item.id === entry.item.id)) values.push(entry.item);
      extrasByAfter.set(after, values);
    }
    const projectedItems: CodexRawItem[] = [
      ...(extrasByAfter.get(null) ?? []),
      ...turn.items.flatMap((item): CodexRawItem[] => {
        const identity = itemIdentitySchema.safeParse(item);
        const user = parseCodexUserMessageItem(item);
        const skills: CodexSkillItem[] = user?.skills.map((skill) => ({
          type: 'openchamberSkill' as const,
          id: codexSkillId(turn.id, user.id, skill.name),
          name: skill.name,
          path: skill.path,
          source: 'attached' as const,
        })) ?? [];
        return [item, ...skills, ...(identity.success ? extrasByAfter.get(identity.data.id) ?? [] : [])];
      }),
    ];
    const seenSkills = new Set<string>();
    for (const rawItem of projectedItems) {
      const skillIdentity = skillIdentitySchema.safeParse(rawItem);
      if (skillIdentity.success) {
        if (seenSkills.has(skillIdentity.data.id)) continue;
        seenSkills.add(skillIdentity.data.id);
      }
      const compactionItemId = codexCompactionItemId(rawItem);
      if (compactionItemId !== null) {
        const id = codexCompactionMessageId(threadId, compactionItemId);
        const auto = currentUser !== null;
        const completed = itemTimes?.get(compactionItemId)?.end != null
          || detail?.completedCompactions.has(compactionItemId) || turn.status === 'completed';
        const compactionRecord: CodexCompactionRecord = {
          info: buildCompactionMessage({
            id,
            sessionID: sessionId,
            created: createdAfterPrevious(start),
            auto,
            status: completed ? 'completed' : outcome?.error ? 'failed' : 'running',
            error: completed ? null : outcome?.error ?? null,
          }),
          parts: [buildCompactionPart({ id: userTextPartId(id, 0), sessionID: sessionId, messageID: id, auto })],
        };
        currentUser = compactionRecord;
        records.push(compactionRecord);
        segmentKey = compactionItemId;
        currentAssistant = null;
        continue;
      }
      const userItem = parseCodexUserMessageItem(rawItem);
      if (userItem) {
        const id = codexUserMessageId(threadId, userItem);
        sent = sendRecordFor(id);
        const resolvedVariant = sent?.variant !== undefined ? sent.variant : (detail?.effort || undefined);
        const model = resolvedVariant !== undefined
          ? { providerID: NATIVE_PROVIDER_CODEX, modelID: sent?.modelID ?? modelID, variant: resolvedVariant }
          : { providerID: NATIVE_PROVIDER_CODEX, modelID: sent?.modelID ?? modelID };
        const userRecord: CodexUserRecord = {
          info: buildUserMessage({
            id,
            sessionID: sessionId,
            created: createdAfterPrevious(statistics ? itemTimes?.get(userItem.id)?.start ?? start : start),
            agent: sent?.agent ?? agent,
            model,
          }),
          parts: [],
        };
        userItem.texts.forEach((text, index) => {
          const basePart = buildTextPart({ id: userTextPartId(id, index), sessionID: sessionId, messageID: id, text, start, end: start });
          const part: CodexUserTextPart = userItem.clientId !== null && isCodexPlanApprovalMessageId(userItem.clientId)
            ? { ...basePart, metadata: { openchamberOrigin: 'codex-plan-approval' as const } }
            : basePart;
          userRecord.parts.push(part);
        });
        userItem.files.forEach((attachment, index) => {
          const file = 'text' in attachment ? promptTextAttachmentFile(attachment) : attachment;
          userRecord.parts.push(buildFilePart({ ...file, id: userFilePartId(id, index), sessionID: sessionId, messageID: id }));
        });
        currentUser = userRecord;
        records.push(userRecord);
        if (currentAssistant) segmentKey = userItem.id;
        currentAssistant = null;
        continue;
      }

      const itemIdentity = itemTimes ? itemIdentitySchema.safeParse(rawItem) : null;
      const itemTime = itemIdentity?.success ? itemTimes?.get(itemIdentity.data.id) : null;
      const partStart = itemTime?.start ?? start;
      const parts = partsForCodexItem(rawItem, {
        sessionId,
        threadId,
        messageId: currentAssistant?.info.id ?? codexAssistantMessageId(threadId, segmentKey),
        start: partStart,
        end: itemTime?.end ?? (outcome === null ? null : Math.max(end ?? start, partStart)),
      });
      if (parts.length === 0) continue;
      if (!currentAssistant) {
        if (!currentUser) {
          const id = `${codexAssistantMessageId(threadId, segmentKey)}_u`;
          const syntheticUser: CodexUserRecord = {
            info: buildUserMessage({ id, sessionID: sessionId, created: createdAfterPrevious(start), agent: DEFAULT_AGENT, model: { providerID: NATIVE_PROVIDER_CODEX, modelID: threadModel } }),
            parts: [buildTextPart({ id: userTextPartId(id, 0), sessionID: sessionId, messageID: id, text: '', start, end: start, synthetic: true })],
          };
          currentUser = syntheticUser;
          records.push(syntheticUser);
        }
        const segmentUsage = detail?.usage.segments.get(segmentKey);
        const tokens = segmentUsage?.tokens;
        const contextWindow = segmentUsage?.contextWindow ?? detail?.contextWindow;
        const assistantParams: Parameters<typeof buildAssistantMessage>[0] = {
          id: codexAssistantMessageId(threadId, segmentKey),
          sessionID: sessionId,
          parentID: currentUser.info.id,
          created: createdAfterPrevious(statistics ? partStart : start),
          completed: outcome === null ? null : (end ?? start),
          providerID: NATIVE_PROVIDER_CODEX,
          modelID: sent?.modelID ?? modelID,
          agent: sent?.agent ?? agent,
          cwd,
          finish: outcome?.finish ?? null,
          variant: sent?.variant ?? detail?.effort ?? null,
          error: outcome?.error ?? null,
        };
        if (tokens !== undefined) assistantParams.tokens = tokens;
        if (contextWindow !== undefined && contextWindow !== null) assistantParams.contextWindow = contextWindow;
        const assistantInfo: CodexAssistantMessageInfo = {
          ...buildAssistantMessage(assistantParams),
          metadata: {
            openchamber: {
              telemetry: {
                toolWaitDurationMs: outcome === null ? null : codexToolWaitDuration(detail, segmentKey),
              },
            },
          },
        };
        currentAssistant = { info: assistantInfo, parts: [] };
        records.push(currentAssistant);
      }

      currentAssistant.parts.push(...parts);
      extendAssistantCompleted(currentAssistant, parts);
    }
  }
  return records;
};
