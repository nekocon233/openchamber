import { describe, expect, it } from 'vitest';
import { createDeepseekProjection } from './projector.js';
import { encodeDeepseekSessionId } from '../ids.js';
import { createNativeEventPublisher } from '../publisher.js';
import { getLatestCompletedTurnStats } from '@openchamber/ui/components/chat/work-status/telemetry';

const sessionId = encodeDeepseekSessionId('session-test');
const userMessageId = `ndh_u_${sessionId.slice(4, 28)}_00000000-0000-4000-8000-000000000001`;
const setup = (agent = 'build') => {
  const events = [];
  const publisher = createNativeEventPublisher({ publishNativeEvent: (event) => events.push(event.payload) });
  const projection = createDeepseekProjection({ sessionId, directory: '/workspace', publisher });
  let seq = 0;
  const append = (type, data) => projection.apply({ type, data, seq: seq++, time: 1000 + seq * 10 }, { live: true });
  append('request/context', { provider: 'deepseek-official', model: 'model' });
  if (agent === 'plan') append('plan/mode', { active: true });
  append('user/message', { id: 'user-1', source: { kind: 'user', rpcId: userMessageId }, content: [{ type: 'text', text: 'Hello' }] });
  return { projection, append, events };
};
const assistant = (content, extra = {}) => ({ turn: 1, step: 0, message: { id: 'assistant-1', source: { kind: 'model', provider: 'deepseek-official', model: 'model' }, content }, stream: [], ...extra });

describe('DeepSeek history and live projection', () => {
  it('keeps sparse provider block indexes stable through live and history projection', () => {
    const { projection, append } = setup();
    projection.begin({ attemptId: 'sparse', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 7, text: 'Sparse text' }, 1100);
    const partId = projection.records()[1].parts[0].id;
    append('assistant/message', { ...assistant([{ type: 'text', text: 'Sparse text' }]), stream: [
      { type: 'text-chunks', index: 7, time0: 1100, dt: [0], texts: ['Sparse text'] },
      { type: 'chunk', time: 1110, chunk: { type: 'block-end', index: 7, block: { type: 'text', text: 'Sparse text' } } },
    ] });
    expect(projection.records()[1].parts).toHaveLength(1);
    expect(projection.records()[1].parts[0].id).toBe(partId);
  });
  it('keeps tool durations nonnegative when durable events share a timestamp', () => {
    const projection = createDeepseekProjection({ sessionId, directory: '/workspace' });
    projection.apply({ seq: 0, time: 1000, type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run' }] } });
    projection.apply({ seq: 1, time: 1000, type: 'assistant/message', data: assistant([{ type: 'tool-call', id: 'same-time', name: 'bash', arguments: '{}' }]) });
    projection.apply({ seq: 2, time: 1000, type: 'tool/result', data: { turn: 1, step: 0, message: { toolCallId: 'same-time', content: [{ type: 'text', text: 'Done' }] } } });
    const record = projection.records()[1];
    expect(record.parts[0].state.time.end).toBeGreaterThanOrEqual(record.parts[0].state.time.start);
    expect(record.info.time.completed).toBeGreaterThanOrEqual(record.parts[0].state.time.end);
  });
  it('keeps a pending model selection from changing the in-flight request or its context window', () => {
    const { projection, append } = setup();
    append('request/context', { provider: 'deepseek-official', model: 'model', contextWindow: 128000 });
    append('model/selection', { provider: 'other-provider', model: 'next-model' });
    projection.begin({ attemptId: 'active', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 0, text: 'Current response' }, 1200);
    expect(projection.records()[1].info).toMatchObject({ modelID: 'deepseek-official/model', contextWindow: 128000 });
  });
  it('reconciles optimistic ids and keeps live and committed assistant/part identities', () => {
    const { projection, append, events } = setup();
    projection.begin({ attemptId: 'attempt-1', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 0, text: 'Hel' }, 1100);
    projection.chunk({ type: 'text-delta', index: 0, text: 'lo' }, 1110);
    const live = projection.records()[1];
    const id = live.info.id;
    append('assistant/message', assistant([{ type: 'text', text: 'Hello' }]));
    const complete = projection.records()[1];
    expect(complete.info.id).toBe(id);
    expect(projection.records()[0].info.id).toBe(userMessageId);
    expect(complete.parts).toHaveLength(1);
    expect(complete.parts[0].text).toBe('Hello');
    expect(complete.parts[0].time.end).toBeGreaterThanOrEqual(complete.parts[0].time.start);
    expect(events.filter((event) => event.type === 'message.part.delta').map((event) => event.properties.delta)).toEqual(['Hel', 'lo']);
    expect(complete.info.tokens).toBeUndefined();
    expect(complete.info.cost).toBeUndefined();
  });

  it('discards a failed attempt prefix when the same step retries', () => {
    const { projection, append } = setup();
    projection.begin({ attemptId: 'failed', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 0, text: 'Discarded' }, 1100);
    append('assistant/attempt', { turn: 1, step: 0, stream: [] });
    projection.begin({ attemptId: 'retried', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 0, text: 'Kept' }, 1200);
    expect(projection.records()[1].parts[0].text).toBe('Kept');
  });

  it('starts a tool interval when the tool runs, not when its message first streamed', () => {
    const projection = createDeepseekProjection({ sessionId, directory: '/workspace' });
    const live = { live: true };
    projection.apply({ seq: 0, time: 1000, type: 'user/message', data: { id: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run' }] } }, live);
    projection.begin({ attemptId: 'live', turn: 1, step: 0 });
    projection.chunk({ type: 'text-delta', index: 0, text: 'Running it' }, 1100);
    projection.apply({ seq: 1, time: 5000, type: 'assistant/message', data: assistant([
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
    ], { usage: { inputTokens: 10, outputTokens: 100, cacheReadTokens: 0 } }) }, live);
    projection.apply({ seq: 2, time: 5100, type: 'tool/call', data: { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' } }, live);
    projection.apply({ seq: 3, time: 9000, type: 'tool/result', data: { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '/' }] } } }, live);

    const records = projection.records();
    const part = records[1].parts.find((candidate) => candidate.type === 'tool');
    expect(part.state.time).toEqual({ start: 5100, end: 9000 });

    const stats = getLatestCompletedTurnStats(records);
    expect(stats.elapsedDurationMs).toBe(8000);
    expect(stats.totalToolDurationMs).toBe(3900);
    expect(stats.totalLlmDurationMs).toBe(4100);
  });

  it('keeps a replayed tool call from starting after its own result', () => {
    const { projection, append } = setup();
    append('assistant/message', assistant([{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' }]));
    append('tool/result', { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '/' }] } });
    append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' });
    const part = projection.records()[1].parts[0];
    expect(part.state.time.start).toBeLessThanOrEqual(part.state.time.end);
  });

  it('settles tool results and retains disjoint token accounting', () => {
    const { projection, append } = setup();
    append('assistant/message', assistant([{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' }], {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, totalTokens: 45 },
    }));
    append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' });
    append('tool/result', { turn: 1, step: 0, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '/workspace' }] }, meta: { custom: true } });
    const record = projection.records()[1];
    expect(record.parts).toHaveLength(1);
    expect(record.parts[0].state).toMatchObject({ status: 'completed', output: '/workspace', input: { command: 'pwd' }, metadata: { custom: true } });
    expect(record.info.tokens).toMatchObject({ input: 10, output: 5, cache: { read: 30, write: 0 }, total: 45 });
    expect(record.info.time.completed).toBeGreaterThanOrEqual(record.parts[0].state.time.end);
  });

  it('does not infer a Build selection from a completed plan-exit tool', () => {
    const { projection, append } = setup('plan');
    append('assistant/message', assistant([{ type: 'tool-call', id: 'plan-call', name: 'exit_plan_mode', arguments: '{"plan":"Plan"}' }]));
    append('tool/result', { turn: 1, step: 0, message: { toolCallId: 'plan-call', content: [{ type: 'text', text: 'Decision received' }] } });
    expect(projection.records()[1].parts[0].state.status).toBe('completed');
    expect(projection.records()[0].info.agent).toBe('plan');
  });

  it('namespaces a fork-inherited client message independently from its original session', () => {
    const original = setup().projection.records()[0];
    const child = createDeepseekProjection({ sessionId: encodeDeepseekSessionId('fork'), directory: '/workspace' });
    child.apply({ seq: 0, time: 1000, type: 'user/message', data: { id: 'user-1', source: { kind: 'user', rpcId: userMessageId }, content: [{ type: 'text', text: 'Hello' }] } });
    expect(child.records()[0].info.id).not.toBe(original.info.id);
    expect(child.records()[0].parts[0].id).not.toBe(original.parts[0].id);
  });

  it('renders compaction lifecycle and keeps feature instructions out of the transcript', () => {
    const { projection, append } = setup();
    append('user/message', { id: 'user-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'Visible' }, { type: 'text', text: '<openchamber-instructions>Hidden</openchamber-instructions>' }] });
    append('compaction/start', { compactionId: 'compact-1', turn: 2 });
    // The published DSH shape: the checkpoint is content blocks, and the record
    // shows their text rather than the raw model output.
    append('compaction/summary', {
      compactionId: 'compact-1',
      summary: [{ type: 'reasoning', text: 'Checkpoint reasoning' }, { type: 'text', text: '## Checkpoint' }, { type: 'text', text: 'Carry on' }],
      rawOutput: [{ type: 'reasoning', text: '' }, { type: 'text', text: '## Checkpoint' }],
      llmStreamCall: true,
      shadowedRange: { start: 1, end: 14 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 481811,
      provider: 'deepseek-official',
      model: 'model',
      maxTokens: 65536,
      usage: { inputTokens: 546124, outputTokens: 3557, totalTokens: 549681 },
    });
    append('compaction/end', { compactionId: 'compact-1', turn: 2 });
    const records = projection.records();
    expect(records[1].parts.map((part) => part.text)).toEqual(['Visible']);
    expect(records[2].info).toMatchObject({ role: 'compaction', status: 'completed', reason: 'auto', summary: '## Checkpoint\nCarry on' });
  });

  it('keeps a compaction record without text blocks from failing the history read', () => {
    const { projection, append } = setup();
    append('compaction/start', { compactionId: 'compact-2', turn: null });
    append('compaction/summary', { compactionId: 'compact-2', summary: [{ type: 'reasoning', text: 'Only reasoning' }] });
    append('compaction/end', { compactionId: 'compact-2', turn: null });
    expect(projection.records().find((record) => record.info.role === 'compaction')?.info).toMatchObject({ status: 'completed', summary: '' });
  });

  it('restores the compact live stream and stops incomplete tools on interruption', () => {
    const { projection, append } = setup();
    projection.restoreStream({ revision: 3, activeAttempt: { attemptId: 'active', turn: 1, step: 0, stream: [
      { type: 'reasoning-chunks', index: 0, time0: 1100, dt: [0, 10], texts: ['Think', 'ing'] },
    ] } });
    expect(projection.records()[1].parts[0]).toMatchObject({ type: 'reasoning', text: 'Thinking' });
    append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{}' });
    append('turn/end', { turn: 1, reason: { kind: 'aborted' } });
    const record = projection.records()[1];
    expect(record.info.error.name).toBe('MessageAbortedError');
    expect(record.parts.find((part) => part.type === 'tool').state.status).toBe('error');
  });
});
