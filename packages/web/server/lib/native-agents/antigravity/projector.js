import {
  NATIVE_PROVIDER_ANTIGRAVITY,
  encodeAntigravitySessionId,
  userTextPartId,
} from '../ids.js';
import {
  antigravityPromptFingerprint,
  antigravityVisiblePromptText,
  isInstructionsBlock,
} from '../prompt-parts.js';
import {
  buildAssistantMessage,
  buildCompactionMessage,
  buildCompactionPart,
  buildFilePart,
  buildTextPart,
  buildToolPart,
  buildUserMessage,
  stoppedError,
  unknownError,
} from '../records.js';
import {
  agyTime,
  agyTokenUsage,
  agySubagentReferences,
  agyPermissionError,
} from './protocol.js';
import { agyBackgroundResults } from './tasks.js';
import { mapAgyTool } from './tools.js';

const sessionKey = (nativeId) => nativeId.replaceAll('-', '');
const userId = (nativeId, stepIndex) => `nag_u_${sessionKey(nativeId)}_${stepIndex}`;
const assistantId = (nativeId, stepIndex) => `nag_a_${sessionKey(nativeId)}_${stepIndex}`;
const compactionId = (nativeId, stepIndex) => `nag_k_${sessionKey(nativeId)}_${stepIndex}`;
const partId = (nativeId, stepIndex, suffix) => `nag_p_${sessionKey(nativeId)}_${stepIndex}_${suffix}`;
const toolCallId = (nativeId, stepIndex) => `nag_t_${sessionKey(nativeId)}_${stepIndex}`;
const MISSING_TOOL_RESULT = 'Antigravity tool completion was not recorded';

const commandExitCode = (output) => {
  const match = output.match(/^Command exited with code (-?\d+)\.\r?$/m);
  return match ? Number(match[1]) : null;
};

const shortenedOutput = (output) => /<truncated \d+(?: lines|(?: of \d+)? bytes(?: from the middle of the output)?)>/.test(output);

const subagentMetadata = (info) => {
  const nativeSubagents = agySubagentReferences(info).map((agent) => ({
    sessionID: encodeAntigravitySessionId(agent.conversation_id),
    title: agent.role || agent.type_name,
    agent: agent.type_name,
  }));
  if (nativeSubagents.length === 0) return {};
  const metadata = { nativeSubagents };
  if (nativeSubagents.length === 1) metadata.sessionId = nativeSubagents[0].sessionID;
  return metadata;
};

const emptySelection = () => ({ providerID: NATIVE_PROVIDER_ANTIGRAVITY, modelID: '', agent: 'build' });

const selectionOf = (send) => {
  if (!send) return emptySelection();
  const selection = {
    providerID: send.providerID,
    modelID: send.modelID,
    agent: send.agent,
  };
  if (send.variant !== undefined) selection.variant = send.variant;
  return selection;
};

/** Resolves durable client ids first; content is only an admission-recovery hint. */
export const resolveAntigravityBindings = async ({ sessionId, entries, registry }) => {
  const sends = await registry.sendRecords(sessionId);
  const bindings = new Map();
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

const selectionForStep = (stepIndex, bindings) => {
  let selected = null;
  for (const [userStep, send] of bindings) {
    if (userStep <= stepIndex && (!selected || userStep >= selected[0])) selected = [userStep, send];
  }
  return selectionOf(selected?.[1]);
};

const userRecord = ({ sessionId, id, created, send, text }) => {
  const selection = selectionOf(send);
  const record = {
    info: buildUserMessage({
      id, sessionID: sessionId, created, agent: selection.agent,
      model: {
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
      },
    }),
    parts: [],
  };
  if (text !== '') {
    record.parts.push(buildTextPart({
      id: userTextPartId(id, 0), sessionID: sessionId, messageID: id,
      text, start: created, end: created,
    }));
  }
  return record;
};

const toolPart = ({ sessionId, nativeId, stepIndex, call, output, created, end, status, error, truncated = false, inputTruncated = false, subagents }) => {
  const mapped = mapAgyTool(call);
  const name = call.name;
  const exit = name === 'run_command' && output !== undefined ? commandExitCode(output) : null;
  const missing = output === undefined || status === 'RUNNING';
  const failed = status === 'ERROR' || (exit !== null && exit !== 0);
  const result = missing
    ? { status: 'error', error: MISSING_TOOL_RESULT, end }
    : failed
      ? { status: 'error', error: error || output || 'Antigravity tool failed', end }
      : { status: 'completed', output, end };
  const metadata = subagentMetadata(subagents);
  if (exit !== null) metadata.exit = exit;
  if (truncated || shortenedOutput(output ?? '')) metadata.nativeOutputTruncated = true;
  if (inputTruncated) metadata.nativeInputTruncated = true;
  return buildToolPart({
    id: partId(nativeId, stepIndex, 'tool'), sessionID: sessionId,
    messageID: assistantId(nativeId, stepIndex), callID: toolCallId(nativeId, stepIndex),
    tool: mapped.tool, input: mapped.input,
    title: mapped.title, start: created,
    metadata, result,
  });
};

/** Projects agy's own transcript, keeping tool results beside their planner step. */
export const projectAntigravityHistory = ({ sessionId, nativeId, directory, entries, bindings, now = Date.now }) => {
  const records = [];
  let parentID = null;
  let parentSend = null;
  let parentStep = null;
  let lastAssistant = null;
  let lastCreated = 0;
  const created = (entry) => {
    const time = agyTime(entry?.created_at, now());
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const taskResults = agyBackgroundResults(entries, nativeId);
  const settlePermissionDenial = () => {
    const denial = parentSend?.antigravity?.denial;
    if (!denial) return;
    // A complete native final response takes precedence over a saved denial.
    if (lastAssistant?.info.finish === 'stop' && lastAssistant.info.time.completed !== undefined
      && lastAssistant.parts.some((part) => part.type === 'text' && part.text.trim() !== '')) return;
    const message = agyPermissionError(denial.actions);
    if (!lastAssistant) {
      lastAssistant = {
        info: buildAssistantMessage({
          id: assistantId(nativeId, parentStep + 1), sessionID: sessionId, parentID,
          created: denial.time, completed: denial.time,
          ...selectionOf(parentSend), cwd: directory,
        }),
        parts: [],
      };
      records.push(lastAssistant);
    }
    lastAssistant.info.error = unknownError(message);
    lastAssistant.info.finish = 'error';
    lastAssistant.info.time.completed = Math.max(lastAssistant.info.time.completed ?? 0, denial.time);
    for (const part of lastAssistant.parts) {
      if (part.type === 'tool' && part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT) part.state.error = message;
    }
  };
  const ensureParent = (time) => {
    if (parentID !== null) return;
    parentID = `nag_u_${sessionKey(nativeId)}_context`;
    parentSend = null;
    records.push(userRecord({ sessionId, id: parentID, created: time - 1, send: null, text: '' }));
  };

  for (const entry of entries) {
    if (entry.type === 'USER_INPUT') {
      settlePermissionDenial();
      const send = bindings.get(entry.step_index);
      const id = send?.messageId ?? userId(nativeId, entry.step_index);
      parentID = id;
      parentSend = send ?? null;
      parentStep = entry.step_index;
      lastAssistant = null;
      records.push(userRecord({
        sessionId, id, created: created(entry), send,
        text: antigravityVisiblePromptText(entry.content ?? '', send?.agent === 'plan' ? send.antigravity?.fingerprint : undefined),
      }));
      continue;
    }
    if (entry.type === 'CHECKPOINT') {
      const time = created(entry);
      const incomplete = entry.status !== undefined && entry.status !== 'DONE';
      const info = buildCompactionMessage({
        id: compactionId(nativeId, entry.step_index), sessionID: sessionId,
        created: time, status: incomplete ? 'failed' : 'completed', auto: true,
        error: incomplete ? unknownError(entry.error || 'Antigravity compaction completion was not recorded') : null,
      });
      info.summary = entry.content ?? '';
      records.push({
        info,
        parts: [buildCompactionPart({
          id: partId(nativeId, entry.step_index, 'compaction'), sessionID: sessionId,
          messageID: info.id, auto: true,
        })],
      });
      continue;
    }
    if (entry.type === 'ERROR_MESSAGE') {
      const time = created(entry);
      ensureParent(time - 1);
      const message = (entry.error ?? entry.content ?? 'Antigravity reported an error').replace(/^Error:\s*/i, '');
      const id = assistantId(nativeId, entry.step_index);
      const send = selectionForStep(entry.step_index, bindings);
      records.push({
        info: buildAssistantMessage({
          id, sessionID: sessionId, parentID, created: time, completed: time,
          ...send, cwd: directory, finish: 'error', error: unknownError(message),
        }),
        parts: [buildTextPart({
          id: partId(nativeId, entry.step_index, 'error'), sessionID: sessionId,
          messageID: id, text: message, start: time, end: time, synthetic: true,
        })],
      });
      continue;
    }
    if (entry.type !== 'PLANNER_RESPONSE') continue;

    const time = created(entry);
    ensureParent(time - 1);
    const id = assistantId(nativeId, entry.step_index);
    const parts = [];
    if ((entry.content ?? '') !== '') {
      const textPart = buildTextPart({
        id: partId(nativeId, entry.step_index, 'text'), sessionID: sessionId,
        messageID: id, text: entry.content, start: time, end: time,
      });
      if (entry.truncated_fields?.includes('content')) textPart.metadata = { nativeOutputTruncated: true };
      parts.push(textPart);
    }
    let completed = entry.status === 'DONE' ? time : null;
    entry.tool_calls.forEach((call, index) => {
      const stepIndex = entry.step_index + index + 1;
      const resultStep = byStep.get(stepIndex);
      const background = call.name === 'run_command' && resultStep?.type === 'GENERIC'
        && (resultStep.content ?? '').split(/\r?\n/).includes(`Tool is running as a background task with task id: ${nativeId}/task-${stepIndex}`);
      const result = (background ? taskResults.get(stepIndex) : null) ?? resultStep;
      const output = resultStep?.type === 'GENERIC' ? result?.content ?? '' : undefined;
      const resultTime = result ? agyTime(result.created_at, time) : time;
      const part = toolPart({
        sessionId, nativeId, stepIndex,
        call, output, created: agyTime(resultStep?.created_at, time), end: resultTime,
        status: result?.status, error: result?.error,
        truncated: result?.truncated_fields?.includes('content') === true,
        inputTruncated: entry.truncated_fields?.includes('tool_calls') === true,
        subagents: call.name === 'invoke_subagent' ? resultStep?.subagent_info ?? entry.subagent_info : null,
      });
      part.messageID = id;
      parts.push(part);
      if (output !== undefined) completed = Math.max(completed ?? 0, resultTime);
    });
    const send = parentSend ? selectionOf(parentSend) : selectionForStep(entry.step_index, bindings);
    lastAssistant = {
      info: buildAssistantMessage({
        id, sessionID: sessionId, parentID, created: time, completed,
        ...send, cwd: directory,
        tokens: entry.usage ? agyTokenUsage(entry.usage) : undefined,
        finish: entry.tool_calls.length > 0 ? 'tool-calls' : 'stop',
      }),
      parts,
    };
    records.push(lastAssistant);
  }
  settlePermissionDenial();
  return records;
};

const liveUserParts = ({ sessionId, messageID, parts, created }) => {
  let textIndex = 0;
  let fileIndex = 0;
  return parts.flatMap((part) => {
    if (part.type === 'text') {
      if (part.text === '' || isInstructionsBlock(part.text)) return [];
      const id = userTextPartId(messageID, textIndex);
      textIndex += 1;
      return [buildTextPart({ id, sessionID: sessionId, messageID, text: part.text, start: created, end: created })];
    }
    const id = `${messageID}_f${fileIndex}`;
    fileIndex += 1;
    return [buildFilePart({
      id, sessionID: sessionId, messageID,
      mime: part.mime, url: part.url, filename: part.filename ?? 'attachment',
    })];
  });
};

/** One live turn. Native step indexes keep these records identical to history. */
export const createAntigravityLiveProjection = ({ sessionId, nativeId, directory, publisher, request }) => {
  let lastCreated = 0;
  const created = (time) => {
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  const records = new Map();
  const tools = new Map();
  const unfinishedTools = new Set();
  let currentAssistant = null;
  let currentText = null;
  let userStepIndex = null;
  const selection = {
    providerID: request.model.providerID,
    modelID: request.model.modelID,
    agent: request.agent,
    ...(request.variant !== undefined ? { variant: request.variant } : {}),
  };
  const user = userRecord({
    sessionId, id: request.messageID, created: created(request.sentAt),
    send: {
      providerID: request.model.providerID,
      modelID: request.model.modelID,
      agent: request.agent,
      ...(request.variant !== undefined ? { variant: request.variant } : {}),
    },
    text: '',
  });
  user.parts = liveUserParts({
    sessionId, messageID: request.messageID, parts: request.parts, created: user.info.time.created,
  });
  records.set(user.info.id, user);

  const publish = (record) => publisher.records(directory, sessionId, [record]);
  const rememberHistoricalTool = (part) => {
    if (part.type !== 'tool') return;
    tools.set(part.id, part);
    if (part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT) unfinishedTools.add(part.id);
  };
  const ensureAssistant = (stepIndex, time) => {
    const id = assistantId(nativeId, stepIndex);
    let record = records.get(id);
    if (record) return record;
    record = {
      info: buildAssistantMessage({
        id, sessionID: sessionId, parentID: request.messageID, created: created(time), completed: null,
        ...selection, cwd: directory,
      }),
      parts: [],
    };
    records.set(id, record);
    return record;
  };
  const appendResponseText = (stepIndex, delta, state, usage, time) => {
    const record = ensureAssistant(stepIndex, time);
    currentAssistant = record;
    let part = record.parts.find((candidate) => candidate.type === 'text');
    if (!part) {
      part = buildTextPart({
        id: partId(nativeId, stepIndex, 'text'), sessionID: sessionId, messageID: record.info.id,
        text: '', start: created(time), end: null,
      });
      record.parts.push(part);
    }
    currentText = part;
    if (delta !== '') {
      part.text += delta;
      publisher.delta(directory, {
        sessionID: sessionId, messageID: record.info.id, partID: part.id, field: 'text', delta,
      });
    }
    if (state === 'DONE' || state === 'ERROR') {
      part.time.end = created(time);
      record.info.time.completed = part.time.end;
      if (usage) record.info.tokens = agyTokenUsage(usage);
      record.info.finish = 'stop';
    }
    publish(record);
  };

  return {
    records() {
      return [...records.values()];
    },

    restoreMissingHistory(history) {
      const start = history.findIndex((record) => record.info.id === request.messageID);
      if (start === -1) return;
      for (const historical of history.slice(start + 1)) {
        if (historical.info.role === 'user') break;
        const live = records.get(historical.info.id);
        if (!live) {
          records.set(historical.info.id, historical);
          historical.parts.forEach(rememberHistoricalTool);
          publish(historical);
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
        const recovered = (part) => unfinishedTools.has(part.id) && part.type === 'tool'
          && !(part.state.status === 'error' && part.state.error === MISSING_TOOL_RESULT);
        const known = new Set(historical.parts.map((part) => part.id));
        let changed = false;
        // Some generation frames omit usage even though the completed native
        // step has it. Keep measured live timing and counters already received.
        if (live.info.role === 'assistant' && historical.info.role === 'assistant'
          && live.info.tokens === undefined && historical.info.tokens !== undefined) {
          live.info.tokens = structuredClone(historical.info.tokens);
          changed = true;
        }
        const parts = historical.parts.map((part) => {
          const held = liveParts.get(part.id);
          if (recovered(part)) {
            changed = true;
            unfinishedTools.delete(part.id);
            tools.set(part.id, part);
            return part;
          }
          if (!held) { changed = true; rememberHistoricalTool(part); return part; }
          if (part.type === 'tool' && held.type === 'tool' && !part.state.metadata?.nativeInputTruncated) {
            const input = { ...held.state.input, ...part.state.input };
            if (held.tool !== part.tool || JSON.stringify(input) !== JSON.stringify(held.state.input)) {
              changed = true;
              const enriched = { ...held, tool: part.tool, state: { ...held.state, input } };
              tools.set(part.id, enriched);
              return enriched;
            }
          }
          return held;
        })
          .concat(live.parts.filter((part) => !known.has(part.id)));
        if (!changed) continue;
        live.parts = parts;
        publish(live);
      }
    },

    userStepIndex() {
      return userStepIndex;
    },

    async applyStep(step, time, bindUserStep) {
      if (step.step_type === 'user_input') {
        userStepIndex = step.step_index;
        await bindUserStep(step.step_index);
        publish(user);
        return;
      }
      if (step.step_type === 'agent_response') {
        appendResponseText(step.step_index, step.text_delta, step.state, step.usage, time);
        return;
      }
      if (step.step_type === 'checkpoint') {
        const timeCreated = created(time);
        const info = buildCompactionMessage({
          id: compactionId(nativeId, step.step_index), sessionID: sessionId,
          created: timeCreated, status: step.state === 'DONE' ? 'completed' : step.state === 'ERROR' ? 'failed' : 'running', auto: true,
          error: step.state === 'ERROR' ? unknownError(step.tool_info?.error?.message ?? 'Antigravity compaction failed') : null,
        });
        const record = {
          info,
          parts: [buildCompactionPart({
            id: partId(nativeId, step.step_index, 'compaction'), sessionID: sessionId,
            messageID: info.id, auto: true,
          })],
        };
        records.set(info.id, record);
        publish(record);
        return;
      }
      if (step.step_type !== 'tool' && step.step_type !== 'subagent') return;
      const parentStep = currentAssistant
        ? Number(currentAssistant.info.id.split('_').at(-1))
        : Math.max(0, step.step_index - 1);
      const assistant = ensureAssistant(parentStep, time);
      currentAssistant = assistant;
      const id = partId(nativeId, step.step_index, 'tool');
      const previous = tools.get(id) ?? assistant.parts.find((part) => part.id === id);
      if (previous && previous.state.status !== 'running') return;
      const info = step.tool_info ?? { name: step.tool_name || 'Antigravity tool', parameters: {}, output: '', error: null };
      const call = { name: info.name || step.tool_name, args: info.parameters, argumentsEncoded: false };
      const mapped = mapAgyTool(call);
      const exit = call.name === 'run_command' ? commandExitCode(info.output) : null;
      const failed = step.state === 'ERROR' || info.error !== null || (exit !== null && exit !== 0);
      const start = previous?.state.time.start ?? created(time);
      const result = step.state === 'ACTIVE' || step.state === 'RUNNING'
        ? null
        : failed
          ? { status: 'error', error: info.error?.message ?? (info.output || 'Antigravity tool failed'), end: created(time) }
          : { status: 'completed', output: info.output, end: created(time) };
      const metadata = subagentMetadata(step.subagent_info);
      if (exit !== null) metadata.exit = exit;
      if (shortenedOutput(info.output)) metadata.nativeOutputTruncated = true;
      const part = buildToolPart({
        id, sessionID: sessionId, messageID: assistant.info.id,
        callID: toolCallId(nativeId, step.step_index),
        tool: step.step_type === 'subagent' ? 'task' : mapped.tool,
        input: mapped.input, title: mapped.title, start,
        metadata, result,
      });
      const index = assistant.parts.findIndex((candidate) => candidate.id === id);
      if (index === -1) assistant.parts.push(part);
      else assistant.parts[index] = part;
      tools.set(id, part);
      publish(assistant);
    },

    finish({ outcome, response, error, time, responseStep = null }) {
      const settledAt = created(time);
      if (responseStep !== null) {
        currentAssistant = ensureAssistant(responseStep.step_index, time);
        currentText = currentAssistant.parts.find((part) => part.type === 'text') ?? null;
        if (responseStep.usage) currentAssistant.info.tokens = agyTokenUsage(responseStep.usage);
      }
      if (!currentAssistant) currentAssistant = ensureAssistant((userStepIndex ?? 0) + 1, time);
      if (response !== '') {
        if (!currentText) {
          currentText = currentAssistant.parts.find((part) => part.type === 'text') ?? null;
        }
        if (!currentText) {
          currentText = buildTextPart({
            id: partId(nativeId, Number(currentAssistant.info.id.split('_').at(-1)), 'text'),
            sessionID: sessionId, messageID: currentAssistant.info.id,
            text: '', start: settledAt, end: null,
          });
          currentAssistant.parts.push(currentText);
        }
        if (currentText.text !== response) {
          const delta = response.startsWith(currentText.text) ? response.slice(currentText.text.length) : null;
          currentText.text = response;
          if (delta !== null && delta !== '') publisher.delta(directory, {
            sessionID: sessionId, messageID: currentAssistant.info.id, partID: currentText.id, field: 'text', delta,
          });
        }
      }
      for (const part of tools.values()) {
        if (part.state.status !== 'running') continue;
        unfinishedTools.add(part.id);
        part.state = { status: 'error', input: part.state.input, error: outcome === 'success' ? MISSING_TOOL_RESULT : outcome === 'aborted' ? 'Interrupted' : error, metadata: part.state.metadata, time: { start: part.state.time.start, end: settledAt } };
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
        if (outcome !== 'success' && record === currentAssistant) {
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
