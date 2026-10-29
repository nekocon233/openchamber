import {
  NATIVE_PROVIDER_ANTIGRAVITY,
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
  decodeAgyToolArguments,
} from './protocol.js';

const sessionKey = (nativeId) => nativeId.replaceAll('-', '');
const userId = (nativeId, stepIndex) => `nag_u_${sessionKey(nativeId)}_${stepIndex}`;
const assistantId = (nativeId, stepIndex) => `nag_a_${sessionKey(nativeId)}_${stepIndex}`;
const compactionId = (nativeId, stepIndex) => `nag_k_${sessionKey(nativeId)}_${stepIndex}`;
const partId = (nativeId, stepIndex, suffix) => `nag_p_${sessionKey(nativeId)}_${stepIndex}_${suffix}`;
const toolCallId = (nativeId, stepIndex) => `nag_t_${sessionKey(nativeId)}_${stepIndex}`;

const nativeToolNames = {
  run_command: 'bash',
  view_file: 'read',
  write_to_file: 'write',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  invoke_subagent: 'task',
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
    const candidate = [...sends.values()].find((send) => (
      send.antigravity?.fingerprint === fingerprint
      && send.antigravity.stepIndex === undefined
      && !claimed.has(send.messageId)
    ));
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

const toolPart = ({ sessionId, nativeId, stepIndex, call, output, created, settled }) => {
  const { parameters, title } = decodeAgyToolArguments(call.args);
  const name = call.name;
  const result = output === undefined
    ? settled
      ? { status: 'error', error: 'Interrupted', end: created }
      : null
    : { status: 'completed', output, end: created };
  return buildToolPart({
    id: partId(nativeId, stepIndex, 'tool'), sessionID: sessionId,
    messageID: assistantId(nativeId, stepIndex), callID: toolCallId(nativeId, stepIndex),
    tool: nativeToolNames[name] ?? name, input: parameters,
    title: title ?? name, start: created, metadata: {}, result,
  });
};

/** Projects agy's own transcript, keeping tool results beside their planner step. */
export const projectAntigravityHistory = ({ sessionId, nativeId, directory, entries, bindings, now = Date.now }) => {
  const records = [];
  let parentID = null;
  let parentSend = null;
  let lastCreated = 0;
  const created = (entry) => {
    const time = agyTime(entry?.created_at, now());
    lastCreated = Math.max(time, lastCreated + 1);
    return lastCreated;
  };
  const byStep = new Map(entries.map((entry) => [entry.step_index, entry]));
  const ensureParent = (time) => {
    if (parentID !== null) return;
    parentID = `nag_u_${sessionKey(nativeId)}_context`;
    parentSend = null;
    records.push(userRecord({ sessionId, id: parentID, created: time - 1, send: null, text: '' }));
  };

  for (const entry of entries) {
    if (entry.type === 'USER_INPUT') {
      const send = bindings.get(entry.step_index);
      const id = send?.messageId ?? userId(nativeId, entry.step_index);
      parentID = id;
      parentSend = send ?? null;
      records.push(userRecord({
        sessionId, id, created: created(entry), send,
        text: antigravityVisiblePromptText(entry.content ?? ''),
      }));
      continue;
    }
    if (entry.type === 'CHECKPOINT') {
      const time = created(entry);
      const info = buildCompactionMessage({
        id: compactionId(nativeId, entry.step_index), sessionID: sessionId,
        created: time, status: 'completed', auto: true,
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
      parts.push(buildTextPart({
        id: partId(nativeId, entry.step_index, 'text'), sessionID: sessionId,
        messageID: id, text: entry.content, start: time, end: time,
      }));
    }
    let completed = entry.status === 'DONE' ? time : null;
    entry.tool_calls.forEach((call, index) => {
      const resultStep = byStep.get(entry.step_index + index + 1);
      const output = resultStep?.type === 'GENERIC' ? resultStep.content ?? '' : undefined;
      const resultTime = resultStep ? agyTime(resultStep.created_at, time) : time;
      const part = toolPart({
        sessionId, nativeId, stepIndex: entry.step_index + index + 1,
        call, output, created: resultTime, settled: true,
      });
      part.messageID = id;
      parts.push(part);
      if (output !== undefined) completed = Math.max(completed ?? 0, resultTime);
    });
    const send = parentSend ? selectionOf(parentSend) : selectionForStep(entry.step_index, bindings);
    records.push({
      info: buildAssistantMessage({
        id, sessionID: sessionId, parentID, created: time, completed,
        ...send, cwd: directory,
        tokens: entry.usage ? agyTokenUsage(entry.usage) : undefined,
        finish: entry.tool_calls.length > 0 ? 'tool-calls' : 'stop',
      }),
      parts,
    });
  }
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
          created: timeCreated, status: step.state === 'DONE' ? 'completed' : 'running', auto: true,
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
      const call = { name: info.name || step.tool_name, args: info.parameters };
      const { parameters, title } = decodeAgyToolArguments(call.args);
      const failed = step.state === 'ERROR' || info.error !== null;
      const result = step.state === 'ACTIVE'
        ? null
        : failed
          ? { status: 'error', error: info.error?.message ?? 'Antigravity tool failed', end: created(time) }
          : { status: 'completed', output: info.output, end: created(time) };
      const part = buildToolPart({
        id, sessionID: sessionId, messageID: assistant.info.id,
        callID: toolCallId(nativeId, step.step_index),
        tool: step.step_type === 'subagent' ? 'task' : nativeToolNames[call.name] ?? call.name,
        input: parameters, title: title ?? call.name, start: previous?.state.time.start ?? created(time),
        metadata: step.subagent_info ?? {}, result,
      });
      const index = assistant.parts.findIndex((candidate) => candidate.id === id);
      if (index === -1) assistant.parts.push(part);
      else assistant.parts[index] = part;
      tools.set(id, part);
      publish(assistant);
    },

    finish({ outcome, response, error, time }) {
      const settledAt = created(time);
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
        if (currentText.text === '') {
          currentText.text = response;
          publisher.delta(directory, {
            sessionID: sessionId, messageID: currentAssistant.info.id, partID: currentText.id, field: 'text', delta: response,
          });
        }
      }
      for (const part of tools.values()) {
        if (part.state.status !== 'running') continue;
        part.state = outcome === 'success'
          ? { status: 'completed', input: part.state.input, output: '', title: part.state.title, metadata: part.state.metadata, time: { start: part.state.time.start, end: settledAt } }
          : { status: 'error', input: part.state.input, error: outcome === 'aborted' ? 'Interrupted' : error, metadata: part.state.metadata, time: { start: part.state.time.start, end: settledAt } };
      }
      for (const record of records.values()) {
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
