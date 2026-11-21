import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import type { JsonValue } from '../../shared/json-values.js';
import { codexLegacyUsage, codexPersistedUsage, createCodexUsage, observeCodexUsage, type CodexUsageState } from './usage.js';
import { codexQuestionItem, codexSkillId, codexSkillTextHash, type CodexQuestionItem, type CodexSkillItem } from './items.js';

const jsonValueSchema = z.custom<JsonValue>(() => true);
const positiveFiniteMs = z.number().finite().positive().nullable().catch(null);

const entry = z.object({ type: z.string(), payload: jsonValueSchema, timestamp: z.string().nullable().catch(null) });
const session = z.object({ id: z.string() });
const context = z.object({
  turn_id: z.string(),
  model: z.string(),
  effort: z.string().nullish(),
  collaboration_mode: z.object({ mode: z.string() }).passthrough().nullish(),
});
const event = z.object({ type: z.string() }).passthrough();
const start = z.object({ turn_id: z.string(), model_context_window: z.number().positive().nullish() });
const itemEvent = z.object({
  turn_id: z.string(),
  item: z.object({ type: z.string(), id: z.string() }).passthrough(),
  started_at_ms: positiveFiniteMs,
  completed_at_ms: positiveFiniteMs,
});
const functionCall = z.object({ type: z.literal('function_call'), name: z.literal('request_user_input'), call_id: z.string(), arguments: z.string() });
const functionOutput = z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() });
const answerOutput = z.object({ answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })) });
const verifiedAnswer = z.object({
  type: z.literal('verified_answer'),
  call_id: z.string(),
  turn_id: z.string(),
  questions: z.array(z.object({ question: z.string(), answer: z.string() })),
});
const userContent = z.object({ type: z.literal('message'), role: z.literal('user'), content: z.array(z.object({ text: z.string() }).passthrough()) });
const skillContent = z.object({ type: z.literal('skill'), name: z.string() });
const toolBoundaryKinds = z.enum(['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output']);
const toolBoundary = z.object({
  type: toolBoundaryKinds,
  call_id: z.string().min(1),
});
const finishedTurn = z.object({ turn_id: z.string() });
const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

export interface CodexItemTime {
  start: number;
  end: number | null;
}

export interface CodexToolCallInterval {
  start: number | null;
  end: number | null;
  custom: boolean;
}

export interface CodexPlanInterval {
  start: number | null;
  end: number | null;
}

export interface CodexToolWaits {
  start: number | null;
  end: number | null;
  valid: boolean;
  calls: Map<string, CodexToolCallInterval>;
  plans: Map<string, CodexPlanInterval>;
  boundaries: Map<string, number | null>;
  hasExecution: boolean;
}

export interface CodexExtraItem {
  item: CodexQuestionItem | CodexSkillItem;
  after: string | null;
  sourceTextHash?: string | undefined;
}

export interface CodexTurnDetails {
  usage: CodexUsageState;
  model: string | null;
  effort: string | null;
  agent: 'plan' | 'build' | null;
  contextWindow: number | null;
  segment: string | null;
  hasAssistant: boolean;
  extraItems: CodexExtraItem[];
  lastItemId: string | null;
  lastUserId: string | null;
  completedCompactions: Set<string>;
  itemTimes: Map<string, CodexItemTime>;
  toolWaits: CodexToolWaits;
}

const timestampMs = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export const createCodexTurnDetails = (): CodexTurnDetails => ({
  usage: createCodexUsage(),
  model: null,
  effort: null,
  agent: null,
  contextWindow: null,
  segment: null,
  hasAssistant: false,
  extraItems: [],
  lastItemId: null,
  lastUserId: null,
  completedCompactions: new Set(),
  itemTimes: new Map(),
  toolWaits: { start: null, end: null, valid: true, calls: new Map(), plans: new Map(), boundaries: new Map(), hasExecution: false },
});

export const codexToolWaitDuration = (detail: CodexTurnDetails | null | undefined, segment: string): number | null => {
  const waits = detail?.toolWaits;
  if (!waits?.valid || waits.start === null || waits.end === null || waits.end < waits.start
    || (waits.hasExecution && waits.calls.size === 0)) return null;
  const boundaries: Array<[string, number]> = [];
  for (const [id, time] of waits.boundaries) {
    if (time === null || time < waits.start || time > waits.end) return null;
    boundaries.push([id, time]);
  }
  boundaries.sort((left, right) => left[1] - right[1]);
  const index = boundaries.findIndex(([id]) => id === segment);
  if (index < 0) return null;
  const currentBoundary = boundaries[index];
  if (!currentBoundary) return null;
  const start = currentBoundary[1];
  const end = boundaries[index + 1]?.[1] ?? waits.end;
  if (end < start) return null;
  const intervals: Array<[number, number]> = [];
  for (const interval of [...waits.calls.values(), ...waits.plans.values()]) {
    if (interval.start === null || interval.end === null || interval.end < interval.start
      || interval.start < waits.start || interval.end > waits.end) return null;
    const from = Math.max(start, interval.start);
    const to = Math.min(end, interval.end);
    if (to > from) intervals.push([from, to]);
  }
  intervals.sort((left, right) => left[0] - right[0]);
  let duration = 0;
  let cursor = start;
  for (const [from, to] of intervals) {
    duration += Math.max(0, to - Math.max(cursor, from));
    cursor = Math.max(cursor, to);
  }
  return duration;
};

export const readCodexHistoryDetails = async (filePath: string | null | undefined, threadId: string): Promise<Map<string, CodexTurnDetails>> => {
  const turns = new Map<string, CodexTurnDetails>();
  if (!filePath) return turns;
  let activeTurn: string | null = null;
  const questionById = new Map<string, CodexQuestionItem>();
  const callOwners = new Map<string, CodexTurnDetails>();
  const detailFor = (turnId: string): CodexTurnDetails => {
    let detail = turns.get(turnId);
    if (!detail) {
      detail = createCodexTurnDetails();
      detail.segment = turnId;
      turns.set(turnId, detail);
    }
    return detail;
  };
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let json: JsonValue;
      try { json = JSON.parse(line); } catch {
        if (activeTurn && detailFor(activeTurn).toolWaits.end === null) detailFor(activeTurn).toolWaits.valid = false;
        continue;
      }
      const parsed = entry.safeParse(json);
      if (!parsed.success) continue;
      const { type, payload } = parsed.data;
      const lineMs = timestampMs(parsed.data.timestamp);
      if (type === 'session_meta') {
        const meta = session.safeParse(payload);
        if (meta.success && meta.data.id !== threadId) throw new Error('Codex history thread identity mismatch');
      } else if (type === 'turn_context') {
        const result = context.safeParse(payload);
        if (!result.success) continue;
        activeTurn = result.data.turn_id;
        Object.assign(detailFor(activeTurn), {
          model: result.data.model,
          effort: result.data.effort ?? null,
          agent: result.data.collaboration_mode?.mode === 'plan' ? 'plan' : 'build',
        });
      } else if (type === 'token_usage_record') {
        const result = codexPersistedUsage.safeParse(payload);
        if (!result.success || (result.data.thread_id && result.data.thread_id !== threadId)) continue;
        const detail = detailFor(result.data.turn_id);
        if (detail.segment !== null) {
          observeCodexUsage(detail.usage, detail.segment, {
            total: result.data.thread_token_usage,
            last: result.data.usage,
            modelContextWindow: detail.contextWindow,
          });
        }
      } else if (type === 'event_msg') {
        const kind = event.safeParse(payload);
        if (!kind.success) continue;
        if (kind.data.type === 'task_started') {
          const result = start.safeParse(payload);
          if (!result.success) continue;
          activeTurn = result.data.turn_id;
          const detail = detailFor(activeTurn);
          detail.contextWindow = result.data.model_context_window ?? null;
          detail.toolWaits.start ??= lineMs;
          detail.toolWaits.boundaries.set(activeTurn, detail.toolWaits.start);
        } else if (kind.data.type === 'task_complete' || kind.data.type === 'turn_aborted') {
          const result = finishedTurn.safeParse(payload);
          if (result.success) detailFor(result.data.turn_id).toolWaits.end = lineMs;
        } else if (kind.data.type === 'item_completed') {
          const result = itemEvent.safeParse(payload);
          if (!result.success) continue;
          const detail = detailFor(result.data.turn_id);
          detail.lastItemId = result.data.item.id;
          const itemStart = result.data.started_at_ms ?? result.data.completed_at_ms;
          const itemEnd = result.data.completed_at_ms;
          const waits = detail.toolWaits;
          if (result.data.item.type === 'Plan') {
            const planStart = result.data.started_at_ms;
            if (planStart === null || itemEnd === null) waits.valid = false;
            if (!waits.plans.has(result.data.item.id)) waits.plans.set(result.data.item.id, { start: planStart, end: itemEnd });
          } else if (['CommandExecution', 'FileChange', 'McpToolCall', 'DynamicToolCall', 'WebSearch', 'ImageView', 'CollabAgentToolCall'].includes(result.data.item.type)) {
            waits.hasExecution = true;
          }
          const previous = detail.itemTimes.get(result.data.item.id);
          const resolvedStart = previous?.start ?? itemStart ?? itemEnd;
          if (resolvedStart !== null && (!previous || previous.end === null)) {
            detail.itemTimes.set(result.data.item.id, {
              start: resolvedStart,
              end: previous?.end ?? itemEnd ?? null,
            });
          }
          if (result.data.item.type === 'UserMessage') {
            detail.lastUserId = result.data.item.id;
            if (detail.hasAssistant) detail.segment = result.data.item.id;
            if (detail.segment !== null && !waits.boundaries.has(detail.segment)) waits.boundaries.set(detail.segment, itemStart ?? lineMs);
            detail.hasAssistant = false;
            const content = z.array(z.unknown()).safeParse(result.data.item.content);
            if (itemStart !== null && content.success) {
              for (const raw of content.data) {
                const skill = skillContent.safeParse(raw);
                if (!skill.success) continue;
                const id = codexSkillId(result.data.turn_id, result.data.item.id, skill.data.name);
                if (!detail.itemTimes.has(id)) detail.itemTimes.set(id, { start: itemStart, end: itemEnd ?? itemStart });
              }
            }
          } else if (result.data.item.type === 'ContextCompaction') {
            detail.completedCompactions.add(result.data.item.id);
            detail.segment = result.data.item.id;
            waits.boundaries.set(detail.segment, itemStart ?? lineMs);
            detail.hasAssistant = false;
            detail.usage.lastTotal = null;
          } else {
            detail.hasAssistant = true;
          }
        } else if (kind.data.type === 'token_count' && activeTurn) {
          const result = codexLegacyUsage.safeParse(payload);
          if (!result.success) continue;
          const detail = detailFor(activeTurn);
          detail.contextWindow = result.data.info.model_context_window ?? detail.contextWindow;
          if (detail.segment !== null) {
            observeCodexUsage(detail.usage, detail.segment, {
              total: result.data.info.total_token_usage,
              last: result.data.info.last_token_usage,
              modelContextWindow: detail.contextWindow,
            });
          }
        }
      } else if (type === 'response_item' && activeTurn) {
        const detail = detailFor(activeTurn);
        const boundary = toolBoundary.safeParse(payload);
        const payloadType = event.safeParse(payload).data?.type;
        if (!boundary.success && payloadType !== undefined && toolBoundaryKinds.safeParse(payloadType).success) detail.toolWaits.valid = false;
        if (boundary.success) {
          const { type: kind, call_id: id } = boundary.data;
          const custom = kind.startsWith('custom_');
          if (kind === 'function_call' || kind === 'custom_tool_call') {
            const owner = callOwners.get(id);
            if (!owner) {
              detail.toolWaits.calls.set(id, { start: lineMs, end: null, custom });
              callOwners.set(id, detail);
            } else {
              const existingCall = owner.toolWaits.calls.get(id);
              if (owner !== detail || !existingCall || existingCall.start !== lineMs || existingCall.custom !== custom) {
                detail.toolWaits.valid = false;
              }
            }
          } else {
            const owner = callOwners.get(id);
            const interval = owner?.toolWaits.calls.get(id);
            if (!interval || interval.custom !== custom) detail.toolWaits.valid = false;
            else interval.end ??= lineMs;
          }
        }
        const call = functionCall.safeParse(payload);
        if (call.success) {
          let args: JsonValue;
          try { args = JSON.parse(call.data.arguments); } catch { continue; }
          const parsedArgs = jsonRecordSchema.safeParse(args);
          if (!parsedArgs.success) continue;
          const question = codexQuestionItem.safeParse({ ...parsedArgs.data, type: 'openchamberQuestion', id: call.data.call_id });
          if (question.success) {
            const id = question.data.id;
            const value: CodexExtraItem = { item: question.data, after: detail.lastItemId };
            detail.extraItems.push(value);
            questionById.set(id, question.data);
            if (lineMs !== null && !detail.itemTimes.has(id)) {
              detail.itemTimes.set(id, { start: lineMs, end: null });
            }
          }
          continue;
        }
        const result = functionOutput.safeParse(payload);
        if (result.success) {
          const item = questionById.get(result.data.call_id);
          if (!item) continue;
          const time = detail.itemTimes.get(result.data.call_id);
          if (time && time.end === null && lineMs !== null) time.end = lineMs;
          let jsonValue: JsonValue;
          try { jsonValue = JSON.parse(result.data.output); } catch { continue; }
          const answers = answerOutput.safeParse(jsonValue);
          if (!answers.success) continue;
          item.answers = item.questions.map((question) => (
            question.id !== undefined ? answers.data.answers[question.id]?.answers ?? [] : []
          ));
          item.resolution = item.answers.some((value) => value.length > 0) ? 'answered' : 'dismissed';
          continue;
        }
        const message = userContent.safeParse(payload);
        if (message.success) {
          for (const content of message.data.content) {
            const name = /^\s*<skill>\s*<name>([^<]+)<\/name>/.exec(content.text)?.[1];
            if (!name) continue;
            const skillPath = /<path>([^<]+)<\/path>/.exec(content.text)?.[1];
            const id = codexSkillId(activeTurn, detail.lastUserId ?? activeTurn, name);
            const item: CodexSkillItem = skillPath !== undefined
              ? { type: 'openchamberSkill', id, name, path: skillPath, source: 'attached' }
              : { type: 'openchamberSkill', id, name, source: 'attached' };
            detail.extraItems.push({ after: detail.lastItemId, sourceTextHash: codexSkillTextHash(content.text), item });
            if (lineMs !== null && !detail.itemTimes.has(id)) {
              detail.itemTimes.set(id, { start: lineMs, end: lineMs });
            }
          }
        }
      } else if (type === 'retained_context') {
        const answer = verifiedAnswer.safeParse(payload);
        if (!answer.success) continue;
        const item = questionById.get(answer.data.call_id);
        if (!item) continue;
        const time = detailFor(answer.data.turn_id).itemTimes.get(answer.data.call_id);
        if (time && time.end === null && lineMs !== null) time.end = lineMs;
        item.answers = item.questions.map((question) => {
          const value = answer.data.questions.find((entryItem) => entryItem.question === question.question)?.answer;
          return value === undefined ? [] : [value];
        });
        item.resolution = 'answered';
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return turns;
};

export const codexItemTimes = (details: ReadonlyMap<string, CodexTurnDetails> | null | undefined): Map<string, CodexItemTime> => {
  const merged = new Map<string, CodexItemTime>();
  for (const detail of details?.values() ?? []) {
    for (const [id, time] of detail.itemTimes) {
      if (!merged.has(id)) merged.set(id, time);
    }
  }
  return merged;
};
