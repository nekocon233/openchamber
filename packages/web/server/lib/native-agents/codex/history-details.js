// Supplemental metadata the history RPC omits: usage, item lifecycle times and
// user-input calls. Conversation records still come from thread/turns/list;
// only metadata for its retained turns is projected.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';

import { codexLegacyUsage, codexPersistedUsage, createCodexUsage, observeCodexUsage } from './usage.js';
import { codexQuestionItem, codexSkillId, codexSkillTextHash } from './items.js';

const entry = z.object({ type: z.string(), payload: z.unknown(), timestamp: z.unknown().optional() });
const session = z.object({ id: z.string() });
const context = z.object({
  turn_id: z.string(), model: z.string(), effort: z.string().nullish(),
  collaboration_mode: z.object({ mode: z.string() }).passthrough().nullish(),
});
const event = z.object({ type: z.string() }).passthrough();
const start = z.object({ turn_id: z.string(), model_context_window: z.number().positive().nullish() });
const itemEvent = z.object({
  turn_id: z.string(),
  item: z.object({ type: z.string(), id: z.string() }).passthrough(),
  started_at_ms: z.unknown().optional(),
  completed_at_ms: z.unknown().optional(),
});
const functionCall = z.object({ type: z.literal('function_call'), name: z.literal('request_user_input'), call_id: z.string(), arguments: z.string() });
const functionOutput = z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() });
const answerOutput = z.object({ answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })) });
const verifiedAnswer = z.object({
  type: z.literal('verified_answer'), call_id: z.string(), turn_id: z.string(),
  questions: z.array(z.object({ question: z.string(), answer: z.string() })),
});
const userContent = z.object({ type: z.literal('message'), role: z.literal('user'), content: z.array(z.object({ text: z.string() }).passthrough()) });
const skillContent = z.object({ type: z.literal('skill'), name: z.string() });

/** A positive epoch-millisecond value, or null when the field is unusable. */
const finiteMs = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

/** The rollout line's own time. Item timestamps are epoch milliseconds to match. */
const timestampMs = (value) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export const createCodexTurnDetails = () => ({
  usage: createCodexUsage(), model: null, effort: null, agent: null,
  contextWindow: null, segment: null, hasAssistant: false,
  extraItems: [], lastItemId: null,
  lastUserId: null,
  completedCompactions: new Set(),
  itemTimes: new Map(),
});

/** Read one app-server supplied rollout, never search another thread's files. */
export const readCodexHistoryDetails = async (filePath, threadId) => {
  const turns = new Map();
  if (!filePath) return turns;
  let activeTurn = null;
  const questionById = new Map();
  const detailFor = (turnId) => {
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
      let json;
      try { json = JSON.parse(line); } catch { continue; } // A live writer may have an unfinished final line.
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
          model: result.data.model, effort: result.data.effort,
          agent: result.data.collaboration_mode?.mode === 'plan' ? 'plan' : 'build',
        });
      } else if (type === 'token_usage_record') {
        const result = codexPersistedUsage.safeParse(payload);
        if (!result.success || (result.data.thread_id && result.data.thread_id !== threadId)) continue;
        const detail = detailFor(result.data.turn_id);
        observeCodexUsage(detail.usage, detail.segment, {
          total: result.data.thread_token_usage, last: result.data.usage,
          modelContextWindow: detail.contextWindow,
        });
      } else if (type === 'event_msg') {
        const kind = event.safeParse(payload);
        if (!kind.success) continue;
        if (kind.data.type === 'task_started') {
          const result = start.safeParse(payload);
          if (!result.success) continue;
          activeTurn = result.data.turn_id;
          detailFor(activeTurn).contextWindow = result.data.model_context_window;
        } else if (kind.data.type === 'item_completed') {
          const result = itemEvent.safeParse(payload);
          if (!result.success) continue;
          const detail = detailFor(result.data.turn_id);
          detail.lastItemId = result.data.item.id;
          const itemStart = finiteMs(result.data.started_at_ms) ?? finiteMs(result.data.completed_at_ms);
          const itemEnd = finiteMs(result.data.completed_at_ms);
          if (itemStart !== null || itemEnd !== null) {
            const previous = detail.itemTimes.get(result.data.item.id);
            // A completed item is immutable; duplicate records must not erase it.
            if (!previous || previous.end === null) {
              detail.itemTimes.set(result.data.item.id, {
                start: previous?.start ?? itemStart ?? itemEnd,
                end: previous?.end ?? itemEnd ?? null,
              });
            }
          }
          if (result.data.item.type === 'UserMessage') {
            detail.lastUserId = result.data.item.id;
            if (detail.hasAssistant) detail.segment = result.data.item.id;
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
          observeCodexUsage(detail.usage, detail.segment, {
            total: result.data.info.total_token_usage, last: result.data.info.last_token_usage,
            modelContextWindow: detail.contextWindow,
          });
        }
      } else if (type === 'response_item' && activeTurn) {
        const detail = detailFor(activeTurn);
        const call = functionCall.safeParse(payload);
        if (call.success) {
          let args;
          try { args = JSON.parse(call.data.arguments); } catch { continue; }
          const question = codexQuestionItem.safeParse({ ...args, type: 'openchamberQuestion', id: call.data.call_id });
          if (question.success) {
            const id = question.data.id;
            const value = { item: question.data, after: detail.lastItemId };
            detail.extraItems.push(value);
            questionById.set(id, value.item);
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
          let json;
          try { json = JSON.parse(result.data.output); } catch { continue; }
          const answers = answerOutput.safeParse(json);
          if (!answers.success) continue;
          item.answers = item.questions.map((question) => answers.data.answers[question.id]?.answers ?? []);
          item.resolution = item.answers.some((value) => value.length > 0) ? 'answered' : 'dismissed';
          continue;
        }
        const message = userContent.safeParse(payload);
        if (message.success) {
          for (const content of message.data.content) {
            const name = /^\s*<skill>\s*<name>([^<]+)<\/name>/.exec(content.text)?.[1];
            if (!name) continue;
            const path = /<path>([^<]+)<\/path>/.exec(content.text)?.[1];
            const id = codexSkillId(activeTurn, detail.lastUserId ?? activeTurn, name);
            detail.extraItems.push({ after: detail.lastItemId, sourceTextHash: codexSkillTextHash(content.text), item: {
              type: 'openchamberSkill', id, name, path, source: 'attached',
            } });
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
          const value = answer.data.questions.find((entry) => entry.question === question.question)?.answer;
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

/** Merge every retained turn's item lifecycle into the projector's lookup. */
export const codexItemTimes = (details) => {
  const merged = new Map();
  for (const detail of details?.values() ?? []) {
    for (const [id, time] of detail.itemTimes) {
      if (!merged.has(id)) merged.set(id, time);
    }
  }
  return merged;
};
