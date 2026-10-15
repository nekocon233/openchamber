import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodexHistoryDetails } from './history-details.js';
import { projectCodexTurns } from './projector.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const record = (type, payload) => ({ type, payload });
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

describe('Codex supplemental history', () => {
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
