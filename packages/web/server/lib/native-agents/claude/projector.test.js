import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createClaudeProjection } from './projector.js';
import { slimToolResult } from './tools.js';
import { compareMessagesChronologically } from '@openchamber/ui/sync/message-ordering';
import { nativePartSchema } from '@openchamber/ui/lib/native-agents/schemas';
import { showsWithFileChangesOnly } from '@openchamber/ui/components/chat/message/parts/toolRenderUtils';
import { getLatestCompletedTurnStats } from '@openchamber/ui/components/chat/work-status/telemetry';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const SESSION_ID = 'ncl_f1033b7a-88c5-4b77-bbec-6d63ec3a1188';
const USER_ID = 'ncl_u_a22f0a7a-a88c-4093-a5e3-6653ff44f6d3';
const TASK_TOOL_USE = 'toolu_01VAnMEDHHeuo92ZtfbaNtwQ';
const CHILD_ID = `${SESSION_ID}_t_${TASK_TOOL_USE}`;

const projectHistory = (entries, options = {}) => {
  const projection = createClaudeProjection({
    sessionId: SESSION_ID,
    cwd: '/work/project',
    childSessionIdForToolUse: (toolUseId) => (toolUseId === TASK_TOOL_USE ? CHILD_ID : null),
    ...options,
  });
  for (const entry of entries) projection.applyEntry(entry);
  projection.settleOpenTools('The turn ended before this tool finished.');
  return projection.records();
};

const toolParts = (records) => records.flatMap((record) => record.parts).filter((part) => part.type === 'tool');

describe('Claude history projection', () => {
  const records = projectHistory(fixture('haiku-tools.session-messages.json'));

  it.each([{}, { plan: 'Fix the parser.' }])('projects an ExitPlanMode call with input %j', (input) => {
    const entries = fixture('haiku-tools.session-messages.json');
    const original = entries.find((entry) => entry.type === 'assistant');
    const result = projectHistory([
      entries[0],
      { ...original, message: { ...original.message, content: [{ type: 'tool_use', id: 'exit-plan', name: 'ExitPlanMode', input }] } },
      { type: 'user', uuid: 'plan-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'exit-plan', content: 'Plan approved.' }] } },
    ]);
    expect(toolParts(result)).toMatchObject([{ tool: 'plan_exit', state: { status: 'completed', input } }]);
  });

  it('starts with the user message OpenChamber sent, keyed by the uuid it chose', () => {
    const [first] = records;
    expect(first.info).toMatchObject({ id: USER_ID, role: 'user', sessionID: SESSION_ID, agent: 'build' });
    expect(first.parts).toHaveLength(1);
    expect(first.parts[0]).toMatchObject({ type: 'text', sessionID: SESSION_ID, messageID: USER_ID });
    expect(first.parts[0].text).toContain('Do these steps in order');
  });

  it('makes one assistant message per API message, each answering the user message', () => {
    const assistants = records.filter((record) => record.info.role === 'assistant');
    expect(assistants.map((record) => record.info.finish)).toEqual(['tool-calls', 'tool-calls', 'tool-calls', 'stop']);
    for (const record of assistants) {
      expect(record.info.parentID).toBe(USER_ID);
      expect(record.info.providerID).toBe('claude-native');
      expect(record.info.modelID).toBe('claude-haiku-4-5');
      expect(record.info.time.completed).toBeGreaterThanOrEqual(record.info.time.created);
      expect(record.info.tokens.total).toBeGreaterThan(0);
    }
    expect(assistants[0].parts.map((part) => part.type)).toEqual(['reasoning', 'text', 'tool', 'tool']);
  });

  it('keeps message creation times in chain order', () => {
    const created = records.map((record) => record.info.time.created);
    expect(created).toEqual([...created].sort((left, right) => left - right));
  });

  it('maps Claude tools onto the OpenCode renderers and finishes them from their results', () => {
    const byTool = new Map(toolParts(records).map((part) => [part.tool, part]));
    expect([...byTool.keys()]).toEqual(['write', 'read', 'edit', 'bash', 'task', 'question']);

    expect(byTool.get('write').state).toMatchObject({
      status: 'completed',
      input: { filePath: '/work/project/hello.txt', content: 'hello' },
    });
    expect(byTool.get('edit').state).toMatchObject({
      status: 'completed',
      input: { filePath: '/work/project/hello.txt', oldString: 'hello', newString: 'hello world' },
    });
    expect(byTool.get('bash').state).toMatchObject({
      status: 'completed',
      input: { command: 'cat /work/project/hello.txt' },
      output: 'hello world',
    });
    expect(byTool.get('task').state.metadata).toEqual({ sessionId: CHILD_ID });
    expect(byTool.get('question').state.output).toMatch(/^User has answered your questions: "Which color do you prefer\?"="blue"\. You can now/);
    expect(byTool.get('question').state.input.questions[0]).toMatchObject({
      question: 'Which color do you prefer?',
      multiple: false,
      options: [{ label: 'red' }, { label: 'blue' }],
    });
  });

  it('completes a message after its last tool result so the step window holds every tool', () => {
    const assistants = new Map(records
      .filter((record) => record.info.role === 'assistant')
      .map((record) => [record.info.id, record]));
    for (const part of toolParts(records)) {
      if (part.state.status !== 'completed' && part.state.status !== 'error') continue;
      expect(assistants.get(part.messageID).info.time.completed).toBeGreaterThanOrEqual(part.state.time.end);
    }

    const stats = getLatestCompletedTurnStats(records);
    expect(stats).not.toBeNull();
    expect(stats.totalLlmDurationMs).not.toBeNull();
    expect(stats.totalToolDurationMs).not.toBeNull();
    expect(stats.tokensPerSecond).not.toBeNull();
  });

  it('emits parts the renderers accept: session ids, finished times', () => {
    for (const record of records) {
      for (const part of record.parts) {
        expect(part.sessionID).toBe(SESSION_ID);
        expect(part.messageID).toBe(record.info.id);
        if (part.type === 'text' || part.type === 'reasoning') expect(part.time.end).toBeGreaterThanOrEqual(part.time.start);
        if (part.type === 'tool') expect(part.state.time.end).toBeGreaterThanOrEqual(part.state.time.start);
      }
    }
  });

  it('uses the model and effort OpenChamber sent when it has a send record', () => {
    const withRecords = projectHistory(fixture('haiku-tools.session-messages.json'), {
      sendRecordFor: (messageId) => (messageId === USER_ID ? { modelID: 'haiku', variant: 'low', agent: 'plan' } : null),
    });
    expect(withRecords[0].info.model).toEqual({ providerID: 'claude-native', modelID: 'haiku', variant: 'low' });
    expect(withRecords[0].info.agent).toBe('plan');
    expect(withRecords[1].info).toMatchObject({ agent: 'plan', variant: 'low' });
  });

  it('stamps the effective context window resolved for the answering model', () => {
    const withRecords = projectHistory(fixture('haiku-tools.session-messages.json'), {
      sendRecordFor: (messageId) => (messageId === USER_ID ? { modelID: 'connection:provider:model', agent: 'build' } : null),
      contextWindowFor: (modelID) => (modelID === 'connection:provider:model' ? 872000 : 0),
    });
    expect(withRecords[1].info.contextWindow).toBe(872000);
    const withoutResolver = projectHistory(fixture('haiku-tools.session-messages.json'));
    expect(withoutResolver[1].info).not.toHaveProperty('contextWindow');
  });

  it('keeps measured usage when a later block of the same API message has none', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'usage-prompt', message: { role: 'user', content: 'Check the parser.' } },
      { type: 'assistant', uuid: 'usage-first', timestamp: '2026-09-24T10:00:00.000Z', message: {
        id: 'msg_usage', model: 'gpt-6.1-sol', stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'Working.' }],
        usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      } },
      { type: 'assistant', uuid: 'usage-second', timestamp: '2026-09-24T10:00:01.000Z', message: {
        id: 'msg_usage', model: 'gpt-6.1-sol', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: '/work/project/a.txt' } }],
      } },
    ]);
    const assistant = records.find((record) => record.info.role === 'assistant');
    expect(assistant.info.tokens).toEqual({ total: 12, input: 6, output: 3, reasoning: 0, cache: { read: 2, write: 1 } });
  });

  it('leaves tokens unknown when the assistant entry carries no usage', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'unknown-prompt', message: { role: 'user', content: 'Check the parser.' } },
      { type: 'assistant', uuid: 'unknown-answer', timestamp: '2026-09-24T10:00:02.000Z', message: {
        id: 'msg_unknown_usage', model: 'gpt-6.1-sol', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
      } },
    ]);
    const assistant = records.find((record) => record.info.role === 'assistant');
    expect(assistant.info).not.toHaveProperty('tokens');
  });
});

describe('Claude placeholder model projection', () => {
  const prompt = {
    type: 'user', uuid: USER_ID.slice('ncl_u_'.length),
    message: { role: 'user', content: 'Check the parser.' },
  };
  const answer = {
    type: 'assistant', uuid: 'answer', message: {
      id: 'msg_answer', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Checking the parser.' }],
    },
  };
  const notice = {
    type: 'assistant', uuid: 'notice', isApiErrorMessage: true, error: 'rate_limit',
    message: {
      id: 'msg_notice', model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your session limit." }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };

  it.each(["You've hit your session limit.", 'Failed to refresh OAuth token: another Claude Code process is refreshing it.'])('keeps the turn model for the placeholder %s', (text) => {
    const records = projectHistory([prompt, answer, {
      ...notice, message: { ...notice.message, content: [{ type: 'text', text }] },
    }], {
      sendRecordFor: () => ({ modelID: 'opus', agent: 'plan' }),
    });
    expect(records.at(-1).info).toMatchObject({ modelID: 'claude-opus-5-5', agent: 'plan', finish: 'stop' });
    expect(records.at(-1).parts).toMatchObject([{ type: 'text', text }]);
    expect(records.at(-1).info.tokens.total).toBe(0);
  });

  it.each(['opus', 'connection:provider:model', 'chatgpt:account:model'])('uses the captured selection %s when the turn has no model response', (modelID) => {
    const records = projectHistory([prompt, notice], {
      sendRecordFor: () => ({ modelID, variant: 'max', agent: 'plan' }),
    });
    expect(records.at(-1).info).toMatchObject({ modelID, variant: 'max', agent: 'plan' });
  });

  it('leaves the model unknown when there is no response or captured selection', () => {
    expect(projectHistory([prompt, notice]).at(-1).info.modelID).toBe('');
  });

  it.each([null, { modelID: 'haiku', agent: 'build' }])('does not borrow a preceding turn model when the new selection is %j', (selection) => {
    const nextPrompt = { ...prompt, uuid: 'next-user' };
    const records = projectHistory([prompt, answer, nextPrompt, notice], {
      sendRecordFor: (id) => id === 'ncl_u_next-user' ? selection : null,
    });
    expect(records.at(-1).info.modelID).toBe(selection?.modelID ?? '');
  });

  it('uses the real model once a reply follows a placeholder', () => {
    const records = projectHistory([prompt, notice, answer], {
      sendRecordFor: () => ({ modelID: 'opus', agent: 'build' }),
    });
    expect(records.at(-1).info.modelID).toBe('claude-opus-5-5');
  });

  it.each(['msg_answer', 'msg_notice'])('preserves a streamed model when a placeholder arrives as %s', (id) => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true });
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Check the parser.' });
    projection.applyStreamEvent({ type: 'stream_event', event: { type: 'message_start', message: answer.message } });
    projection.applyEntry({ ...notice, message: { ...notice.message, id } });
    expect(projection.records().at(-1).info.modelID).toBe('claude-opus-5-5');
    expect(projection.records().at(-1).parts.at(-1)).toMatchObject({ type: 'text', text: "You've hit your session limit." });
  });

  it('uses a steered prompt selection while the preceding reply still streams', () => {
    const projection = createClaudeProjection({
      sessionId: SESSION_ID, cwd: '/work/project', live: true,
      sendRecordFor: (id) => ({ modelID: id === USER_ID ? 'opus' : 'haiku', agent: 'build' }),
    });
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Check the parser.' });
    projection.applyStreamEvent({ type: 'stream_event', event: { type: 'message_start', message: answer.message } });
    projection.startUserPrompt('ncl_u_next-user', { kind: 'text', text: 'Check another file.' });
    projection.applyEntry(notice);
    expect(projection.records().at(-1).info).toMatchObject({ parentID: 'ncl_u_next-user', modelID: 'haiku' });
  });
});

describe('Claude CLI no-response notice', () => {
  const prompt = {
    type: 'user', uuid: 'notice-prompt', timestamp: '2026-01-01T10:00:00.000Z',
    message: { role: 'user', content: 'Fix the parser.' },
  };
  const answer = {
    type: 'assistant', uuid: 'notice-answer', timestamp: '2026-01-01T10:00:10.000Z',
    message: {
      id: 'msg_notice_answer', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_notice', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
  const rejected = {
    type: 'user', uuid: 'notice-rejected', timestamp: '2026-01-01T10:00:20.000Z',
    tool_use_result: 'User rejected tool use',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_notice', is_error: true, content: 'The user does not want to proceed.' }] },
  };
  const stop = {
    type: 'user', uuid: 'notice-stop', timestamp: '2026-01-01T10:00:20.002Z',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  };
  const notice = {
    type: 'assistant', uuid: 'notice-ack', timestamp: '2026-01-02T09:00:00.000Z', isApiErrorMessage: false,
    message: {
      id: 'msg_no_response', model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'No response requested.' }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };

  it('drops the CLI answer to a resumed interrupt so the turn keeps its real window', () => {
    const records = projectHistory([prompt, answer, rejected, stop, notice]);
    expect(records).toHaveLength(2);
    expect(records.flatMap((record) => record.parts)
      .some((part) => part.type === 'text' && part.text === 'No response requested.')).toBe(false);

    const stats = getLatestCompletedTurnStats(records);
    expect(stats).not.toBeNull();
    expect(stats.elapsedDurationMs).toBe(20_000);
    expect(stats.totalToolDurationMs).toBe(10_000);
    expect(stats.totalLlmDurationMs).toBe(10_000);
    expect(stats.tokensPerSecond).toBe(10);
  });

  it('keeps an API error notice the user has to see', () => {
    const text = "Failed to authenticate. API Error: 403 You've reached your 5-hour usage limit";
    const records = projectHistory([prompt, {
      ...notice, uuid: 'notice-error', isApiErrorMessage: true,
      message: { ...notice.message, id: 'msg_api_error', content: [{ type: 'text', text }] },
    }]);
    expect(records).toHaveLength(2);
    expect(records.at(-1).parts).toMatchObject([{ type: 'text', text }]);
  });
});

describe('Claude live usage projection', () => {
  const liveProjection = () => createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true });
  const start = (projection) => projection.applyStreamEvent({ type: 'stream_event', event: {
    type: 'message_start',
    message: {
      id: 'msg_live_usage', model: 'gpt-6.1-sol', content: [],
      usage: { input_tokens: 6, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    },
  } });

  it('merges final input and cache usage from message_delta', () => {
    const projection = liveProjection();
    start(projection);
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
    } });
    expect(projection.records().find((record) => record.info.role === 'assistant').info.tokens).toEqual({ total: 13, input: 4, output: 3, reasoning: 0, cache: { read: 4, write: 2 } });
  });

  it('preserves earlier input and cache usage for an output-only delta', () => {
    const projection = liveProjection();
    start(projection);
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 },
    } });
    expect(projection.records().find((record) => record.info.role === 'assistant').info.tokens).toEqual({ total: 12, input: 6, output: 3, reasoning: 0, cache: { read: 2, write: 1 } });
  });

  it('preserves accumulated cache usage when a complete live frame omits it', () => {
    const projection = liveProjection();
    start(projection);
    projection.applyEntry({
      type: 'assistant', uuid: 'live-usage-frame', message: {
        id: 'msg_live_usage', model: 'gpt-6.1-sol', content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 4, output_tokens: 3 },
      },
    });
    expect(projection.records().find((record) => record.info.role === 'assistant').info.tokens).toEqual({ total: 10, input: 4, output: 3, reasoning: 0, cache: { read: 2, write: 1 } });
  });

  it('keeps usage unmeasured while a proxy stream omits cache fields', () => {
    const projection = liveProjection();
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Check the parser.' });
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_start',
      message: { id: 'msg_proxy', model: 'gpt-6.1-sol', content: [], usage: { input_tokens: 6, output_tokens: 0 } },
    } });
    const assistant = () => projection.records().find((record) => record.info.role === 'assistant');
    expect(assistant().info).not.toHaveProperty('tokens');
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 },
    } });
    expect(assistant().info).not.toHaveProperty('tokens');
    expect(projection.applyResult({
      usage: { iterations: [{ input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }] },
      modelUsage: { 'gpt-6.1-sol': { contextWindow: 872000, maxOutputTokens: 128000 } },
    })).toEqual([assistant().info.id]);
    expect(assistant().info.tokens).toEqual({ total: 12, input: 6, output: 3, reasoning: 0, cache: { read: 2, write: 1 } });
    expect(assistant().info.contextWindow).toBe(872000);
  });

  it('merges cache fields that arrive in a later delta', () => {
    const projection = liveProjection();
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_start',
      message: { id: 'msg_delayed_cache', model: 'gpt-6.1-sol', content: [], usage: { input_tokens: 6, output_tokens: 0 } },
    } });
    projection.applyStreamEvent({ type: 'stream_event', event: {
      type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
    } });
    expect(projection.records().find((record) => record.info.role === 'assistant').info.tokens).toEqual({ total: 15, input: 6, output: 3, reasoning: 0, cache: { read: 4, write: 2 } });
  });

  it('does not write usage from a complete live frame that omits cache fields', () => {
    const projection = liveProjection();
    projection.applyEntry({
      type: 'assistant', uuid: 'live-assistant', message: {
        id: 'msg_live_frame', model: 'gpt-6.1-sol', content: [{ type: 'text', text: 'Working.' }],
        usage: { input_tokens: 6, output_tokens: 3 },
      },
    });
    expect(projection.records().find((record) => record.info.role === 'assistant').info).not.toHaveProperty('tokens');
  });

  it('applies a single result iteration only to the final assistant message', () => {
    const projection = liveProjection();
    for (const id of ['msg_first', 'msg_final']) {
      projection.applyStreamEvent({ type: 'stream_event', event: {
        type: 'message_start',
        message: { id, model: 'gpt-6.1-sol', content: [], usage: { input_tokens: 6, output_tokens: 0 } },
      } });
    }
    const assistants = projection.records().filter((record) => record.info.role === 'assistant');
    projection.applyResult({
      usage: { iterations: [{ input_tokens: 8, output_tokens: 225, cache_read_input_tokens: 17989, cache_creation_input_tokens: 873 }] },
      modelUsage: { 'gpt-6.1-sol': { contextWindow: 872000 } },
    });
    expect(assistants[0].info).not.toHaveProperty('tokens');
    expect(assistants[1].info.tokens).toEqual({ total: 19095, input: 8, output: 225, reasoning: 0, cache: { read: 17989, write: 873 } });
    expect(assistants.map((record) => record.info.contextWindow)).toEqual([872000, 872000]);
  });

  it('maps result iterations positionally only when their count matches the turn', () => {
    const projection = liveProjection();
    for (const id of ['msg_one', 'msg_two']) {
      projection.applyStreamEvent({ type: 'stream_event', event: {
        type: 'message_start',
        message: { id, model: 'gpt-6.1-sol', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
      } });
    }
    const assistants = projection.records().filter((record) => record.info.role === 'assistant');
    projection.applyResult({ usage: { iterations: [
      { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 },
      { input_tokens: 6, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 9 },
    ] } });
    expect(assistants.map((record) => record.info.tokens)).toEqual([
      { total: 14, input: 2, output: 3, reasoning: 0, cache: { read: 4, write: 5 } },
      { total: 30, input: 6, output: 7, reasoning: 0, cache: { read: 8, write: 9 } },
    ]);
  });

  it('matches result modelUsage entries to each assistant model before stamping windows', () => {
    const projection = liveProjection();
    for (const [id, model] of [['msg_haiku', 'claude-haiku-4-5-20251001'], ['msg_sonnet', 'claude-sonnet-4-5-20250929']]) {
      projection.applyStreamEvent({ type: 'stream_event', event: {
        type: 'message_start',
        message: { id, model, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
      } });
    }
    const assistants = projection.records().filter((record) => record.info.role === 'assistant');
    projection.applyResult({ modelUsage: {
      'claude-haiku-4-5-20251001': { contextWindow: 200000, canonicalModel: 'claude-haiku-4-5' },
      'claude-sonnet-4-5-20250929': { contextWindow: 1000000, canonicalModel: 'claude-sonnet-4-5' },
    } });
    expect(assistants.map((record) => record.info.contextWindow)).toEqual([200000, 1000000]);
  });
});

describe('Claude compaction projection', () => {
  const at = (seconds) => new Date(Date.UTC(2026, 8, 16, 20, 0, seconds)).toISOString();
  // A system entry as the SDK's history read returns it: the type, nothing of its kind.
  const systemEntry = (uuid, seconds) => ({ type: 'system', uuid, timestamp: at(seconds), message: undefined, parent_tool_use_id: null, parent_agent_id: null });
  const entries = [
    systemEntry('boundary-1', 30),
    {
      type: 'user',
      uuid: 'summary-1',
      timestamp: at(29),
      isCompactSummary: true,
      is_meta: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
    },
    {
      type: 'assistant',
      uuid: 'preserved-1',
      timestamp: at(10),
      message: { id: 'msg_preserved', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' },
    },
  ];
  const records = projectHistory(entries);

  it('shows the boundary as a compaction turn answered by the summary', () => {
    const [boundary, summary, preserved] = records;
    expect(boundary.info).toMatchObject({ id: 'ncl_k_boundary-1', role: 'compaction', status: 'completed' });
    // The history read does not say what started it, so the marker makes no claim.
    expect(boundary.parts).toEqual([expect.objectContaining({ type: 'compaction', auto: false })]);
    expect(summary.info).toMatchObject({ role: 'assistant', summary: true, finish: 'stop', parentID: 'ncl_k_boundary-1' });
    expect(summary.info.tokens.total).toBe(0);
    expect(summary.parts[0].text).toContain('continued from a previous conversation');
    expect(preserved.info.parentID).toBe('ncl_k_boundary-1');
  });

  it('keeps preserved messages after the boundary even though their timestamps are older', () => {
    const timeline = [...records].sort((left, right) => compareMessagesChronologically(left.info, right.info));
    expect(timeline.map((record) => record.info.id)).toEqual(records.map((record) => record.info.id));
  });

  it('keeps a reply and the next prompt after the compaction when their timestamps tie', () => {
    const projected = projectHistory([
      ...entries,
      { type: 'user', uuid: 'next-prompt', timestamp: at(30), message: { role: 'user', content: 'Continue' } },
      { type: 'assistant', uuid: 'next-answer', timestamp: at(30), message: {
        id: 'msg_next', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Next answer' }], stop_reason: 'end_turn',
      } },
    ]);
    const timeline = [...projected].sort((left, right) => compareMessagesChronologically(left.info, right.info));
    expect(timeline.map((record) => record.info.id)).toEqual(projected.map((record) => record.info.id));
    for (const record of timeline) {
      if (record.info.role === 'assistant') {
        expect(record.info.time.completed).toBeGreaterThanOrEqual(record.info.time.created);
      }
    }
  });

  it.each(['message_stop', 'result'])('keeps the live reply after its compaction when %s arrives in the same millisecond', (ending) => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true, now: () => Date.parse(at(30)) });
    projection.applyEntry({ type: 'system', subtype: 'compact_boundary', uuid: 'live-boundary', timestamp: at(30), compact_metadata: { trigger: 'auto' } });
    projection.applyStreamEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_live', model: 'claude-opus-5-5', content: [] } } });
    if (ending === 'message_stop') projection.applyStreamEvent({ type: 'stream_event', event: { type: 'message_stop' } });
    else projection.finishTurn({ error: null });
    const [boundary, reply] = projection.records();
    expect(compareMessagesChronologically(boundary.info, reply.info)).toBeLessThan(0);
    expect(reply.info.time.completed).toBeGreaterThanOrEqual(reply.info.time.created);
  });

  it('keeps an immediate failure after the prompt with a valid completion time', () => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true, now: () => Date.parse(at(30)) });
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Continue' });
    projection.finishTurn({ error: { name: 'UnknownError', data: { message: 'CLI failed' } } });
    const [prompt, failure] = projection.records();
    expect(compareMessagesChronologically(prompt.info, failure.info)).toBeLessThan(0);
    expect(failure.info.time.completed).toBeGreaterThanOrEqual(failure.info.time.created);
    expect(failure.info.tokens.total).toBe(0);
  });

  it('shows nothing for the other system entries a history read returns', () => {
    const prompt = (uuid, seconds, text) => ({ type: 'user', uuid, timestamp: at(seconds), message: { role: 'user', content: text } });
    const projected = projectHistory([
      prompt('5f0a4d1e-2b8c-4c1a-9e6f-0d2b3c4a5e61', 1, 'first'),
      {
        type: 'assistant',
        uuid: 'answer-1',
        timestamp: at(2),
        message: { id: 'msg_answer', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      },
      // A turn duration, an away summary, and the two entries of a local command.
      systemEntry('turn-duration', 3),
      systemEntry('away-summary', 4),
      systemEntry('local-command-1', 5),
      systemEntry('local-command-2', 5),
      prompt('7c9e2f3a-4b5d-4e6f-8a1b-2c3d4e5f6a7b', 6, 'second'),
      systemEntry('notice', 7),
    ]);
    expect(projected.flatMap((record) => record.parts).filter((part) => part.type === 'compaction')).toEqual([]);
    expect(projected.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('tells a /compact the user asked for from one the CLI made to free the context when the entry names its trigger', () => {
    const manual = projectHistory([{ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-2', timestamp: at(40), compact_metadata: { trigger: 'manual', pre_tokens: 9000 } }]);
    const auto = projectHistory([{ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-3', timestamp: at(40), compactMetadata: { trigger: 'auto', preTokens: 190000 } }]);
    const other = projectHistory([{ type: 'system', subtype: 'turn_duration', uuid: 'duration-1', timestamp: at(40) }]);
    expect(manual[0].parts).toEqual([expect.objectContaining({ type: 'compaction', auto: false })]);
    expect(auto[0].parts).toEqual([expect.objectContaining({ type: 'compaction', auto: true })]);
    expect(other).toEqual([]);
  });
});

describe('Claude tools the renderers do not know', () => {
  const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

  it('keeps the tool name as the CLI wrote it and titles the call with what its input is about', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:00.000Z', message: { role: 'user', content: 'Plan it' } },
      {
        type: 'assistant',
        uuid: 'a-1',
        timestamp: '2026-09-24T10:00:01.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-haiku-4-5',
          content: [
            toolUse('toolu_task', 'TaskCreate', { subject: 'alpha', description: 'First task\nwith detail' }),
            toolUse('toolu_mcp', 'mcp__github__create_issue', { title: 'Broken link', body: 'The docs link 404s.' }),
            toolUse('toolu_bare', 'TaskList', {}),
          ],
        },
      },
      {
        type: 'user',
        uuid: 'r-1',
        timestamp: '2026-09-24T10:00:02.000Z',
        message: {
          role: 'user',
          content: ['toolu_task', 'toolu_mcp', 'toolu_bare'].map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
        },
      },
    ]);
    expect(toolParts(records).map((part) => [part.tool, part.state.title])).toEqual([
      ['TaskCreate', 'alpha'],
      ['github_create_issue', 'Broken link'],
      ['TaskList', ''],
    ]);
  });
});

describe.each([['history', false], ['live', true]])('Claude MCP %s projection', (_mode, live) => {
  const prompt = {
    type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-10-13T10:00:00.000Z',
    message: { role: 'user', content: 'Search the docs' },
  };
  const call = {
    type: 'assistant', uuid: 'mcp-call', timestamp: '2026-10-13T10:00:01.000Z',
    message: {
      id: 'msg_mcp', model: 'claude-haiku-4-5', stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__docs__search', input: { query: 'parser' } },
        { type: 'tool_use', id: 'toolu_ordinary', name: 'docs_search', input: { query: 'parser' } },
      ],
    },
  };
  const start = () => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live, now: () => Date.parse('2026-10-13T10:00:03.000Z') });
    if (live) projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Search the docs' });
    else projection.applyEntry(prompt);
    projection.applyEntry(call);
    return projection;
  };
  const assertSources = (projection, status) => {
    const parts = toolParts(projection.records());
    expect(parts).toHaveLength(2);
    const [mcp, ordinary] = parts;
    expect(mcp).toMatchObject({
      tool: 'docs_search', state: { status, input: { query: 'parser' }, metadata: { openchamberToolSource: 'mcp' } },
    });
    expect(ordinary).toMatchObject({ tool: 'docs_search', state: { status, metadata: {} } });
    // Exercise the UI's native boundary as well as the transcript filter.
    expect(showsWithFileChangesOnly(nativePartSchema.parse(mcp))).toBe(true);
    expect(showsWithFileChangesOnly(nativePartSchema.parse(ordinary))).toBe(false);
    return parts;
  };

  it.each([false, true])('keeps source through running and result settlement, is_error=%s', (isError) => {
    const projection = start();
    const running = assertSources(projection, 'running');
    projection.applyEntry({
      type: 'user', uuid: 'mcp-result', timestamp: '2026-10-13T10:00:02.000Z',
      message: { role: 'user', content: ['toolu_mcp', 'toolu_ordinary'].map((id) => ({
        type: 'tool_result', tool_use_id: id, is_error: isError, content: 'Search result',
      })) },
    });
    const settled = assertSources(projection, isError ? 'error' : 'completed');
    expect(settled.map((part) => part.id)).toEqual(running.map((part) => part.id));
    for (const part of settled) {
      expect(isError ? part.state.error : part.state.output).toBe('Search result');
    }
  });

  it('keeps source when an unfinished call is settled without a result', () => {
    const projection = start();
    if (live) projection.finishTurn({ error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    else projection.settleOpenTools('Interrupted');
    for (const part of assertSources(projection, 'error')) {
      expect(part.state.error).toBe('Interrupted');
    }
  });
});

describe('Claude commands that changed files', () => {
  const record = {
    files: [{ filePath: '/work/project/src/a.cs', hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }] }],
    moreFiles: 1,
    changedFiles: ['/work/project/src/a.cs', '/work/project/src/Big.cs'],
  };
  const prompt = { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-29T04:12:00.000Z', message: { role: 'user', content: 'Rewrite the parser' } };
  const call = { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-29T04:12:28.000Z', message: {
    id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_cmd', name: 'Bash', input: { command: 'python3 edit.py', description: 'Rewrite the parser' } }],
  } };
  const result = (toolUseResult) => ({
    type: 'user', uuid: 'r-1', timestamp: '2026-09-29T04:12:30.000Z', tool_use_result: toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_cmd', content: 'done' }] },
  });

  it('shows the same changes on the live call as a later history read, which keeps only the record', () => {
    const full = { stdout: 'done', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, bashEditDiff: record };
    const live = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true, now: () => Date.parse('2026-09-29T04:12:31.000Z') });
    live.startUserPrompt(USER_ID, { kind: 'text', text: 'Rewrite the parser' });
    live.applyEntry(call);
    live.applyEntry(result(full));
    const history = projectHistory([prompt, call, result(slimToolResult(full))]);

    const [liveCommand] = toolParts(live.records());
    const [historyCommand] = toolParts(history);
    expect(liveCommand).toMatchObject({ tool: 'bash', state: { status: 'completed', output: 'done' } });
    expect(liveCommand.state.metadata.recordedFileChanges).toEqual({ withoutDiff: ['/work/project/src/Big.cs'], unnamed: 0 });
    expect(historyCommand.state.metadata).toEqual(liveCommand.state.metadata);
  });
});

describe('Claude background subagents', () => {
  it('leaves out the notice the CLI sends the model when a background subagent finishes', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'Survey the project' } },
      { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-24T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'Started a subagent.' }], stop_reason: 'end_turn' } },
      { type: 'user', uuid: 'n-1', timestamp: '2026-09-24T10:00:05.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>a4065</task-id>\n</task-notification>' } },
      { type: 'assistant', uuid: 'a-2', timestamp: '2026-09-24T10:00:06.000Z', message: { id: 'msg_2', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'The subagent found three files.' }], stop_reason: 'end_turn' } },
    ]);
    expect(records.map((record) => [record.info.role, record.parts.map((part) => part.text).join('')])).toEqual([
      ['user', 'Survey the project'],
      ['assistant', 'Started a subagent.'],
      ['assistant', 'The subagent found three files.'],
    ]);
  });
});

describe('Claude feature instructions', () => {
  it("leaves a feature's instructions out of the user message, keeping the user's part ids", () => {
    const records = projectHistory([
      {
        type: 'user',
        uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3',
        timestamp: '2026-09-24T10:00:00.000Z',
        message: { role: 'user', content: [
          { type: 'text', text: 'what is this file?' },
          { type: 'text', text: '<openchamber-instructions>\nAnswer the side question only.\n</openchamber-instructions>' },
        ] },
      },
    ]);
    expect(records.map((record) => record.parts.map((part) => [part.id, part.text]))).toEqual([
      [[`${USER_ID}_p0`, 'what is this file?']],
    ]);
  });
});

describe('Claude stops', () => {
  const userEntry = (uuid, content, timestamp) => ({ type: 'user', uuid, timestamp, message: { role: 'user', content } });
  const toolUse = { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-24T10:00:01.000Z', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 30' } }] } };

  it('leaves the CLI stop marker out of the conversation', () => {
    const records = projectHistory([
      userEntry('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', 'Run sleep', '2026-09-24T10:00:00.000Z'),
      toolUse,
      userEntry('b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', [{ type: 'text', text: '[Request interrupted by user for tool use]' }], '2026-09-24T10:00:02.000Z'),
      userEntry('c44f0a7a-a88c-4093-a5e3-6653ff44f6d3', '[Request interrupted by user]', '2026-09-24T10:00:03.000Z'),
    ]);
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
  });

  it('marks a stopped turn the way the UI marks one it settles itself', () => {
    const projection = createClaudeProjection({ sessionId: SESSION_ID, cwd: '/work/project', live: true, now: () => 5 });
    projection.startUserPrompt(USER_ID, { kind: 'text', text: 'Run sleep' });
    projection.applyEntry(toolUse);
    const changed = projection.finishTurn({ error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    const assistant = projection.record(changed.at(-1));
    expect(assistant.info.error).toEqual({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    expect(assistant.parts[0].state).toMatchObject({ status: 'error', error: 'Interrupted' });
  });
});

describe('Claude slash commands', () => {
  const command = (uuid, name, args = '') => ({
    type: 'user',
    uuid,
    timestamp: '2026-09-24T10:00:00.000Z',
    isCompletedLocalCommand: true,
    message: { role: 'user', content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>` },
  });
  const output = (uuid, text) => ({
    type: 'user',
    uuid,
    timestamp: '2026-09-24T10:00:01.000Z',
    isCompletedLocalCommand: true,
    message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
  });

  it('shows a command as the user typed it under the prompt it came with, and leaves its output out', () => {
    const records = projectHistory([
      command('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/cost'),
      output('out-1', 'Total cost: $0.01'),
      command('b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/review-code', 'src/app.ts'),
    ]);
    expect(records.map((record) => [record.info.id, record.parts.map((part) => part.text)])).toEqual([
      [USER_ID, ['/cost']],
      ['ncl_u_b33f0a7a-a88c-4093-a5e3-6653ff44f6d3', ['/review-code src/app.ts']],
    ]);
  });

  it('leaves out a command the CLI ran on its own, like the /model a model switch records', () => {
    const records = projectHistory([
      { type: 'user', uuid: 'caveat-1', timestamp: '2026-09-24T10:00:00.000Z', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>' } },
      { ...command('model-1', '/model', 'haiku'), isCompletedLocalCommand: undefined },
      { ...output('out-1', 'Set model to haiku'), isCompletedLocalCommand: undefined },
      { type: 'user', uuid: 'a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', timestamp: '2026-09-24T10:00:02.000Z', message: { role: 'user', content: 'Reply with one word.' } },
    ]);
    expect(records.map((record) => [record.info.id, record.parts.map((part) => part.text)])).toEqual([
      [USER_ID, ['Reply with one word.']],
    ]);
  });

  it('shows /compact only as its compaction', () => {
    const records = projectHistory([
      { type: 'system', uuid: 'boundary-1', timestamp: '2026-09-24T10:00:02.000Z' },
      {
        type: 'user',
        uuid: 'summary-1',
        timestamp: '2026-09-24T10:00:02.000Z',
        isCompactSummary: true,
        is_meta: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      },
      command('a22f0a7a-a88c-4093-a5e3-6653ff44f6d3', '/compact'),
      output('out-1', 'Compacted '),
    ]);
    expect(records.map((record) => record.info.id)).toEqual(['ncl_k_boundary-1', 'ncl_k_boundary-1_summary']);
  });
});
