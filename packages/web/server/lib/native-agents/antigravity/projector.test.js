import { describe, expect, it } from 'vitest';
import { createAntigravityLiveProjection, projectAntigravityHistory, resolveAntigravityBindings } from './projector.js';
import { parseAgyTranscript } from './protocol.js';
import { createNativeEventPublisher } from '../publisher.js';
import { antigravityPromptFingerprint } from '../prompt-parts.js';

const NATIVE_ID = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const project = (steps, bindings = new Map()) => projectAntigravityHistory({
  sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo', bindings,
  entries: parseAgyTranscript(`${steps.map((step) => JSON.stringify({ status: 'DONE', created_at: '2026-10-31T02:00:00Z', ...step })).join('\n')}\n`).entries,
});
const completion = (nativeId, exit) => `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-31T02:01:00Z sender=${nativeId}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${nativeId}/task-2" finished with result:\nCommand exited with code ${exit}.\n\nCommand output:\nBuild result\nLog: file:///untrusted/task-2.log\n</SYSTEM_MESSAGE>`;

describe('Antigravity native plan prefix', () => {
  it.each([
    ['plan', 'Review the code', '/plan Review the code', 'Review the code'],
    ['plan', '/plan Review the code', '/plan /plan Review the code', '/plan Review the code'],
    ['plan', '/plan Review the code', '/plan Review the code', '/plan Review the code'],
    ['build', '/plan Review the code', '/plan Review the code', '/plan Review the code'],
    ['plan', 'A different prompt', '/plan Review the code', '/plan Review the code'],
    ['plan', '', '/plan', ''],
  ])('projects %s mode original %j and stored %j as %j', (agent, original, stored, expected) => {
    const send = { messageId: 'client-message', providerID: 'antigravity-native', modelID: 'gemini-test', agent,
      antigravity: { stepIndex: 0, fingerprint: antigravityPromptFingerprint(original) } };
    const records = project([{ step_index: 0, type: 'USER_INPUT', content: stored }], new Map([[0, send]]));
    expect(records[0].info).toMatchObject({ id: send.messageId, agent });
    expect(records[0].parts.map((part) => part.text).join('')).toBe(expected);
  });

  it('preserves an external prompt without matching send authority', () => {
    expect(project([{ step_index: 0, type: 'USER_INPUT', content: '/plan Review the code' }])[0].parts[0].text).toBe('/plan Review the code');
  });

  it('recovers a Plan admission whose native history added the prefix', async () => {
    const send = { messageId: 'client-message', providerID: 'antigravity-native', modelID: 'gemini-test', agent: 'plan',
      antigravity: { fingerprint: antigravityPromptFingerprint('Review the code') } };
    const calls = [];
    const { bindings } = await resolveAntigravityBindings({ sessionId: `nag_${NATIVE_ID}`,
      entries: [{ step_index: 0, type: 'USER_INPUT', content: '/plan Review the code' }],
      registry: { sendRecords: async () => new Map([[send.messageId, send]]), bindAntigravityMessage: async (...args) => { calls.push(args); } },
    });
    expect(bindings.get(0)?.messageId).toBe(send.messageId);
    expect(calls).toEqual([[`nag_${NATIVE_ID}`, send.messageId, 0]]);
  });

  it('does not apply Plan prefix recovery to a Build send', async () => {
    const send = { messageId: 'client-message', providerID: 'antigravity-native', modelID: 'gemini-test', agent: 'build',
      antigravity: { fingerprint: antigravityPromptFingerprint('Review the code') } };
    const calls = [];
    const { bindings } = await resolveAntigravityBindings({ sessionId: `nag_${NATIVE_ID}`,
      entries: [{ step_index: 0, type: 'USER_INPUT', content: '/plan Review the code' }],
      registry: { sendRecords: async () => new Map([[send.messageId, send]]), bindAntigravityMessage: async (...args) => { calls.push(args); } },
    });
    expect(bindings.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('prefers a literal submitted prefix over a transformed Plan candidate', async () => {
    const planned = { messageId: 'planned', agent: 'plan', antigravity: { fingerprint: antigravityPromptFingerprint('Review the code') } };
    const literal = { messageId: 'literal', agent: 'build', antigravity: { fingerprint: antigravityPromptFingerprint('/plan Review the code') } };
    const { bindings } = await resolveAntigravityBindings({ sessionId: `nag_${NATIVE_ID}`,
      entries: [{ step_index: 0, type: 'USER_INPUT', content: '/plan Review the code' }],
      registry: { sendRecords: async () => new Map([[planned.messageId, planned], [literal.messageId, literal]]), bindAntigravityMessage: async () => {} },
    });
    expect(bindings.get(0)?.messageId).toBe(literal.messageId);
  });
});

describe('Antigravity saved tool outcomes', () => {
  it('scopes a saved permission denial to its turn and accepts a later native final response', () => {
    const send = { messageId: 'client-message', providerID: 'antigravity-native', modelID: 'gemini-test', agent: 'plan',
      antigravity: { stepIndex: 0, denial: { actions: ['read_file'], time: 1000 } } };
    const entries = [
      { step_index: 0, type: 'USER_INPUT', content: 'Read' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: {} }] },
      { step_index: 3, type: 'USER_INPUT', content: 'Continue' },
      { step_index: 4, type: 'PLANNER_RESPONSE', content: 'New answer' },
    ];
    const render = (steps) => projectAntigravityHistory({
      sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo', bindings: new Map([[0, send]]),
      entries: parseAgyTranscript(steps.map((step) => JSON.stringify({ status: 'DONE', ...step })).join('\n') + '\n').entries,
    });
    const records = render(entries);
    expect(records[1].info).toMatchObject({ parentID: send.messageId, finish: 'error', error: { data: { message: expect.stringContaining('read_file') } } });
    expect(records[1].parts[0].state.error).toContain('Interactive permission approvals are unavailable');
    expect(records.at(-1).info.error).toBeUndefined();
    const recovered = render([...entries.slice(0, 2), { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Complete saved answer' }, ...entries.slice(2)]);
    expect(recovered.find((record) => record.parts.some((part) => part.type === 'text' && part.text === 'Complete saved answer')).info.error).toBeUndefined();
    expect(recovered.every((record) => record.info.error === undefined)).toBe(true);
    const missingPlanner = render(entries.filter((entry) => entry.step_index !== 1));
    expect(missingPlanner[1].info).toMatchObject({ parentID: send.messageId, finish: 'error' });
    expect(missingPlanner.at(-1).info.error).toBeUndefined();
  });

  it.each([0, 2])('restores background command exit %s on the original tool', (exit) => {
    const records = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Build' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"build"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Created At: earlier\r\nTool is running as a background task with task id: ${NATIVE_ID}/task-2\r\nTask Description: build` },
      { step_index: 3, type: 'SYSTEM_MESSAGE', created_at: '2026-10-31T02:01:00Z', content: completion(NATIVE_ID, exit) },
    ]);
    const part = records[1].parts[0];
    expect(part.state.status).toBe(exit === 0 ? 'completed' : 'error');
    expect(part.state.output ?? part.state.error).toBe(`Command exited with code ${exit}.\n\nCommand output:\nBuild result`);
    expect(part.state.metadata.exit).toBe(exit);
    expect(part.state.time.end - part.state.time.start).toBe(60_000);
    expect(JSON.stringify(part)).not.toContain('untrusted');
  });

  it('does not call unfinished history running or accept another conversation task result', () => {
    const records = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Build' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: {} }] },
      { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${NATIVE_ID}/task-2\n` },
      { step_index: 3, type: 'SYSTEM_MESSAGE', content: completion('01a0d2a6-b55b-7162-a837-c62053537e00', 0) },
    ]);
    expect(records[1].parts[0].state).toMatchObject({ status: 'error', error: 'Antigravity tool completion was not recorded' });
  });

  it('preserves native errors and tool-level truncation without a truncated_fields flag', () => {
    const records = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Read' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: {} }, { name: 'run_command', args: {} }] },
      { step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'file does not exist' },
      { step_index: 3, type: 'GENERIC', content: 'Command exited with code 0.\n<truncated 100 of 200 bytes from the middle of the output>' },
    ]);
    expect(records[1].parts[0].state).toMatchObject({ status: 'error', error: 'file does not exist' });
    expect(records[1].parts[1].state).toMatchObject({ status: 'completed', metadata: { nativeOutputTruncated: true, exit: 0 } });
  });
});

describe('Antigravity final response reconciliation', () => {
  it.each([0, 40])('recovers missing saved usage while preserving live timing and known output %s', async (output) => {
    const events = [];
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) }),
      request: { messageID: `nag_u_${NATIVE_ID.replaceAll('-', '')}_0`, sentAt: 1000, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Working' }, 2000, async () => {});
    await projection.applyStep({ step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Final' }, 3000, async () => {});
    await projection.applyStep({ step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: ' answer',
      usage: { input_tokens: 20, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0 },
    }, 4000, async () => {});
    projection.finish({ outcome: 'success', response: 'Final answer', error: '', time: 5000 });
    const assistants = projection.records().filter((record) => record.info.role === 'assistant');
    expect(assistants[0].info.tokens).toBeUndefined();
    const original = structuredClone(assistants);
    const history = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Work' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Working', input_tokens: 100, output_tokens: 30, thinking_tokens: 10, cache_read_tokens: 50 },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Final answer', input_tokens: 250, output_tokens: 140, thinking_tokens: 5, cache_read_tokens: 150 },
    ]);
    const before = events.length;
    projection.restoreMissingHistory(history);
    expect(assistants[0].info.tokens).toMatchObject({ input: 100, output: 30, reasoning: 10, cache: { read: 50, write: 0 } });
    expect(assistants[1].info.tokens).toEqual(original[1].info.tokens);
    expect(assistants.map((record) => record.info.time)).toEqual(original.map((record) => record.info.time));
    expect(assistants.map((record) => record.parts)).toEqual(original.map((record) => record.parts));
    expect(events.slice(before).map((event) => event.payload.type)).toEqual(['message.updated']);
    const settled = events.length;
    projection.restoreMissingHistory(history);
    expect(events).toHaveLength(settled);
  });

  it('keeps usage unknown when neither stream nor saved history reports it', async () => {
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
      request: { messageID: `nag_u_${NATIVE_ID.replaceAll('-', '')}_0`, sentAt: 1000, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Done' }, 2000, async () => {});
    projection.finish({ outcome: 'success', response: 'Done', error: '', time: 3000 });
    projection.restoreMissingHistory(project([
      { step_index: 0, type: 'USER_INPUT', content: 'Work' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Done' },
    ]));
    expect(projection.records().find((record) => record.info.role === 'assistant').info.tokens).toBeUndefined();
  });

  it('keeps a tool first observed at completion inside a valid time interval', async () => {
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
      request: { messageID: 'user', sentAt: 1000, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file',
      tool_info: { name: 'read_file', parameters: { Path: '/repo/file' }, output: 'Done', error: null },
    }, 2000, async () => {});
    projection.finish({ outcome: 'success', response: 'Done', error: '', time: 3000 });
    const record = projection.records().find((candidate) => candidate.parts.some((part) => part.type === 'tool'));
    const tool = record.parts.find((part) => part.type === 'tool');
    expect(tool.state.time.start).toBeGreaterThanOrEqual(record.info.time.created);
    expect(tool.state.time.end).toBeGreaterThanOrEqual(tool.state.time.start);
    expect(tool.state.time.end).toBeLessThanOrEqual(record.info.time.completed);
  });

  it('recovers a completed compaction summary instead of retaining a running stream placeholder', async () => {
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
      request: { messageID: `nag_u_${NATIVE_ID.replaceAll('-', '')}_0`, sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 3, step_type: 'checkpoint', state: 'ACTIVE' }, 2, async () => {});
    projection.finish({ outcome: 'success', response: 'Done', error: '', time: 3 });
    expect(projection.records().find((record) => record.info.role === 'compaction').info.status).toBe('failed');
    projection.restoreMissingHistory(project([
      { step_index: 0, type: 'USER_INPUT', content: 'Work' },
      { step_index: 3, type: 'CHECKPOINT', content: 'Complete saved summary' },
    ]));
    expect(projection.records().find((record) => record.info.role === 'compaction').info).toMatchObject({ status: 'completed', summary: 'Complete saved summary' });
    expect(projection.records().find((record) => record.info.role === 'compaction').info.error).toBeUndefined();
  });

  it('fills partial streamed arguments from complete history without republishing unchanged records', async () => {
    const events = [];
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) }),
      request: { messageID: `nag_u_${NATIVE_ID.replaceAll('-', '')}_0`, sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'plan', parts: [] },
    });
    await projection.applyStep({ step_index: 2, step_type: 'tool', state: 'ERROR', tool_name: 'edit_file',
      tool_info: { name: 'edit_file', parameters: { Path: '/repo/file.txt' }, output: '', error: { type: 'TOOL_ERROR', message: 'Permission denied' } },
    }, 2, async () => {});
    const history = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Plan' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: '/repo/file.txt', Target: 'before', Replacement: 'after' } }] },
      { step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'Permission denied' },
    ]);
    projection.restoreMissingHistory(history);
    const part = projection.records().flatMap((record) => record.parts).find((part) => part.type === 'tool');
    expect(part).toMatchObject({ tool: 'edit', state: { status: 'error', error: 'Permission denied', input: { filePath: '/repo/file.txt', oldString: 'before', newString: 'after' } } });
    const before = events.length;
    projection.restoreMissingHistory(history);
    expect(events.length).toBe(before);
  });

  it('does not invent success for a missing tool result and recovers a later durable completion', async () => {
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
      request: { messageID: `nag_u_${NATIVE_ID.replaceAll('-', '')}_0`, sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'build' }, output: '', error: null } }, 2, async () => {});
    projection.finish({ outcome: 'success', response: 'Finished', error: '', time: 3 });
    expect(projection.records().flatMap((record) => record.parts).find((part) => part.type === 'tool').state.status).toBe('error');
    const history = project([
      { step_index: 0, type: 'USER_INPUT', content: 'Build' },
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'build' } }] },
      { step_index: 2, type: 'GENERIC', content: 'Command exited with code 0.\nSaved result' },
    ]);
    projection.restoreMissingHistory(history);
    expect(projection.records().flatMap((record) => record.parts).find((part) => part.type === 'tool').state).toMatchObject({ status: 'completed', output: 'Command exited with code 0.\nSaved result' });
  });

  it('keeps a running command open until its nonzero completion arrives', async () => {
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${NATIVE_ID}`, nativeId: NATIVE_ID, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: () => {} }),
      request: { messageID: 'user', sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    const tool = { step_index: 2, step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'build' }, output: 'Started', error: null },
    };
    await projection.applyStep({ ...tool, state: 'RUNNING' }, 2, async () => {});
    expect(projection.records().at(-1).parts[0].state.status).toBe('running');
    const output = 'Command exited with code 2.\n<truncated 100 of 200 bytes from the middle of the output>';
    await projection.applyStep({ ...tool, state: 'DONE', tool_info: { ...tool.tool_info, output } }, 3, async () => {});
    expect(projection.records().at(-1).parts[0].state).toMatchObject({ status: 'error', error: output, metadata: { exit: 2, nativeOutputTruncated: true } });
    await projection.applyStep({ ...tool, state: 'RUNNING' }, 4, async () => {});
    expect(projection.records().at(-1).parts[0].state.status).toBe('error');
  });

  it.each(['Complete answer', 'Corrected final response'])('reconciles %s without replaying an existing prefix', async (response) => {
    const events = [];
    const nativeId = 'f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
    const projection = createAntigravityLiveProjection({ sessionId: `nag_${nativeId}`, nativeId, directory: '/repo',
      publisher: createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event) }),
      request: { messageID: 'user', sentAt: 1, model: { providerID: 'antigravity-native', modelID: 'gemini-test' }, agent: 'build', parts: [] },
    });
    await projection.applyStep({ step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Complete' }, 2, async () => {});
    const previous = events.length;
    projection.finish({ outcome: 'success', response, error: '', time: 3 });
    projection.finish({ outcome: 'success', response, error: '', time: 4 });
    expect(projection.records().at(-1).parts[0].text).toBe(response);
    const deltas = events.slice(previous).filter((event) => event.payload.type === 'message.part.delta').map((event) => event.payload.properties.delta);
    expect(deltas).toEqual(response.startsWith('Complete') ? [' answer'] : []);
  });
});
