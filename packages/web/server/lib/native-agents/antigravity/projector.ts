import {
  antigravityPromptFingerprint,
  antigravityVisiblePromptText,
} from '../prompt-parts.js';
import type { PromptPart } from '../prompt-parts.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildTextPart,
  buildToolPart,
  stoppedError,
  unknownError,
} from '../records.js';
import type {
  NativeAssistantMessage,
  NativeCompactionMessage,
  NativeMessageRecord,
  NativePart,
  NativeTextPart,
  NativeToolPart,
} from '../records.js';
import type { NativeEventPublisher } from '../publisher.js';
import type { NativeRegistry, RegistrySendRecord } from '../registry.js';
import { agyTokenUsage } from './protocol.js';
import type { AgyStepUpdate, AgyTranscriptStep, AgyTranscriptToolCall, AgyUsage } from './protocol.js';
import { mapAgyTool, agyEditMetadata, agyMissingFileDetails, agyToolInputTruncated, withAgyFileDetails } from './tools.js';
import { antigravityChecklistSnapshot, AGY_CHECKLIST_PART_TOOL } from './checklist.js';
import type { AgyGenerationContext } from './context-metadata.js';
import type { JsonObject } from '../../shared/json-values.js';
import type { AgySelection } from './history-projection.js';
import {
  assistantId,
  compactionId,
  partId,
  toolCallId,
  MISSING_TOOL_RESULT,
  commandExitCode,
  shortenedOutput,
  subagentMetadata,
  userRecord,
  reasoningPart,
} from './history-projection.js';

export type AgyBindingRegistry = Pick<NativeRegistry, 'sendRecords' | 'bindAntigravityMessage'>;
export type AgyProjectionPublisher = Pick<NativeEventPublisher, 'records' | 'delta' | 'checklist' | 'emit'>;

export interface AgyLiveProjectionRequest {
  messageID: string;
  model: { providerID: string; modelID: string };
  variant?: string | undefined;
  agent: string;
  sentAt: number;
  parts: readonly PromptPart[];
}

export interface AgyLiveProjectionFinishInput {
  outcome: 'success' | 'error' | 'aborted';
  response: string;
  error: string;
  time: number;
  responseStep?: { step_index: number; usage?: AgyUsage | undefined } | null | undefined;
}

export interface AgyAssistantRecord {
  info: NativeAssistantMessage;
  parts: NativePart[];
}

export type AgyCompletedGeneration = AgyTranscriptStep & { context?: AgyGenerationContext };

export interface AgyLiveProjection {
  records: () => NativeMessageRecord[];
  finalReply: () => AgyAssistantRecord | null;
  toolPart: (id: string) => NativeToolPart | null;
  restoreGenerations: (entries: readonly AgyCompletedGeneration[]) => void;
  restoreMissingHistory: (history: readonly NativeMessageRecord[], options?: { scope?: 'turn' | 'session' | undefined }) => void;
  userStepIndex: () => number | null;
  applyStep: (step: AgyStepUpdate, time: number, bindUserStep: (stepIndex: number) => Promise<void>) => Promise<NativeToolPart | undefined>;
  finish: (input: AgyLiveProjectionFinishInput) => void;
}

export interface ProjectAntigravityHistoryInput {
  sessionId: string;
  nativeId: string;
  directory: string;
  entries: readonly AgyTranscriptStep[];
  bindings: ReadonlyMap<number, RegistrySendRecord>;
  parentSessionId?: string | null | undefined;
  childSessionIds?: readonly string[] | undefined;
  contextReading?: { stepIndex: number; context: AgyGenerationContext } | null | undefined;
  now?: (() => number) | undefined;
}

interface AgyCompactionRecord {
  info: NativeCompactionMessage;
  parts: NativePart[];
}

export const resolveAntigravityBindings = async ({
  sessionId,
  entries,
  registry,
}: {
  sessionId: string;
  entries: readonly AgyTranscriptStep[];
  registry: AgyBindingRegistry;
}): Promise<{ bindings: Map<number, RegistrySendRecord>; sends: Map<string, RegistrySendRecord> }> => {
  const sends = await registry.sendRecords(sessionId);
  const bindings = new Map<number, RegistrySendRecord>();
  for (const send of sends.values()) {
    if (send.antigravity?.stepIndex !== undefined) bindings.set(send.antigravity.stepIndex, send);
  }
  for (const entry of entries) {
    if (entry.type !== 'USER_INPUT' || bindings.has(entry.step_index)) continue;
    const claimed = new Set([...bindings.values()].map((send) => send.messageId));
    const fingerprint = antigravityPromptFingerprint(entry.content ?? '');
    const visible = antigravityVisiblePromptText(entry.content ?? '');
    const planText = visible === '/plan' ? '' : visible.startsWith('/plan ') ? visible.slice(6) : null;
    const planFingerprint = planText !== null ? antigravityPromptFingerprint(planText) : null;
    const candidates = [...sends.values()].filter((send) => (
      send.antigravity?.stepIndex === undefined
      && !claimed.has(send.messageId)
    ));
    const candidate = candidates.find((send) => send.antigravity?.fingerprint === fingerprint)
      ?? candidates.find((send) => send.agent === 'plan' && planFingerprint !== null && send.antigravity?.fingerprint === planFingerprint);
    if (!candidate) continue;
    await registry.bindAntigravityMessage(sessionId, candidate.messageId, entry.step_index);
    bindings.set(entry.step_index, {
      ...candidate,
      antigravity: { ...candidate.antigravity, stepIndex: entry.step_index },
    });
  }
  return { bindings, sends };
};

const restoreAssistantContext = (
  live: NativeAssistantMessage,
  saved: Pick<NativeAssistantMessage, 'contextWindow' | 'metadata'>,
): boolean => {
  let changed = false;
  if (live.contextWindow === undefined && saved.contextWindow !== undefined) {
    live.contextWindow = saved.contextWindow;
    changed = true;
  }
  if (saved.metadata?.nativeContextSource === 'provider' && live.metadata?.nativeContextSource !== 'provider') {
    live.metadata = { ...live.metadata, nativeContextSource: 'provider' };
    changed = true;
  }
  return changed;
};

export const createAntigravityLiveProjection = ({
  sessionId,
  nativeId,
  directory,
  publisher,
  request,
}: {
  sessionId: string;
  nativeId: string;
  directory: string;
  publisher: AgyProjectionPublisher;
  request: AgyLiveProjectionRequest;
}): AgyLiveProjection => {
  let lastCreated = 0;
  const created = (time: number): number => {
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  let records = new Map<string, NativeMessageRecord>();
  const tools = new Map<string, NativeToolPart>();
  const unfinishedTools = new Set<string>();
  let currentAssistant: AgyAssistantRecord | null = null;
  let currentText: NativeTextPart | null = null;
  let userStepIndex: number | null = null;
  const selection: AgySelection = {
    providerID: request.model.providerID,
    modelID: request.model.modelID,
    agent: request.agent,
  };
  if (request.variant !== undefined) selection.variant = request.variant;
  const user = userRecord({
    sessionId,
    id: request.messageID,
    created: created(request.sentAt),
    send: selection,
    parts: request.parts,
  });
  records.set(user.info.id, user);

  const publish = (record: NativeMessageRecord): void => publisher.records(directory, sessionId, [record]);
  const rememberHistoricalTool = (part: NativePart): void => {
    if (part.type !== 'tool') return;
    tools.set(part.id, part);
    if (part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT) unfinishedTools.add(part.id);
  };
  const ensureAssistant = (stepIndex: number, time: number): AgyAssistantRecord => {
    const id = assistantId(nativeId, stepIndex);
    const existing = records.get(id);
    if (existing && existing.info.role === 'assistant') {
      return { info: existing.info, parts: existing.parts };
    }
    const record: AgyAssistantRecord = {
      info: buildAssistantMessage({
        id,
        sessionID: sessionId,
        parentID: request.messageID,
        created: created(time),
        completed: null,
        ...selection,
        cwd: directory,
      }),
      parts: [],
    };
    records.set(id, record);
    return record;
  };
  const appendResponseText = (
    stepIndex: number,
    delta: string,
    state: string,
    usage: AgyUsage | null,
    time: number,
  ): void => {
    const record = ensureAssistant(stepIndex, time);
    currentAssistant = record;
    let part = record.parts.find((candidate): candidate is NativeTextPart => candidate.type === 'text');
    if (!part) {
      part = buildTextPart({
        id: partId(nativeId, stepIndex, 'text'),
        sessionID: sessionId,
        messageID: record.info.id,
        text: '',
        start: created(time),
        end: null,
      });
      record.parts.push(part);
    }
    currentText = part;
    if (delta !== '') {
      part.text += delta;
      publisher.delta(directory, {
        sessionID: sessionId,
        messageID: record.info.id,
        partID: part.id,
        field: 'text',
        delta,
      });
    }
    if (state === 'DONE' || state === 'ERROR') {
      const endTime = created(time);
      part.time.end = endTime;
      record.info.time.completed = endTime;
      if (usage) {
        const tokens = agyTokenUsage(usage);
        if (tokens !== undefined) record.info.tokens = tokens;
        else delete record.info.tokens;
      }
      record.info.finish = 'stop';
    }
    publish(record);
  };

  return {
    records() {
      return [...records.values()];
    },

    finalReply() {
      return currentAssistant;
    },

    toolPart(id) {
      return tools.get(id) ?? null;
    },

    restoreGenerations(entries) {
      for (const entry of entries) {
        const record = records.get(assistantId(nativeId, entry.step_index));
        if (!record || record.info.role !== 'assistant') continue;
        const part = reasoningPart({ sessionId, nativeId, entry, time: record.info.time.created });
        const index = part ? record.parts.findIndex((held) => held.id === part.id) : -1;
        let changed = false;
        if (entry.context) {
          const info = record.info;
          changed = restoreAssistantContext(info, entry.context);
          if (info.tokens === undefined && entry.usage) {
            const tokens = agyTokenUsage(entry.usage);
            if (tokens) {
              info.tokens = tokens;
              changed = true;
            }
          }
        }
        if (part && index === -1) {
          record.parts.unshift(part);
          changed = true;
        } else if (part) {
          const held = record.parts[index];
          if (held && held.type === 'reasoning' && held.metadata?.nativeOutputTruncated && !part.metadata?.nativeOutputTruncated) {
            record.parts[index] = { ...part, time: held.time };
            changed = true;
          }
        }
        entry.tool_calls?.forEach((call, offset) => {
          const id = partId(nativeId, entry.step_index + offset + 1, 'tool');
          const held = tools.get(id);
          if (!held || held.messageID !== record.info.id || held.state.status !== 'completed' || !agyMissingFileDetails(held)) return;
          const mapped = mapAgyTool(call);
          const inputTruncated = agyToolInputTruncated(call, entry.truncated_fields?.includes('tool_calls'));
          const metadata = agyEditMetadata(call, { completed: true, inputTruncated });
          if (inputTruncated) metadata.nativeInputTruncated = true;
          const enriched = withAgyFileDetails(held, {
            ...held,
            tool: mapped.tool,
            state: { ...held.state, input: mapped.input, metadata },
          });
          if (enriched === held) return;
          const partIndex = record.parts.findIndex((candidate) => candidate.id === id);
          if (partIndex === -1) return;
          record.parts[partIndex] = enriched;
          tools.set(id, enriched);
          changed = true;
        });
        if (!changed) continue;
        publish(record);
        if (part && index === -1) {
          publisher.emit(directory, 'message.parts.replaced', {
            sessionID: sessionId,
            messageID: record.info.id,
            parts: record.parts,
          });
        }
      }
    },

    restoreMissingHistory(history, { scope = 'turn' } = {}) {
      const start = history.findIndex((record) => record.info.id === request.messageID);
      if (start === -1 && scope !== 'session') return;
      const first = scope === 'session' ? 0 : start + 1;
      let end = first;
      let inserted = false;
      for (; end < history.length; end++) {
        const historical = history[end];
        if (!historical) break;
        if (historical.info.role === 'user' && scope === 'turn') break;
        const live = records.get(historical.info.id);
        if (!live) {
          inserted = true;
          records.set(historical.info.id, historical);
          historical.parts.forEach(rememberHistoricalTool);
          publish(historical);
          continue;
        }
        if (historical.info.role === 'user' && live.info.role === 'user') {
          if (JSON.stringify(live) !== JSON.stringify(historical)) {
            live.info = historical.info;
            live.parts = historical.parts;
            publish(live);
          }
          continue;
        }
        if (historical.info.role === 'compaction' && live.info.role === 'compaction') {
          if (live.info.status !== historical.info.status || live.info.summary !== historical.info.summary
            || JSON.stringify(live.info.error) !== JSON.stringify(historical.info.error)) {
            live.info = { ...historical.info, time: live.info.time };
            publish(live);
          }
          continue;
        }
        const liveParts = new Map(live.parts.map((part) => [part.id, part]));
        const recovered = (part: NativePart): boolean => unfinishedTools.has(part.id) && part.type === 'tool'
          && !(part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT);
        const known = new Set(historical.parts.map((part) => part.id));
        let changed = false;
        if (live.info.role === 'assistant' && historical.info.role === 'assistant'
          && live.info.parentID !== historical.info.parentID) {
          live.info.parentID = historical.info.parentID;
          changed = true;
        }
        if (live.info.role === 'assistant' && historical.info.role === 'assistant'
          && (scope === 'session'
            ? historical.info.time.created !== live.info.time.created
            : historical.info.time.created < live.info.time.created)) {
          live.info.time.created = historical.info.time.created;
          if (scope === 'session') {
            for (const part of live.parts) {
              if (part.type === 'tool') {
                if (part.state.time.start >= live.info.time.created) continue;
                const offset = live.info.time.created - part.state.time.start;
                part.state.time.start += offset;
                let partEnd = part.state.time.start;
                if (part.state.status !== 'running' && part.state.time.end !== undefined) {
                  part.state.time.end += offset;
                  partEnd = part.state.time.end;
                }
                if (live.info.time.completed !== undefined) {
                  live.info.time.completed = Math.max(live.info.time.completed, partEnd);
                }
              } else if (part.type === 'text' || part.type === 'reasoning') {
                if (part.time.start >= live.info.time.created) continue;
                const offset = live.info.time.created - part.time.start;
                part.time.start += offset;
                if (part.time.end !== undefined) part.time.end += offset;
                if (live.info.time.completed !== undefined) {
                  live.info.time.completed = Math.max(live.info.time.completed, part.time.end ?? part.time.start);
                }
              }
            }
          }
          changed = true;
        }
        if (live.info.role === 'assistant' && historical.info.role === 'assistant'
          && live.info.tokens === undefined && historical.info.tokens !== undefined) {
          live.info.tokens = structuredClone(historical.info.tokens);
          changed = true;
        }
        if (live.info.role === 'assistant' && historical.info.role === 'assistant') {
          changed = restoreAssistantContext(live.info, historical.info) || changed;
        }
        if (live.info.role === 'assistant' && historical.info.role === 'assistant'
          && live.info.contextCompaction === undefined && historical.info.contextCompaction !== undefined) {
          live.info.contextCompaction = historical.info.contextCompaction;
          changed = true;
        }
        const parts = historical.parts.map((part): NativePart => {
          const held = liveParts.get(part.id);
          if (recovered(part) && part.type === 'tool') {
            changed = true;
            unfinishedTools.delete(part.id);
            tools.set(part.id, part);
            return part;
          }
          if (!held) {
            changed = true;
            rememberHistoricalTool(part);
            return part;
          }
          if (part.type === 'reasoning' && held.type === 'reasoning'
            && held.metadata?.nativeOutputTruncated && !part.metadata?.nativeOutputTruncated) {
            changed = true;
            return { ...part, time: held.time };
          }
          if (part.type === 'tool' && held.type === 'tool' && !part.state.metadata?.nativeInputTruncated) {
            const input: JsonObject = held.tool !== part.tool || part.state.input?.filePath
              ? part.state.input
              : { ...held.state.input, ...part.state.input };
            const metadata: JsonObject = { ...held.state.metadata, nativeBackend: 'antigravity' };
            if (held.state.status === 'completed' && part.state.status === 'completed') Object.assign(metadata, part.state.metadata);
            if (JSON.stringify(input) !== JSON.stringify(held.state.input)) delete metadata.nativeInputTruncated;
            if (held.tool !== part.tool || JSON.stringify(input) !== JSON.stringify(held.state.input)
              || JSON.stringify(metadata) !== JSON.stringify(held.state.metadata)) {
              changed = true;
              const enriched: NativeToolPart = { ...held, tool: part.tool, state: { ...held.state, input, metadata } };
              tools.set(part.id, enriched);
              return enriched;
            }
          }
          return held;
        }).concat(live.parts.filter((part) => !known.has(part.id)));
        if (!changed) continue;
        live.parts = parts;
        publish(live);
      }
      if (!inserted) return;
      const historyOrder = new Map<string, number>();
      for (const { info } of history.slice(first, end)) {
        if (!historyOrder.has(info.id)) historyOrder.set(info.id, historyOrder.size);
      }
      let cursor = 0;
      const ids = [...historyOrder.keys()];
      const ordered = new Map<string, NativeMessageRecord>();
      for (const [id, record] of records) {
        const position = historyOrder.get(id);
        if (position === undefined) {
          ordered.set(id, record);
          continue;
        }
        while (cursor <= position) {
          const next = ids[cursor++];
          const recovered = next === undefined ? undefined : records.get(next);
          if (recovered) ordered.set(recovered.info.id, recovered);
        }
      }
      records = ordered;
    },

    userStepIndex() {
      return userStepIndex;
    },

    async applyStep(step, time, bindUserStep) {
      if (step.step_type === 'user_input') {
        userStepIndex = step.step_index;
        await bindUserStep(step.step_index);
        publish(user);
        return undefined;
      }
      if (step.step_type === 'agent_response') {
        appendResponseText(step.step_index, step.text_delta, step.state, step.usage, time);
        return undefined;
      }
      if (step.step_type === 'checkpoint') {
        const timeCreated = created(time);
        const info = buildCompactionMessage({
          id: compactionId(nativeId, step.step_index),
          sessionID: sessionId,
          created: timeCreated,
          status: step.state === 'DONE' ? 'completed' : step.state === 'ERROR' ? 'failed' : 'running',
          auto: true,
          error: step.state === 'ERROR' ? unknownError(step.tool_info?.error?.message ?? 'Antigravity compaction failed') : null,
        });
        const record: AgyCompactionRecord = {
          info,
          parts: [buildCompactionPart({
            id: partId(nativeId, step.step_index, 'compaction'),
            sessionID: sessionId,
            messageID: info.id,
            auto: true,
          })],
        };
        records.set(info.id, record);
        publish(record);
        return undefined;
      }
      if (step.step_type !== 'tool' && step.step_type !== 'subagent') return undefined;
      const parentStep = currentAssistant
        ? Number(currentAssistant.info.id.split('_').at(-1))
        : Math.max(0, step.step_index - 1);
      const assistant = ensureAssistant(parentStep, time);
      currentAssistant = assistant;
      const id = partId(nativeId, step.step_index, 'tool');
      const found = tools.get(id) ?? assistant.parts.find((part) => part.id === id);
      const previous = found?.type === 'tool' ? found : undefined;
      if (previous && previous.state.status !== 'running') return undefined;
      const info = step.tool_info ?? { name: step.tool_name || 'Antigravity tool', parameters: {}, output: '', error: null };
      const call: AgyTranscriptToolCall = { name: info.name || step.tool_name, args: info.parameters, argumentsEncoded: false };
      const mapped = mapAgyTool(call);
      const exit = call.name === 'run_command' ? commandExitCode(info.output) : null;
      const failed = step.state === 'ERROR' || step.state === 'INVALID' || info.error !== null || (exit !== null && exit !== 0);
      const start = previous?.state.time.start ?? created(time);
      const result = step.state === 'ACTIVE' || step.state === 'RUNNING'
        ? null
        : failed
          ? { status: 'error' as const, error: info.error?.message ?? (info.output || 'Antigravity tool failed'), end: created(time) }
          : { status: 'completed' as const, output: info.output, end: created(time) };
      const callInputTruncated = agyToolInputTruncated(call);
      const metadata: JsonObject = {
        nativeBackend: 'antigravity',
        ...mapped.metadata,
        ...subagentMetadata(step.subagent_info),
        ...agyEditMetadata(call, { completed: result?.status === 'completed', inputTruncated: callInputTruncated }),
      };
      if (exit !== null) metadata.exit = exit;
      if (shortenedOutput(info.output)) metadata.nativeOutputTruncated = true;
      if (callInputTruncated) metadata.nativeInputTruncated = true;
      const part = buildToolPart({
        id,
        sessionID: sessionId,
        messageID: assistant.info.id,
        callID: toolCallId(nativeId, step.step_index),
        tool: step.step_type === 'subagent' ? 'task' : mapped.tool,
        input: mapped.input,
        title: mapped.title,
        start,
        metadata,
        result,
      });
      const index = assistant.parts.findIndex((candidate) => candidate.id === id);
      if (index === -1) assistant.parts.push(part);
      else assistant.parts[index] = part;
      tools.set(id, part);
      publish(assistant);
      if (part.tool === AGY_CHECKLIST_PART_TOOL && part.state.status === 'completed') {
        try {
          const snapshot = antigravityChecklistSnapshot({ sessionId, records: [assistant], observedAt: time });
          if (snapshot.state === 'ready') publisher.checklist(directory, sessionId, snapshot);
        } catch {
          return part;
        }
      }
      return part;
    },

    finish({ outcome, response, error, time, responseStep = null }) {
      const settledAt = created(time);
      if (responseStep !== null) {
        currentAssistant = ensureAssistant(responseStep.step_index, time);
        currentText = currentAssistant.parts.find((part): part is NativeTextPart => part.type === 'text') ?? null;
        if (responseStep.usage) {
          const tokens = agyTokenUsage(responseStep.usage);
          if (tokens !== undefined) currentAssistant.info.tokens = tokens;
          else delete currentAssistant.info.tokens;
        }
      }
      if (!currentAssistant) currentAssistant = ensureAssistant((userStepIndex ?? 0) + 1, time);
      if (response !== '') {
        if (!currentText) {
          currentText = currentAssistant.parts.find((part): part is NativeTextPart => part.type === 'text') ?? null;
        }
        if (!currentText) {
          currentText = buildTextPart({
            id: partId(nativeId, Number(currentAssistant.info.id.split('_').at(-1)), 'text'),
            sessionID: sessionId,
            messageID: currentAssistant.info.id,
            text: '',
            start: settledAt,
            end: null,
          });
          currentAssistant.parts.push(currentText);
        }
        if (currentText.text !== response) {
          const delta = response.startsWith(currentText.text) ? response.slice(currentText.text.length) : null;
          currentText.text = response;
          if (delta !== null && delta !== '') {
            publisher.delta(directory, {
              sessionID: sessionId,
              messageID: currentAssistant.info.id,
              partID: currentText.id,
              field: 'text',
              delta,
            });
          }
        }
      }
      for (const part of tools.values()) {
        if (part.state.status !== 'running') continue;
        unfinishedTools.add(part.id);
        part.state = {
          status: 'error',
          input: part.state.input,
          error: outcome === 'success' ? MISSING_TOOL_RESULT : outcome === 'aborted' ? 'Interrupted' : error,
          metadata: part.state.metadata,
          time: { start: part.state.time.start, end: settledAt },
        };
      }
      for (const record of records.values()) {
        if (record.info.role === 'compaction' && record.info.status === 'running') {
          record.info.status = 'failed';
          record.info.error = outcome === 'aborted' ? stoppedError() : unknownError(error || 'Antigravity compaction completion was not recorded');
          publish(record);
        }
        if (record.info.role !== 'assistant') continue;
        record.info.time.completed = settledAt;
        for (const part of record.parts) {
          if (part.type === 'text' && part.time.end === undefined) part.time.end = settledAt;
        }
        if (outcome !== 'success' && record.info.id === currentAssistant.info.id) {
          record.info.error = outcome === 'aborted' ? stoppedError() : unknownError(error);
          record.info.finish = 'error';
        } else if (record.info.finish === undefined) {
          record.info.finish = 'stop';
        }
        publish(record);
      }
      publish(user);
    },
  };
};

export { projectAntigravityHistory } from './history-projection.js';
