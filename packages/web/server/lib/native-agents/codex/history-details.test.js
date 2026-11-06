import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexItemTimes, readCodexHistoryDetails } from './history-details.js';
import { codexSkillId } from './items.js';
import { projectCodexTurns } from './projector.js';
import { projectConversationRecord } from '../conversations/history.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const record = (type, payload, timestamp) => ({ type, payload, ...(timestamp ? { timestamp } : {}) });
const counts = (input, cached, output, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output,
  reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const load = async (records, threadId = 'thread') => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-details-'));
  roots.push(root);
  const file = path.join(root, 'rollout.jsonl');
  await fs.writeFile(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return readCodexHistoryDetails(file, threadId);
};

const at = (ms) => new Date(ms).toISOString();
const completedItem = (type, id, start, end) => record('event_msg', {
  type: 'item_completed', turn_id: 'turn', started_at_ms: start, completed_at_ms: end, item: { type, id },
}, at(end));
const projectWaits = (details, items = [
  { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Work' }] },
  { type: 'agentMessage', id: 'reply', text: 'Done' },
]) => projectCodexTurns({
  sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: 'test',
  details, itemTimes: codexItemTimes(details),
  turns: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 20, items }],
}).filter(row => row.info.role === 'assistant').map(row => row.info.metadata?.openchamber?.telemetry?.toolWaitDurationMs);
const waitStart = () => record('event_msg', { type: 'task_started', turn_id: 'turn' }, at(1000));
const waitEnd = () => record('event_msg', { type: 'task_complete', turn_id: 'turn' }, at(20000));
const call = (id, ms, custom = false) => record('response_item', {
  type: custom ? 'custom_tool_call' : 'function_call', name: custom ? 'exec' : 'exec_command', call_id: id,
}, at(ms));
const returned = (id, ms, custom = false) => record('response_item', {
  type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output: custom ? [] : '',
}, at(ms));

describe('Codex supplemental history', () => {
  it('measures the tool call return while its background command keeps running', async () => {
    const details = await load([
      waitStart(), completedItem('UserMessage', 'user', 1000, 1000),
      call('outer', 2000, true), returned('outer', 2100, true),
      completedItem('Reasoning', 'thinking', 3000, 19000),
      completedItem('CommandExecution', 'background', 2050, 20000), waitEnd(),
    ]);
    expect(projectWaits(details)).toEqual([100]);
    expect(details.get('turn').itemTimes.get('background')).toEqual({ start: 2050, end: 20000 });
  });

  it('unions parallel calls and plan confirmation waits without counting duplicate records', async () => {
    const details = await load([
      waitStart(), completedItem('UserMessage', 'user', 1000, 1000),
      call('one', 2000), call('one', 2000), call('two', 3000, true),
      returned('one', 4000), returned('one', 4000), returned('two', 5000, true),
      completedItem('Plan', 'plan', 4500, 6000), waitEnd(),
    ]);
    expect(projectWaits(details)).toEqual([4000]);
  });

  it('partitions waits at steered user and compaction boundaries', async () => {
    const details = await load([
      waitStart(), completedItem('UserMessage', 'user', 1000, 1000),
      completedItem('AgentMessage', 'reply', 1100, 1200), call('across-steer', 2000),
      completedItem('UserMessage', 'steer', 4000, 4000), returned('across-steer', 6000),
      completedItem('AgentMessage', 'reply-2', 6500, 7000),
      completedItem('ContextCompaction', 'compact', 8000, 9000),
      call('after-compact', 10000), returned('after-compact', 11000), waitEnd(),
    ]);
    expect(projectWaits(details, [
      { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Work' }] },
      { type: 'agentMessage', id: 'reply', text: 'One' },
      { type: 'userMessage', id: 'steer', content: [{ type: 'text', text: 'Continue' }] },
      { type: 'agentMessage', id: 'reply-2', text: 'Two' },
      { type: 'contextCompaction', id: 'compact' },
      { type: 'agentMessage', id: 'reply-3', text: 'Three' },
    ])).toEqual([2000, 2000, 1000]);
  });

  it('keeps incomplete or invalid call timing unknown without discarding history', async () => {
    for (const middle of [[call('missing', 2000)], [returned('orphan', 3000)],
      [call('reversed', 4000), returned('reversed', 3000)],
      [record('response_item', { type: 'function_call', call_id: 'untimed' }), returned('untimed', 4000)],
      [record('response_item', { type: 'function_call' }, at(2000))],
      [record('event_msg', { type: 'item_completed', turn_id: 'turn', completed_at_ms: 3000, item: { type: 'Plan', id: 'untimed-plan' } }, at(3000))],
      [call('wrong-kind', 2000), returned('wrong-kind', 3000, true)]]) {
      expect(projectWaits(await load([waitStart(), ...middle, waitEnd()]))).toEqual([null]);
    }
    expect(projectWaits(await load([waitStart(), call('ok', 2000), returned('ok', 2100)]))).toEqual([null]);
    expect(projectWaits(await load([waitStart(), waitEnd()]))).toEqual([0]);
    expect(projectWaits(await load([
      waitStart(), completedItem('CommandExecution', 'missing-call', 2000, 3000), waitEnd(),
    ]))).toEqual([null]);
  });

  it('preserves measured durations through a unified conversation clock shift', async () => {
    const details = await load([waitStart(), call('call', 2000), returned('call', 2100), waitEnd()]);
    const [user, assistant] = projectCodexTurns({ sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: 'test', details,
      turns: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 20, items: [
        { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Work' }] },
        { type: 'agentMessage', id: 'reply', text: 'Done' },
      ] }],
    });
    const segment = { sessionId: 'ncx_thread', sends: [], timeOffset: 123456 };
    const shifted = projectConversationRecord('ncv_test', segment, assistant);
    expect(shifted.info.time.created).toBe(assistant.info.time.created + 123456);
    expect(shifted.info.metadata.openchamber.telemetry.toolWaitDurationMs).toBe(100);
    expect(projectConversationRecord('ncv_test', segment, user).info.role).toBe('user');
  });

  it('recovers real turn totals once when modern and legacy records describe the same request', async () => {
    const usage = counts(2818413, 2803712, 8445, 4493);
    const details = await load([
      record('session_meta', { id: 'thread' }),
      record('event_msg', { type: 'task_started', turn_id: 'turn', model_context_window: 828400 }),
      record('turn_context', { turn_id: 'turn', model: 'old-model', effort: 'high' }),
      record('token_usage_record', { turn_id: 'turn', thread_id: 'thread', usage, thread_token_usage: usage }),
      record('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 828400 } }),
    ]);
    expect(details.get('turn').usage.segments.get('turn')).toMatchObject({
      tokens: { input: 14701, output: 3952, reasoning: 4493, cache: { read: 2803712 } }, contextWindow: 828400,
    });
    expect(details.get('turn').model).toBe('old-model');
    await expect(load([record('session_meta', { id: 'another-thread' })])).rejects.toThrow('identity mismatch');
  });

  it('restores a question with arbitrary selected text from native history', async () => {
    const details = await load([
      record('session_meta', { id: 'thread' }),
      record('event_msg', { type: 'task_started', turn_id: 'turn' }),
      record('event_msg', { type: 'item_completed', turn_id: 'turn', item: { type: 'UserMessage', id: 'user' } }),
      record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] }) }),
      record('retained_context', { type: 'verified_answer', call_id: 'question', turn_id: 'turn', questions: [{ question: 'Which?', answer: 'Custom "answer"\n第二行' }] }),
    ]);
    const records = projectCodexTurns({
      sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: '', details,
      turns: [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Ask' }] }] }],
    });
    const part = records.flatMap((row) => row.parts).find((part) => part.type === 'tool');
    expect(part.tool).toBe('question');
    expect(part.state.metadata.questionAnswers).toEqual([['Custom "answer"\n第二行']]);
    expect(part.state.status).toBe('completed');
  });

  it('recovers item lifecycle times for native and synthesized items', async () => {
    const details = await load([
      record('session_meta', { id: 'thread' }),
      record('event_msg', { type: 'task_started', turn_id: 'turn' }),
      record('event_msg', {
        type: 'item_completed', turn_id: 'turn', started_at_ms: 1100, completed_at_ms: 1100,
        item: {
          type: 'UserMessage', id: 'user',
          content: [
            { type: 'text', text: 'Use the skill' },
            { type: 'skill', name: 'native-skill', path: '/skills/native/SKILL.md' },
          ],
        },
      }),
      record('event_msg', {
        type: 'item_completed', turn_id: 'turn', started_at_ms: 1200, completed_at_ms: 1400,
        item: { type: 'CommandExecution', id: 'exec-1', command: 'ls', status: 'completed' },
      }),
      record('response_item', {
        type: 'function_call', name: 'request_user_input', call_id: 'question',
        arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which?', options: [{ label: 'One' }] }] }),
      }, '1970-01-01T00:00:01.500Z'),
      record('response_item', {
        type: 'function_call_output', call_id: 'question',
        output: JSON.stringify({ answers: { q: { answers: ['One'] } } }),
      }, '1970-01-01T00:00:01.800Z'),
      record('response_item', {
        type: 'message', role: 'user',
        content: [{ text: '<skill><name>extra-skill</name><path>/skills/extra/SKILL.md</path>Use it</skill>' }],
      }, '1970-01-01T00:00:01.900Z'),
      record('event_msg', {
        type: 'item_completed', turn_id: 'turn', started_at_ms: 1500, completed_at_ms: 1900,
        item: { type: 'AgentMessage', id: 'reply', text: 'done' },
      }),
    ]);

    const detail = details.get('turn');
    expect(detail.itemTimes.get('exec-1')).toEqual({ start: 1200, end: 1400 });
    expect(detail.itemTimes.get('question')).toEqual({ start: 1500, end: 1800 });
    expect(detail.itemTimes.get(codexSkillId('turn', 'user', 'native-skill'))).toEqual({ start: 1100, end: 1100 });
    expect(detail.itemTimes.get(codexSkillId('turn', 'user', 'extra-skill'))).toEqual({ start: 1900, end: 1900 });

    const records = projectCodexTurns({
      sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: '',
      itemTimes: codexItemTimes(details), details,
      turns: [{
        id: 'turn', status: 'completed', startedAt: 1, completedAt: 2,
        items: [
          { type: 'userMessage', id: 'user', content: [
            { type: 'text', text: 'Use the skill' },
            { type: 'skill', name: 'native-skill', path: '/skills/native/SKILL.md' },
          ] },
          { type: 'commandExecution', id: 'exec-1', command: 'ls', status: 'completed' },
          { type: 'agentMessage', id: 'reply', text: 'done' },
        ],
      }],
    });
    const assistant = records.find((record) => record.info.role === 'assistant');
    const tools = assistant.parts.filter((part) => part.type === 'tool');
    const byCall = new Map(tools.map((part) => [part.callID, part]));
    expect(byCall.get('exec-1').state.time).toEqual({ start: 1200, end: 1400 });
    expect(byCall.get('question').state.time).toEqual({ start: 1500, end: 1800 });
    expect(byCall.get(codexSkillId('turn', 'user', 'native-skill')).state.time).toEqual({ start: 1100, end: 1100 });
    expect(byCall.get(codexSkillId('turn', 'user', 'extra-skill')).state.time).toEqual({ start: 1900, end: 1900 });
    for (const part of tools) {
      expect(part.state.time.start).toBeGreaterThanOrEqual(assistant.info.time.created);
      expect(part.state.time.end).toBeLessThanOrEqual(assistant.info.time.completed);
    }
  });

  it('shows injected skill evidence but does not mistake pasted skill XML for a loaded skill', async () => {
    const xml = '<skill><name>example</name><path>/skills/example/SKILL.md</path>Instructions</skill>';
    const details = await load([
      record('session_meta', { id: 'thread' }),
      record('event_msg', { type: 'task_started', turn_id: 'turn' }),
      record('event_msg', { type: 'item_completed', turn_id: 'turn', item: { type: 'UserMessage', id: 'user' } }),
      record('response_item', { type: 'message', role: 'user', content: [{ text: xml }] }),
    ]);
    const project = (text) => projectCodexTurns({
      sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: '', details,
      turns: [{ id: 'turn', status: 'completed', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text }] }] }],
    }).flatMap((row) => row.parts).filter((part) => part.type === 'tool' && part.tool === 'skill');
    expect(project('Use the selected skill')).toHaveLength(1);
    expect(project(xml)).toEqual([]);
  });
});
