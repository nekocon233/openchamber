import { describe, expect, it } from 'vitest';
import { createAnthropicStream, readResponsesEvents, toResponsesRequest } from './responses-protocol.js';
import { createClaudeProjection } from './projector.js';

const MODEL = 'gpt-fixture';
const ACCOUNT = 'fixture-account';
const reason = (id) => ({ type: 'reasoning', id, encrypted_content: `encrypted-${id}`, summary: [{ type: 'summary_text', text: 'A short summary.' }], status: 'completed' });
const message = (id, text, phase) => ({ type: 'message', id, phase, content: [{ type: 'output_text', text }] });
const output = () => [
  reason('rs-1'),
  { ...message('m-1', 'Checking.', 'commentary'), content: [{ type: 'output_text', text: 'Checking.' }, { type: 'output_text', text: 'More context.' }] },
  reason('rs-2'),
  { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'Read', namespace: 'claude', arguments: '{"file_path":"/tmp/fixture"}' },
  message('m-2', 'Summary.', 'final_answer'),
];
const eventsFor = (outputs, responseId = 'r') => [
  { type: 'response.created', response: { id: responseId, status: 'in_progress', usage: null } },
  ...outputs.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item },
    { type: 'response.output_item.done', output_index, item },
  ]),
  { type: 'response.completed', response: { id: responseId, status: 'completed', output: outputs, usage: { input_tokens: 100, output_tokens: 10 } } },
];
const record = async (outputs = output(), responseId = 'r') => {
  const chunks = async function* () { yield Buffer.from(eventsFor(outputs, responseId).map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')); };
  const stream = createAnthropicStream({ model: MODEL, accountId: ACCOUNT, names: new Map([['Read', 'Read']]) });
  const frames = [];
  for await (const event of readResponsesEvents(chunks())) frames.push(...stream.push(event));
  return { content: stream.result().content, frames };
};
const replay = (content, accountId = ACCOUNT, model = MODEL) => toResponsesRequest({
  model, messages: [{ role: 'assistant', content }],
  tools: [{ name: 'Read', input_schema: { type: 'object' } }],
}, model, 'max', false, accountId).body.input;
const alterState = (content, change) => {
  const copy = structuredClone(content);
  const carrier = copy.at(-1);
  const prefix = 'openchamber-responses:';
  const state = JSON.parse(Buffer.from(carrier.data.slice(prefix.length), 'base64').toString('utf8'));
  change(state);
  carrier.data = prefix + Buffer.from(JSON.stringify(state)).toString('base64');
  return copy;
};

describe('GPT replay in Claude transcripts', () => {
  it('round-trips multiple reasoning items, message phases and tool order through SSE and JSON history', async () => {
    const { content, frames } = await record();
    expect(content.at(-1).type).toBe('redacted_thinking');
    const restored = replay(JSON.parse(JSON.stringify(content)));
    expect(restored).toEqual([
      reason('rs-1'),
      { type: 'message', role: 'assistant', id: 'm-1', phase: 'commentary', content: output()[1].content },
      reason('rs-2'),
      { type: 'function_call', call_id: 'call-1', namespace: 'claude', name: 'Read', arguments: '{"file_path":"/tmp/fixture"}' },
      { type: 'message', role: 'assistant', id: 'm-2', phase: 'final_answer', content: output()[4].content },
    ]);
    const carrierFrame = frames.findIndex((frame) => frame.type === 'content_block_start' && frame.content_block.type === 'redacted_thinking');
    expect(carrierFrame).toBeGreaterThan(frames.findIndex((frame) => frame.type === 'content_block_start' && frame.content_block.type === 'tool_use'));
    expect(carrierFrame).toBeLessThan(frames.findIndex((frame) => frame.type === 'message_delta'));
    const state = JSON.parse(Buffer.from(content.at(-1).data.split(':')[1], 'base64').toString('utf8'));
    expect(JSON.stringify(state)).not.toContain('Checking.');
    expect(JSON.stringify(state)).not.toContain('/tmp/fixture');
  });

  it('names the upstream response in its carrier, and still replays carriers written without one', async () => {
    const { content } = await record(undefined, 'resp-fixture');
    const state = JSON.parse(Buffer.from(content.at(-1).data.split(':')[1], 'base64').toString('utf8'));
    expect(state.responseId).toBe('resp-fixture');
    const legacy = alterState(content, (value) => { delete value.responseId; });
    expect(replay(legacy)).toEqual(replay(content));
  });

  it('offers the newest replayable response as the cache diagnostic baseline only when asked', async () => {
    const first = await record(undefined, 'resp-first');
    const second = await record([reason('second'), message('m-second', 'Second.', 'final_answer')], 'resp-second');
    const bodyOf = (content, options) => toResponsesRequest({
      model: MODEL, messages: [{ role: 'assistant', content }], tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    }, MODEL, 'max', false, ACCOUNT, options).body;
    const combined = [...first.content, ...second.content];
    expect(bodyOf(combined, { cacheDiagnostics: true }).prompt_cache_options).toEqual({ comparison_response_id: 'resp-second' });
    expect(bodyOf(combined, {})).not.toHaveProperty('prompt_cache_options');
    expect(bodyOf([{ type: 'text', text: 'Compacted history.' }], { cacheDiagnostics: true })).not.toHaveProperty('prompt_cache_options');
  });

  it('preserves phase without reasoning, and does not invent phase when upstream omitted it', async () => {
    const withPhase = await record([message('m', 'Done.', 'final_answer')]);
    expect(replay(withPhase.content)[0].phase).toBe('final_answer');
    const noPhase = await record([message('m', 'Done.', undefined)]);
    expect(noPhase.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(replay(noPhase.content)).toEqual([{ role: 'assistant', content: 'Done.' }]);
    const mixed = await record([reason('r'), message('m', 'Done.', undefined)]);
    expect(replay(mixed.content)[1]).not.toHaveProperty('phase');
  });

  it('keeps distinct phases for identical text and preserves refusal content', async () => {
    const recorded = await record([
      message('progress', 'Same text.', 'commentary'),
      message('answer', 'Same text.', 'final_answer'),
      { type: 'message', id: 'refusal', phase: 'final_answer', content: [{ type: 'refusal', refusal: 'Cannot do that.' }] },
    ]);
    const restored = replay(recorded.content);
    expect(restored.map((item) => item.phase)).toEqual(['commentary', 'final_answer', 'final_answer']);
    expect(restored[2].content).toEqual([{ type: 'refusal', refusal: 'Cannot do that.' }]);
  });

  it('uses completed output as the authority when encrypted state arrives only at completion', () => {
    const outputs = [reason('late'), message('m', 'Done.', 'final_answer')];
    const stream = createAnthropicStream({ model: MODEL, accountId: ACCOUNT, names: new Map() });
    stream.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'late', encrypted_content: null } });
    stream.push({ type: 'response.output_item.done', output_index: 1, item: outputs[1] });
    stream.push(eventsFor(outputs).at(-1));
    expect(replay(stream.result().content)[0]).toEqual(outputs[0]);
  });

  it('uses output indexes when item completions arrive out of order without a final output array', () => {
    const stream = createAnthropicStream({ model: MODEL, accountId: ACCOUNT, names: new Map() });
    const outputs = [reason('r'), message('m', 'Done.', 'final_answer')];
    outputs.forEach((item, output_index) => stream.push({ type: 'response.output_item.added', output_index, item }));
    stream.push({ type: 'response.output_item.done', output_index: 1, item: outputs[1] });
    stream.push({ type: 'response.output_item.done', output_index: 0, item: outputs[0] });
    stream.push({ type: 'response.completed', response: { id: 'r', status: 'completed' } });
    expect(replay(stream.result().content).map((item) => item.type)).toEqual(['reasoning', 'message']);
  });

  it('keeps forked history self-contained and does not resurrect reverted or compacted responses', async () => {
    const first = await record([reason('first'), message('m-first', 'First.', 'final_answer')]);
    const second = await record([reason('second'), message('m-second', 'Second.', 'final_answer')]);
    expect(replay([...first.content, ...second.content]).filter((item) => item.type === 'reasoning').map((item) => item.id)).toEqual(['first', 'second']);
    expect(replay(first.content).filter((item) => item.type === 'reasoning').map((item) => item.id)).toEqual(['first']);
    expect(replay([{ type: 'text', text: 'Compacted history.' }])).toEqual([{ role: 'assistant', content: 'Compacted history.' }]);
    expect(replay([first.content.at(-1)])).toEqual([]);
  });

  it('restores state when the Claude CLI moves its carrier before tool blocks', async () => {
    const { content } = await record();
    const visible = content.slice(0, -1);
    const toolIndex = visible.findIndex((block) => block.type === 'tool_use');
    const reordered = [...visible.slice(0, toolIndex), content.at(-1), ...visible.slice(toolIndex)];
    expect(replay(reordered)).toEqual(replay(content));
  });

  it('restores Responses order when the CLI groups tool blocks after all text', async () => {
    const { content } = await record();
    const normalized = [...content.filter((block) => block.type === 'text'), content.at(-1), ...content.filter((block) => block.type === 'tool_use')];
    expect(replay(normalized)).toEqual(replay(content));
  });

  it('does not attach state to an ambiguous repeated text segment', async () => {
    const { content } = await record([reason('r'), message('m', 'Repeated.', 'final_answer')]);
    expect(replay([content[0], content[0], content.at(-1)])).toEqual([
      { role: 'assistant', content: 'Repeated.' }, { role: 'assistant', content: 'Repeated.' },
    ]);
  });

  it('keeps an edited earlier segment from hiding a later complete response', async () => {
    const first = await record([reason('first'), message('m-first', 'First.', 'final_answer')]);
    const second = await record([reason('second'), message('m-second', 'Second.', 'final_answer')]);
    expect(replay([{ type: 'text', text: 'Edited first.' }, first.content.at(-1), ...second.content])).toEqual([
      { role: 'assistant', content: 'Edited first.' }, reason('second'),
      { type: 'message', role: 'assistant', id: 'm-second', phase: 'final_answer', content: [{ type: 'output_text', text: 'Second.' }] },
    ]);
  });

  it('ignores stale state after edits and does not replay another account or model state', async () => {
    const { content } = await record([reason('r'), message('m', 'Original.', 'final_answer')]);
    for (const [account, model] of [['other-account', MODEL], [ACCOUNT, 'other-model']]) {
      expect(replay(content, account, model)).toEqual([{ role: 'assistant', content: 'Original.' }]);
    }
    const edited = structuredClone(content);
    edited[0].text = 'Edited.';
    expect(replay(edited)).toEqual([{ role: 'assistant', content: 'Edited.' }]);
  });

  it('rejects malformed owned state, unsupported versions and invalid block references', async () => {
    const { content } = await record();
    expect(() => replay([...content.slice(0, -1), { type: 'redacted_thinking', data: 'openchamber-responses:broken' }])).toThrow('Invalid GPT replay state');
    expect(() => replay(alterState(content, (state) => { state.version = 2; }))).toThrow('Unsupported GPT replay state version');
    expect(() => replay(alterState(content, (state) => { state.entries[1].parts[0].blockIndex = 999; }))).toThrow('Invalid GPT replay state');
    expect(() => replay(alterState(content, (state) => { state.entries[0].encrypted_content = ''; }))).toThrow('Invalid GPT replay state');
    expect(replay([{ type: 'redacted_thinking', data: 'foreign-provider-state' }, { type: 'text', text: 'Old reply.' }])).toEqual([{ role: 'assistant', content: 'Old reply.' }]);
  });

  it('does not emit a replay carrier for interrupted or failed output', () => {
    const stream = createAnthropicStream({ model: MODEL, accountId: ACCOUNT, names: new Map() });
    const frames = eventsFor([reason('r'), message('m', 'Partial.', 'commentary')]).slice(0, -1).flatMap((event) => stream.push(event));
    expect(frames.some((frame) => frame.content_block?.type === 'redacted_thinking')).toBe(false);
    expect(() => stream.result()).toThrow('CHATGPT_STREAM_INTERRUPTED');
    expect(() => stream.push({ type: 'response.failed', response: { id: 'r', status: 'failed' } })).toThrow('CHATGPT_INFERENCE_FAILED');
  });

  it('fails explicitly when upstream reasoning cannot be replayed or the state exceeds the frame limit', () => {
    const finish = (state) => {
      const stream = createAnthropicStream({ model: MODEL, accountId: ACCOUNT, names: new Map() });
      for (const event of eventsFor([state, message('m', 'Done.', 'final_answer')])) stream.push(event);
    };
    expect(() => finish({ type: 'reasoning', id: 'missing' })).toThrow('CHATGPT_REASONING_STATE_UNAVAILABLE');
    expect(() => finish({ ...reason('large'), encrypted_content: 'x'.repeat(6 * 1024 * 1024) })).toThrow('GPT replay state exceeds');
  });

  it('keeps opaque state out of live and historical UI records', async () => {
    const { content, frames } = await record([reason('r'), message('m', 'Visible reply.', 'final_answer')]);
    const live = createClaudeProjection({ sessionId: 'ncl_fixture', cwd: '/work', live: true });
    for (const event of frames) live.applyStreamEvent({ type: 'stream_event', event });
    const history = createClaudeProjection({ sessionId: 'ncl_fixture', cwd: '/work' });
    history.applyEntry({ type: 'assistant', uuid: 'fixture-entry', timestamp: '2026-10-16T00:00:00Z', message: { id: frames[0].message.id, model: MODEL, content, stop_reason: 'end_turn' } });
    for (const projection of [live, history]) {
      const records = projection.records();
      expect(JSON.stringify(records)).toContain('Visible reply.');
      expect(JSON.stringify(records)).not.toContain('encrypted-r');
      expect(JSON.stringify(records)).not.toContain('openchamber-responses:');
      expect(records.flatMap((record) => record.parts).filter((part) => part.type === 'reasoning')).toHaveLength(0);
    }
  });
});
