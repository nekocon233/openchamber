import { NATIVE_PROVIDER_ANTIGRAVITY, encodeAntigravitySessionId, userFilePartId, userTextPartId } from '../ids.js';
import { antigravityDisplayPromptParts, isInstructionsBlock, type PromptPart } from '../prompt-parts.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildFilePart,
  buildReasoningPart,
  buildTextPart,
  buildToolPart,
  buildUserMessage,
  unknownError,
} from '../records.js';
import type {
  NativeMessageModel,
  NativeMessageRecord,
  NativePart,
  NativeReasoningPart,
  NativeToolPart,
  NativeUserMessage,
} from '../records.js';
import type { RegistrySendRecord } from '../registry.js';
import { agyTime, agyTokenUsage, agySubagentReferences, agyConversationMessage, agyPermissionError } from './protocol.js';
import type { AgySubagentInfo, AgyTranscriptStep, AgyTranscriptToolCall } from './protocol.js';
import { agyBackgroundResults } from './tasks.js';
import { mapAgyTool, agyEditMetadata, agyToolInputTruncated } from './tools.js';
import type { JsonObject } from '../../shared/json-values.js';
import type { ProjectAntigravityHistoryInput, AgyAssistantRecord } from './projector.js';

export interface AgySelection {
  providerID: string;
  modelID: string;
  agent: string;
  variant?: string;
}

interface AgyUserRecord {
  info: NativeUserMessage;
  parts: NativePart[];
}

const sessionKey = (nativeId: string): string => nativeId.replaceAll('-', '');

const userId = (nativeId: string, stepIndex: number | string): string => `nag_u_${sessionKey(nativeId)}_${stepIndex}`;

export const assistantId = (nativeId: string, stepIndex: number): string => `nag_a_${sessionKey(nativeId)}_${stepIndex}`;

export const compactionId = (nativeId: string, stepIndex: number): string => `nag_k_${sessionKey(nativeId)}_${stepIndex}`;

export const partId = (nativeId: string, stepIndex: number, suffix: string): string => `nag_p_${sessionKey(nativeId)}_${stepIndex}_${suffix}`;

export const toolCallId = (nativeId: string, stepIndex: number): string => `nag_t_${sessionKey(nativeId)}_${stepIndex}`;

export const MISSING_TOOL_RESULT = 'Antigravity tool completion was not recorded';

export const commandExitCode = (output: string): number | null => {
  const match = output.match(/^Command exited with code (-?\d+)\.\r?$/m);
  return match ? Number(match[1]) : null;
};

export const shortenedOutput = (output: string): boolean => (
  /<truncated \d+(?: lines|(?: of \d+)? bytes(?: from the middle of the output)?)>/.test(output)
);

export const subagentMetadata = (info: AgySubagentInfo | null | undefined): JsonObject => {
  const nativeSubagents = agySubagentReferences(info).map((agent) => ({
    sessionID: encodeAntigravitySessionId(agent.conversation_id),
    title: agent.role || agent.type_name,
    agent: agent.type_name,
  }));
  if (nativeSubagents.length === 0) return {};
  const metadata: JsonObject = { nativeSubagents };
  const first = nativeSubagents[0];
  if (nativeSubagents.length === 1 && first) metadata.sessionId = first.sessionID;
  return metadata;
};

const emptySelection = (): AgySelection => ({ providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: '', agent: 'build' });

const selectionOf = (
  send: Pick<RegistrySendRecord, 'providerID' | 'modelID' | 'agent' | 'variant'> | null | undefined,
): AgySelection => {
  if (!send) return emptySelection();
  const selection: AgySelection = {
    providerID: send.providerID,
    modelID: send.modelID,
    agent: send.agent,
  };
  if (send.variant !== undefined) selection.variant = send.variant;
  return selection;
};

const selectionForStep = (stepIndex: number, bindings: ReadonlyMap<number, RegistrySendRecord>): AgySelection => {
  let selected: [number, RegistrySendRecord] | null = null;
  for (const [userStep, send] of bindings) {
    if (userStep <= stepIndex && (!selected || userStep >= selected[0])) selected = [userStep, send];
  }
  return selectionOf(selected?.[1]);
};

export const userRecord = ({
  sessionId,
  id,
  created,
  send,
  parts,
}: {
  sessionId: string;
  id: string;
  created: number;
  send: (Pick<RegistrySendRecord, 'providerID' | 'modelID' | 'agent' | 'variant'> & {
    antigravity?: RegistrySendRecord['antigravity'];
  }) | null | undefined;
  parts: readonly PromptPart[];
}): AgyUserRecord => {
  const selection = selectionOf(send);
  const model: NativeMessageModel = {
    providerID: selection.providerID,
    modelID: selection.modelID,
  };
  if (selection.variant !== undefined) model.variant = selection.variant;
  let textIndex = 0;
  let fileIndex = 0;
  return {
    info: buildUserMessage({
      id,
      sessionID: sessionId,
      created,
      agent: selection.agent,
      model,
    }),
    parts: send?.antigravity?.interactionReply ? [] : parts.flatMap((part): NativePart[] => {
      if (part.type === 'text') {
        if (part.text === '' || isInstructionsBlock(part.text)) return [];
        return [buildTextPart({ id: userTextPartId(id, textIndex++), sessionID: sessionId, messageID: id, text: part.text, start: created, end: created })];
      }
      return [buildFilePart({ ...part, id: userFilePartId(id, fileIndex++), sessionID: sessionId, messageID: id, filename: part.filename ?? 'attachment' })];
    }),
  };
};

export const reasoningPart = ({
  sessionId,
  nativeId,
  entry,
  time,
}: {
  sessionId: string;
  nativeId: string;
  entry: AgyTranscriptStep;
  time: number;
}): NativeReasoningPart | null => {
  const text = entry.thinking?.trim();
  if (!text) return null;
  const part = buildReasoningPart({
    id: partId(nativeId, entry.step_index, 'reasoning'),
    sessionID: sessionId,
    messageID: assistantId(nativeId, entry.step_index),
    text,
    start: time,
    end: time,
  });
  if (entry.truncated_fields?.includes('thinking')) part.metadata = { nativeOutputTruncated: true };
  return part;
};

const toolPart = ({
  sessionId,
  nativeId,
  stepIndex,
  call,
  output,
  created,
  end,
  status,
  error,
  truncated = false,
  inputTruncated = false,
  subagents,
}: {
  sessionId: string;
  nativeId: string;
  stepIndex: number;
  call: AgyTranscriptToolCall;
  output: string | undefined;
  created: number;
  end: number;
  status: string | undefined;
  error: string | undefined;
  truncated?: boolean | undefined;
  inputTruncated?: boolean | undefined;
  subagents: AgySubagentInfo | null | undefined;
}): NativeToolPart => {
  const mapped = mapAgyTool(call);
  const name = call.name;
  const exit = name === 'run_command' && output !== undefined ? commandExitCode(output) : null;
  const missing = output === undefined || status === 'RUNNING';
  const failed = status === 'ERROR' || status === 'INVALID' || (exit !== null && exit !== 0);
  const result = missing
    ? { status: 'error' as const, error: MISSING_TOOL_RESULT, end }
    : failed
      ? { status: 'error' as const, error: error || output || 'Antigravity tool failed', end }
      : { status: 'completed' as const, output, end };
  const callInputTruncated = agyToolInputTruncated(call, inputTruncated);
  const metadata: JsonObject = {
    nativeBackend: 'antigravity',
    ...mapped.metadata,
    ...subagentMetadata(subagents),
    ...agyEditMetadata(call, { completed: result.status === 'completed', inputTruncated: callInputTruncated }),
  };
  if (exit !== null) metadata.exit = exit;
  if (truncated || shortenedOutput(output ?? '')) metadata.nativeOutputTruncated = true;
  if (callInputTruncated) metadata.nativeInputTruncated = true;
  return buildToolPart({
    id: partId(nativeId, stepIndex, 'tool'),
    sessionID: sessionId,
    messageID: assistantId(nativeId, stepIndex),
    callID: toolCallId(nativeId, stepIndex),
    tool: mapped.tool,
    input: mapped.input,
    title: mapped.title,
    start: created,
    metadata,
    result,
  });
};

export const projectAntigravityHistory = ({
  sessionId,
  nativeId,
  directory,
  entries,
  bindings,
  parentSessionId = null,
  childSessionIds = [],
  contextReading = null,
  now = Date.now,
}: ProjectAntigravityHistoryInput): NativeMessageRecord[] => {
  const records: NativeMessageRecord[] = [];
  let parentID: string | null = null;
  let parentSend: RegistrySendRecord | null = null;
  let parentStep: number | null = null;
  let lastAssistant: AgyAssistantRecord | null = null;
  let lastCreated = 0;
  const created = (entry?: AgyTranscriptStep, acceptedAt?: number): number => {
    const time = acceptedAt ?? agyTime(entry?.created_at, now());
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const children = new Set(childSessionIds);
  const taskResults = agyBackgroundResults(entries, nativeId);
  const settlePermissionDenial = (): void => {
    const denial = parentSend?.antigravity?.denial;
    if (!denial) return;
    if (lastAssistant?.info.finish === 'stop' && lastAssistant.info.time.completed !== undefined
      && lastAssistant.parts.some((part) => part.type === 'text' && part.text.trim() !== '')) return;
    const message = agyPermissionError(denial.actions);
    if (!lastAssistant) {
      if (parentID === null || parentStep === null) return;
      const info = buildAssistantMessage({
        id: assistantId(nativeId, parentStep + 1),
        sessionID: sessionId,
        parentID,
        created: denial.time,
        completed: denial.time,
        ...selectionOf(parentSend),
        cwd: directory,
      });
      lastAssistant = { info, parts: [] };
      records.push(lastAssistant);
    }
    lastAssistant.info.error = unknownError(message);
    lastAssistant.info.finish = 'error';
    lastAssistant.info.time.completed = Math.max(lastAssistant.info.time.completed ?? 0, denial.time);
    for (const part of lastAssistant.parts) {
      if (part.type === 'tool' && part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT) part.state.error = message;
    }
  };
  const ensureParent = (time: number): string => {
    if (parentID !== null) return parentID;
    const fallbackParentID = `nag_u_${sessionKey(nativeId)}_context`;
    parentID = fallbackParentID;
    parentSend = null;
    records.push(userRecord({ sessionId, id: fallbackParentID, created: time - 1, send: null, parts: [] }));
    return fallbackParentID;
  };

  for (const entry of entries) {
    const message = entry.type === 'SYSTEM_MESSAGE' ? agyConversationMessage(entry.content) : null;
    const senderSessionId = message ? encodeAntigravitySessionId(message.sender) : null;
    const parentTask = message !== null && senderSessionId === parentSessionId;
    if (entry.type === 'USER_INPUT' || parentTask) {
      settlePermissionDenial();
      const send = parentTask ? null : bindings.get(entry.step_index);
      const id: string = send?.messageId ?? userId(nativeId, parentTask && parentID === null ? 'context' : entry.step_index);
      parentID = id;
      parentSend = send ?? null;
      parentStep = entry.step_index;
      lastAssistant = null;
      records.push(userRecord({
        sessionId,
        id,
        created: created(entry, send?.sentAt),
        send,
        parts: antigravityDisplayPromptParts(
          parentTask && message ? message.content : entry.content ?? '',
          send?.agent === 'plan' ? send.antigravity?.fingerprint : undefined,
        ),
      }));
      continue;
    }
    if (message && senderSessionId !== null && children.has(senderSessionId)) {
      const time = created(entry);
      const activeParentID = ensureParent(time - 1);
      const id = assistantId(nativeId, entry.step_index);
      const part = buildTextPart({
        id: partId(nativeId, entry.step_index, 'text'),
        sessionID: sessionId,
        messageID: id,
        text: message.content,
        start: time,
        end: time,
      });
      part.metadata = {
        nativeSubagentMessage: true,
        nativeSubagentSessionID: senderSessionId,
      };
      if (entry.truncated_fields?.includes('content')) part.metadata.nativeOutputTruncated = true;
      records.push({
        info: buildAssistantMessage({
          id,
          sessionID: sessionId,
          parentID: activeParentID,
          created: time,
          completed: time,
          ...selectionForStep(entry.step_index, bindings),
          cwd: directory,
          finish: 'stop',
        }),
        parts: [part],
      });
      continue;
    }
    if (entry.type === 'CHECKPOINT') {
      const time = created(entry);
      const incomplete = entry.status !== undefined && entry.status !== 'DONE';
      const info = buildCompactionMessage({
        id: compactionId(nativeId, entry.step_index),
        sessionID: sessionId,
        created: time,
        status: incomplete ? 'failed' : 'completed',
        auto: true,
        error: incomplete ? unknownError(entry.error || 'Antigravity compaction completion was not recorded') : null,
      });
      info.summary = entry.content ?? '';
      if (entry.truncated_fields?.includes('content')) info.metadata = { nativeOutputTruncated: true };
      records.push({
        info,
        parts: [buildCompactionPart({
          id: partId(nativeId, entry.step_index, 'compaction'),
          sessionID: sessionId,
          messageID: info.id,
          auto: true,
        })],
      });
      continue;
    }
    if (entry.type === 'ERROR_MESSAGE') {
      const time = created(entry);
      const activeParentID = ensureParent(time - 1);
      const errorText = (entry.error ?? entry.content ?? 'Antigravity reported an error').replace(/^Error:\s*/i, '');
      const id = assistantId(nativeId, entry.step_index);
      const send = selectionForStep(entry.step_index, bindings);
      records.push({
        info: buildAssistantMessage({
          id,
          sessionID: sessionId,
          parentID: activeParentID,
          created: time,
          completed: time,
          ...send,
          cwd: directory,
          finish: 'error',
          error: unknownError(errorText),
        }),
        parts: [buildTextPart({
          id: partId(nativeId, entry.step_index, 'error'),
          sessionID: sessionId,
          messageID: id,
          text: errorText,
          start: time,
          end: time,
          synthetic: true,
        })],
      });
      continue;
    }
    if (entry.type !== 'PLANNER_RESPONSE') continue;

    const time = created(entry);
    const activeParentID = ensureParent(time - 1);
    const id = assistantId(nativeId, entry.step_index);
    const parts: NativePart[] = [];
    const reasoning = reasoningPart({ sessionId, nativeId, entry, time });
    if (reasoning) parts.push(reasoning);
    const entryContent = entry.content ?? '';
    if (entryContent !== '') {
      const textPart = buildTextPart({
        id: partId(nativeId, entry.step_index, 'text'),
        sessionID: sessionId,
        messageID: id,
        text: entryContent,
        start: time,
        end: time,
      });
      if (entry.truncated_fields?.includes('content')) textPart.metadata = { nativeOutputTruncated: true };
      parts.push(textPart);
    }
    let completed: number | null = entry.status === 'DONE' ? time : null;
    entry.tool_calls.forEach((call, index) => {
      const stepIndex = entry.step_index + index + 1;
      const resultStep = byStep.get(stepIndex);
      const background = call.name === 'run_command' && resultStep?.type === 'GENERIC'
        && (resultStep.content ?? '').split(/\r?\n/).includes(`Tool is running as a background task with task id: ${nativeId}/task-${stepIndex}`);
      const result = (background ? taskResults.get(stepIndex) : null) ?? resultStep;
      const output = resultStep?.type === 'GENERIC' ? result?.content ?? '' : undefined;
      const nativeStart = agyTime(resultStep?.created_at, time);
      const nativeEnd = result ? agyTime(result.created_at, nativeStart) : nativeStart;
      const toolStart = Math.max(time, nativeStart);
      const resultTime = toolStart + Math.max(0, nativeEnd - nativeStart);
      const part = toolPart({
        sessionId,
        nativeId,
        stepIndex,
        call,
        output,
        created: toolStart,
        end: resultTime,
        status: result?.status,
        error: result?.error,
        truncated: result?.truncated_fields?.includes('content') === true,
        inputTruncated: entry.truncated_fields?.includes('tool_calls') === true,
        subagents: call.name === 'invoke_subagent' ? resultStep?.subagent_info ?? entry.subagent_info : null,
      });
      part.messageID = id;
      parts.push(part);
      if (output !== undefined) completed = Math.max(completed ?? 0, resultTime);
    });
    const send = parentSend ? selectionOf(parentSend) : selectionForStep(entry.step_index, bindings);
    const assistantTokens = entry.usage ? agyTokenUsage(entry.usage) : undefined;
    const assistantInfo = buildAssistantMessage({
      id,
      sessionID: sessionId,
      parentID: activeParentID,
      created: time,
      completed,
      ...send,
      cwd: directory,
      tokens: assistantTokens,
      finish: entry.tool_calls.length > 0 ? 'tool-calls' : 'stop',
    });
    lastAssistant = { info: assistantInfo, parts };
    if (contextReading?.stepIndex === entry.step_index) lastAssistant.info.contextCompaction = contextReading.budget;
    records.push(lastAssistant);
  }
  settlePermissionDenial();
  return records;
};
